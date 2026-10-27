// Export app-made GST invoices for Tally: an Excel voucher register and a TallyPrime
// "Import Data" XML of Sales vouchers (accounting mode: party, Sales, GST output and Round Off ledgers).
import ExcelJS from 'exceljs';
import type { Writable } from 'node:stream';
import { once } from 'node:events';
import type { Billing } from '../billing';
import type { Invoice } from '../domain';
import type { Q } from '../db';
import { partyState, r2, roundOffOf, stateLabel, xmlEscape, GST_STATES } from '../gst';
import { newWorkbook, toBuffer } from '../excel';
import { toInvoice } from './invoices';

export type ExportInvoice = Invoice & { party_gstin: string | null; party_state: string | null; challan_no: string | null };

const HEAD_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9E4D8' } };
const TALLY_COLUMNS = [
  { header: 'Voucher Date', key: 'date', width: 13, style: { numFmt: 'dd-mm-yyyy' } },
  { header: 'Voucher No', key: 'no', width: 20 },
  { header: 'Party', key: 'party', width: 28 },
  { header: 'Party GSTIN', key: 'gstin', width: 18 },
  { header: 'Place of supply', key: 'pos', width: 20 },
  { header: 'HSN', key: 'hsn', width: 9 },
  { header: 'Qty (m)', key: 'qty', width: 11, style: { numFmt: '#,##0.00' } },
  { header: 'Rate', key: 'rate', width: 10, style: { numFmt: '#,##0.00' } },
  { header: 'Taxable', key: 'taxable', width: 13, style: { numFmt: '#,##0.00' } },
  { header: 'CGST', key: 'cgst', width: 11, style: { numFmt: '#,##0.00' } },
  { header: 'SGST', key: 'sgst', width: 11, style: { numFmt: '#,##0.00' } },
  { header: 'IGST', key: 'igst', width: 11, style: { numFmt: '#,##0.00' } },
  { header: 'Round off', key: 'ro', width: 10, style: { numFmt: '#,##0.00' } },
  { header: 'Total', key: 'total', width: 13, style: { numFmt: '#,##0.00' } },
];

/** Fetch app invoices in bounded pages without deriving collection balances for every invoice. */
export async function* tallyExportRows(q: Q, from: string | null, to: string, highWaterId: number, pageSize = 500): AsyncGenerator<ExportInvoice> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 5000) throw new Error('Invoice export page size must be between 1 and 5,000.');
  let afterDate: string | null = null;
  let afterId: number | null = null;
  for (;;) {
    const r = await q(
      `SELECT i.id, i.invoice_no, i.party_id, p.name AS party_name, i.dispatch_id, i.order_id,
              to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
              i.taxable_amount, i.cgst, i.sgst, i.igst, i.total, i.lines, i.status, i.source, i.exported_at, i.created_at,
              p.gstin AS party_gstin, p.state_code AS party_state, d.challan_no
       FROM invoices i JOIN parties p ON p.id = i.party_id
       LEFT JOIN dispatches d ON d.id = i.dispatch_id
       WHERE i.id <= $1 AND i.source = 'app' AND i.status <> 'cancelled'
         AND ($2::date IS NULL OR i.invoice_date >= $2::date) AND i.invoice_date <= $3::date
         AND ($4::date IS NULL OR (i.invoice_date, i.id) > ($4::date, $5::int))
       ORDER BY i.invoice_date, i.id
       LIMIT $6`,
      [highWaterId, from, to, afterDate, afterId, pageSize + 1],
    );
    const page = r.rows.slice(0, pageSize);
    for (const row of page) {
      yield {
        ...toInvoice(row),
        party_gstin: row.party_gstin == null ? null : String(row.party_gstin),
        party_state: row.party_state == null ? null : String(row.party_state),
        challan_no: row.challan_no == null ? null : String(row.challan_no),
      };
    }
    if (r.rows.length <= pageSize) return;
    const last = page[page.length - 1];
    afterDate = String(last.invoice_date);
    afterId = Number(last.id);
  }
}

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

/** Stream Tally's voucher workbook; memory use stays bounded by one worksheet row. */
export async function streamTallyXlsx(b: Billing, invoices: AsyncIterable<ExportInvoice>, output: Writable) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: output, useStyles: true, useSharedStrings: false });
  wb.creator = b.legalName;
  wb.created = new Date();
  const maxDataRows = 1_048_574;
  let sheetNumber = 1;
  let rowsInSheet = 0;
  let invoiceCount = 0;
  let meters = 0;
  let taxable = 0, cgst = 0, sgst = 0, igst = 0, roundOff = 0, total = 0;
  const addSheet = (name: string) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = TALLY_COLUMNS;
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = HEAD_FILL;
    ws.getRow(1).commit();
    return ws;
  };
  let ws = addSheet('Sales vouchers');
  for await (const inv of invoices) {
    invoiceCount++;
    const pos = stateLabel(partyState({ state_code: inv.party_state, gstin: inv.party_gstin }) ?? b.stateCode);
    const lines = inv.lines.length ? inv.lines : [{ lot_id: '', quality: '', hsn: b.hsnCode, meters: 0, rate: 0, amount: inv.taxable_amount }];
    taxable += inv.taxable_amount; cgst += inv.cgst; sgst += inv.sgst; igst += inv.igst;
    roundOff += roundOffOf(inv); total += inv.total;
    meters += inv.lines.reduce((sum, line) => sum + line.meters, 0);
    for (let i = 0; i < lines.length; i++) {
      if (rowsInSheet === maxDataRows) {
        ws.autoFilter = { from: 'A1', to: { row: rowsInSheet + 1, column: TALLY_COLUMNS.length } };
        ws.commit();
        sheetNumber++;
        rowsInSheet = 0;
        ws = addSheet(`Sales vouchers ${sheetNumber}`);
      }
      const line = lines[i];
      ws.addRow({
        date: new Date(`${inv.invoice_date}T00:00:00Z`), no: inv.invoice_no, party: inv.party_name,
        gstin: inv.party_gstin ?? '', pos, hsn: line.hsn, qty: line.meters || null, rate: line.rate || null,
        taxable: line.amount, cgst: i === 0 ? inv.cgst : null, sgst: i === 0 ? inv.sgst : null,
        igst: i === 0 ? inv.igst : null, ro: i === 0 ? roundOffOf(inv) : null, total: i === 0 ? inv.total : null,
      }).commit();
      rowsInSheet++;
    }
  }
  if (rowsInSheet === maxDataRows) {
    ws.autoFilter = { from: 'A1', to: { row: rowsInSheet + 1, column: TALLY_COLUMNS.length } };
    ws.commit();
    sheetNumber++;
    rowsInSheet = 0;
    ws = addSheet(`Sales vouchers ${sheetNumber}`);
  }
  const footer = ws.addRow({
    no: `${invoiceCount} invoice${invoiceCount === 1 ? '' : 's'}`, party: 'Total', qty: r2(meters),
    taxable: r2(taxable), cgst: r2(cgst), sgst: r2(sgst), igst: r2(igst), ro: r2(roundOff), total: r2(total),
  });
  footer.font = { bold: true };
  footer.commit();
  ws.autoFilter = { from: 'A1', to: { row: Math.max(rowsInSheet + 1, 1), column: TALLY_COLUMNS.length } };
  await wb.commit();
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
function tallyVoucher(b: Billing, inv: ExportInvoice): string {
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
}

export async function* tallyXmlChunks(b: Billing, invoices: AsyncIterable<ExportInvoice>): AsyncGenerator<string> {
  yield `<?xml version="1.0" encoding="UTF-8"?>
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
`;
  for await (const inv of invoices) yield `${tallyVoucher(b, inv)}\n`;
  yield `   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>
`;
}

export function tallyXml(b: Billing, invoices: ExportInvoice[]): string {
  const vouchers = invoices.map((invoice) => tallyVoucher(b, invoice)).join('\n');
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
${vouchers}
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>
`;
}

export async function writeTallyXml(b: Billing, invoices: AsyncIterable<ExportInvoice>, output: Writable) {
  for await (const chunk of tallyXmlChunks(b, invoices)) {
    if (!output.write(chunk)) await once(output, 'drain');
  }
}
