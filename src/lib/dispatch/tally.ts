// Export app-made GST invoices for Tally: an Excel voucher register and a TallyPrime
// "Import Data" XML of Sales vouchers (accounting mode: party, Sales, GST output and Round Off ledgers).
import ExcelJS from 'exceljs';
import type { Billing } from '../billing';
import type { Invoice } from '../domain';
import { partyState, r2, roundOffOf, stateLabel, xmlEscape, GST_STATES } from '../gst';
import { newWorkbook, toBuffer } from '../excel';

export type ExportInvoice = Invoice & { party_gstin: string | null; party_state: string | null; challan_no: string | null };

const HEAD_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9E4D8' } };

export async function tallyXlsx(b: Billing, invoices: ExportInvoice[]): Promise<Buffer> {
  const wb = newWorkbook(b.legalName);
  const ws = wb.addWorksheet('Sales vouchers');
  const money = { numFmt: '#,##0.00' };
  ws.columns = [
    { header: 'Voucher Date', key: 'date', width: 13, style: { numFmt: 'dd-mm-yyyy' } },
    { header: 'Voucher No', key: 'no', width: 20 },
    { header: 'Party', key: 'party', width: 28 },
    { header: 'Party GSTIN', key: 'gstin', width: 18 },
    { header: 'Place of supply', key: 'pos', width: 20 },
    { header: 'HSN', key: 'hsn', width: 9 },
    { header: 'Qty (m)', key: 'qty', width: 11, style: money },
    { header: 'Rate', key: 'rate', width: 10, style: money },
    { header: 'Taxable', key: 'taxable', width: 13, style: money },
    { header: 'CGST', key: 'cgst', width: 11, style: money },
    { header: 'SGST', key: 'sgst', width: 11, style: money },
    { header: 'IGST', key: 'igst', width: 11, style: money },
    { header: 'Round off', key: 'ro', width: 10, style: money },
    { header: 'Total', key: 'total', width: 13, style: money },
  ];
  // One row per invoice line; tax, round off and total only on each invoice's first row so columns add up.
  for (const inv of invoices) {
    const pos = stateLabel(partyState({ state_code: inv.party_state, gstin: inv.party_gstin }) ?? b.stateCode);
    const lines = inv.lines.length ? inv.lines : [{ lot_id: '', quality: '', hsn: b.hsnCode, meters: 0, rate: 0, amount: inv.taxable_amount }];
    lines.forEach((l, i) => {
      ws.addRow({
        date: new Date(`${inv.invoice_date}T00:00:00Z`), no: inv.invoice_no, party: inv.party_name, gstin: inv.party_gstin ?? '', pos,
        hsn: l.hsn, qty: l.meters || null, rate: l.rate || null, taxable: l.amount,
        cgst: i === 0 ? inv.cgst : null, sgst: i === 0 ? inv.sgst : null, igst: i === 0 ? inv.igst : null,
        ro: i === 0 ? roundOffOf(inv) : null, total: i === 0 ? inv.total : null,
      });
    });
  }
  const sum = (k: 'taxable_amount' | 'cgst' | 'sgst' | 'igst' | 'total') => r2(invoices.reduce((s, i) => s + i[k], 0));
  const t = ws.addRow({
    no: `${invoices.length} invoice${invoices.length === 1 ? '' : 's'}`, party: 'Total',
    qty: r2(invoices.reduce((s, i) => s + i.lines.reduce((a, l) => a + l.meters, 0), 0)),
    taxable: sum('taxable_amount'), cgst: sum('cgst'), sgst: sum('sgst'), igst: sum('igst'),
    ro: r2(invoices.reduce((s, i) => s + roundOffOf(i), 0)), total: sum('total'),
  });
  t.font = { bold: true };
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.fill = HEAD_FILL;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: 'A1', to: 'N1' };
  return toBuffer(wb);
}

const amt = (n: number) => r2(n).toFixed(2);
const ymd = (iso: string) => iso.replace(/-/g, '');

function ledgerEntry(name: string, amount: number): string {
  // Tally: debit = negative amount with ISDEEMEDPOSITIVE Yes; credit = positive with No.
  const debit = amount < 0;
  return `      <ALLLEDGERENTRIES.LIST>
       <LEDGERNAME>${xmlEscape(name)}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
       <AMOUNT>${amt(amount)}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>`;
}

/**
 * TallyPrime import XML (Import Data → Vouchers) into the company open in Tally. Ledgers "Sales",
 * "CGST Output", "SGST Output", "IGST Output", "Round Off" and each party must exist with these names.
 */
export function tallyXml(b: Billing, invoices: ExportInvoice[]): string {
  const vouchers = invoices.map((inv) => {
    const st = partyState({ state_code: inv.party_state, gstin: inv.party_gstin }) ?? b.stateCode;
    const stName = st ? GST_STATES[st] ?? st : '';
    const ro = roundOffOf(inv);
    const meters = r2(inv.lines.reduce((s, l) => s + l.meters, 0));
    const narration = [`Challan ${inv.challan_no ?? '-'}`, meters ? `${meters} m` : '', inv.lines.map((l) => `${l.quality} lot ${l.lot_id}`).join(', ')].filter(Boolean).join(' · ');
    const entries = [
      ledgerEntry(inv.party_name, -inv.total),
      ledgerEntry('Sales', inv.taxable_amount),
      ...(inv.cgst ? [ledgerEntry('CGST Output', inv.cgst)] : []),
      ...(inv.sgst ? [ledgerEntry('SGST Output', inv.sgst)] : []),
      ...(inv.igst ? [ledgerEntry('IGST Output', inv.igst)] : []),
      ...(Math.abs(ro) >= 0.005 ? [ledgerEntry('Round Off', ro)] : []),
    ];
    return `   <TALLYMESSAGE xmlns:UDF="TallyUDF">
    <VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Accounting Voucher View">
     <DATE>${ymd(inv.invoice_date)}</DATE>
     <EFFECTIVEDATE>${ymd(inv.invoice_date)}</EFFECTIVEDATE>
     <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
     <VOUCHERNUMBER>${xmlEscape(inv.invoice_no)}</VOUCHERNUMBER>
     <REFERENCE>${xmlEscape(inv.challan_no ?? '')}</REFERENCE>
     <PARTYLEDGERNAME>${xmlEscape(inv.party_name)}</PARTYLEDGERNAME>
     <PARTYNAME>${xmlEscape(inv.party_name)}</PARTYNAME>
     <PARTYGSTIN>${xmlEscape(inv.party_gstin ?? '')}</PARTYGSTIN>
     <STATENAME>${xmlEscape(stName)}</STATENAME>
     <PLACEOFSUPPLY>${xmlEscape(stName)}</PLACEOFSUPPLY>
     <NARRATION>${xmlEscape(narration)}</NARRATION>
     <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>
     <ISINVOICE>No</ISINVOICE>
${entries.join('\n')}
    </VOUCHER>
   </TALLYMESSAGE>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
 <HEADER>
  <TALLYREQUEST>Import Data</TALLYREQUEST>
 </HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>Vouchers</REPORTNAME>
   </REQUESTDESC>
   <REQUESTDATA>
${vouchers.join('\n')}
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>
`;
}
