// The four documents: delivery challan, packing list, GST tax invoice, party statement.
// Pure rendering from data already loaded (see /api/docs/*). Challan + packing list carry no money.
import type { Billing } from '../billing';
import type { Invoice } from '../domain';
import type { DispatchLine, DispatchRow } from '../dispatch/dispatches';
import type { Statement } from '../dispatch/statement';
import { amountInWords, dmy, formatINR, partyState, r2, roundOffOf, stateLabel } from '../gst';
import { CONTENT_W, FILL, GREY, M, Pdf, PAGE_W } from './layout';

const mtr = (n: number) => formatINR(n, 2);
const rs = (n: number) => `Rs. ${formatINR(n)}`;
const dateOf = (iso: string) => dmy(iso.slice(0, 10));

/** Local calendar date of a timestamp (Asia/Kolkata), YYYY-MM-DD. */
function istDate(ts: string): string {
  const d = new Date(ts);
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

interface PartyInfo { name: string | null; address: string | null; city?: string | null; gstin: string | null; state_code: string | null }

function partyLines(p: PartyInfo): (string | [string, string])[] {
  const st = partyState(p);
  return [
    p.name ?? '—',
    ...(p.address ? [p.address] : []),
    ...(p.city ? [p.city] : []),
    ['GSTIN', p.gstin ?? 'Unregistered / not given'],
    ['State', stateLabel(st)],
  ];
}

function transportLines(d: DispatchRow): [string, string][] {
  return [
    ['Transporter', d.transporter ?? '—'],
    ['LR no.', d.lr_no ?? '—'],
    ['Vehicle', d.vehicle_no ?? '—'],
    ['Packages', d.packages != null ? String(d.packages) : '—'],
  ];
}

// ---------- delivery challan ----------
export async function challanPdf(b: Billing, d: DispatchRow, lines: DispatchLine[]): Promise<Uint8Array> {
  const no = d.challan_no ?? `DC-${d.id}`;
  const pdf = await Pdf.create('DELIVERY CHALLAN', b, `No. ${no}`);
  pdf.infoBoxes([
    { title: 'Consignee (deliver to)', lines: partyLines({ name: d.party_name, address: d.party_address, city: d.party_city, gstin: d.party_gstin, state_code: d.party_state }) },
    { title: 'Challan', lines: [['Challan no.', no], ['Date', dateOf(istDate(d.dispatched_at))], ...(d.order_id ? [['Order', `#${d.order_id}`] as [string, string]] : []), ...transportLines(d)] },
  ]);
  const total = r2(lines.reduce((s, l) => s + l.meters, 0));
  pdf.table(
    [{ label: 'S.No', width: 40, align: 'right' }, { label: 'Lot', width: 90 }, { label: 'Quality', width: 170 }, { label: 'Design', width: 120 }, { label: 'Meters', width: 90, align: 'right' }],
    [
      ...lines.map((l, i) => ({ cells: [String(i + 1), l.lot_id, l.quality, l.design, mtr(l.meters)] })),
      { cells: ['', '', `Total (${lines.length} lot${lines.length === 1 ? '' : 's'})`, '', mtr(total)], bold: true, fill: FILL },
    ],
  );
  pdf.para('Goods sent for sale as per order. Please check the goods on arrival; claims for shortage or damage will not be accepted after the goods are cut or processed.', { size: 8.5, color: GREY });
  pdf.y -= 8;
  pdf.para('Received the above goods in good condition.', { size: 9.5 });
  pdf.y -= 8;
  pdf.signatures(["Receiver's signature, name & stamp", `For ${b.legalName} · Authorised signatory`]);
  return pdf.save();
}

// ---------- packing list ----------
export async function packingListPdf(b: Billing, d: DispatchRow, lines: DispatchLine[]): Promise<Uint8Array> {
  const no = d.challan_no ?? `DC-${d.id}`;
  const pdf = await Pdf.create('PACKING LIST', b, `Challan ${no}`);
  pdf.infoBoxes([
    { title: 'Consignee', lines: partyLines({ name: d.party_name, address: d.party_address, city: d.party_city, gstin: d.party_gstin, state_code: d.party_state }) },
    { title: 'Shipment', lines: [['Challan no.', no], ['Date', dateOf(istDate(d.dispatched_at))], ...transportLines(d)] },
  ]);
  // One package per lot when the counts match; otherwise the package column is left to fill by hand.
  const numbered = d.packages != null && d.packages === lines.length;
  const total = r2(lines.reduce((s, l) => s + l.meters, 0));
  pdf.table(
    [{ label: 'Pkg', width: 45, align: 'center' }, { label: 'Lot', width: 90 }, { label: 'Quality', width: 160 }, { label: 'Design', width: 110 }, { label: 'Meters', width: 90, align: 'right' }, { label: 'Checked', width: 60, align: 'center' }],
    [
      ...lines.map((l, i) => ({ cells: [numbered ? String(i + 1) : '', l.lot_id, l.quality, l.design, mtr(l.meters), ''] })),
      { cells: ['', '', 'Total', '', mtr(total), ''], bold: true, fill: FILL },
    ],
  );
  const byQ = new Map<string, { lots: number; meters: number }>();
  for (const l of lines) {
    const x = byQ.get(l.quality) ?? { lots: 0, meters: 0 };
    byQ.set(l.quality, { lots: x.lots + 1, meters: r2(x.meters + l.meters) });
  }
  pdf.para('Summary by quality', { size: 10, bold: true });
  pdf.y -= 4;
  pdf.table(
    [{ label: 'Quality', width: 260 }, { label: 'Lots', width: 80, align: 'right' }, { label: 'Meters', width: 120, align: 'right' }],
    [...[...byQ.entries()].map(([q, x]) => ({ cells: [q, String(x.lots), mtr(x.meters)] })),
      { cells: ['Total', String(lines.length), mtr(total)], bold: true, fill: FILL }],
  );
  pdf.totals([{ label: 'Packages', value: d.packages != null ? String(d.packages) : '—' }, { label: 'Total meters', value: mtr(total), bold: true }]);
  pdf.signatures(['Packed by', 'Checked by']);
  return pdf.save();
}

// ---------- GST tax invoice ----------
export interface InvoiceDocInput {
  invoice: Invoice;
  party: PartyInfo & { phone?: string | null };
  dispatch: DispatchRow | null;
}

/** GST % from the stored amounts, snapped to 0.25 (rates are 0, 0.25, 3, 5, 12, 18, 28). */
function pctOf(tax: number, taxable: number, factor: number): string {
  if (taxable <= 0) return '';
  const p = Math.round(((tax * factor) / taxable) * 100 * 4) / 4;
  return `${Number.isInteger(p) ? p : p.toFixed(2).replace(/0$/, '')}%`;
}

export async function invoicePdf(b: Billing, x: InvoiceDocInput): Promise<Uint8Array> {
  const inv = x.invoice;
  const pdf = await Pdf.create('TAX INVOICE', b, 'Original for recipient');
  const pst = partyState(x.party);
  pdf.infoBoxes([
    { title: 'Billed to (recipient)', lines: partyLines(x.party) },
    {
      title: 'Invoice',
      lines: [
        ['Invoice no.', inv.invoice_no], ['Date', dmy(inv.invoice_date)], ['Due date', dmy(inv.due_date)],
        ['Supplier state', stateLabel(b.stateCode)], ['Place of supply', stateLabel(pst ?? b.stateCode)],
        ...(x.dispatch ? [['Challan', `${x.dispatch.challan_no ?? `DC-${x.dispatch.id}`} · ${dmy(istDate(x.dispatch.dispatched_at))}`] as [string, string]] : []),
        ...(x.dispatch && (x.dispatch.transporter || x.dispatch.lr_no || x.dispatch.vehicle_no)
          ? [['Transport', [x.dispatch.transporter, x.dispatch.lr_no && `LR ${x.dispatch.lr_no}`, x.dispatch.vehicle_no].filter(Boolean).join(' · ')] as [string, string]] : []),
        ...(inv.order_id ? [['Order', `#${inv.order_id}`] as [string, string]] : []),
      ],
    },
  ]);
  const meters = r2(inv.lines.reduce((s, l) => s + l.meters, 0));
  pdf.table(
    [{ label: 'S.No', width: 36, align: 'right' }, { label: 'Description of goods', width: 190 }, { label: 'HSN', width: 50 }, { label: 'Qty (m)', width: 70, align: 'right' }, { label: 'Rate (Rs./m)', width: 70, align: 'right' }, { label: 'Amount (Rs.)', width: 90, align: 'right' }],
    [
      ...inv.lines.map((l, i) => ({ cells: [String(i + 1), `${l.quality} · Lot ${l.lot_id}`, l.hsn, mtr(l.meters), formatINR(l.rate), formatINR(l.amount)] })),
      { cells: ['', 'Total', '', mtr(meters), '', formatINR(inv.taxable_amount)], bold: true, fill: FILL },
    ],
  );
  const ro = roundOffOf(inv);
  const tax: { label: string; value: string; bold?: boolean; size?: number }[] = [{ label: 'Taxable value', value: rs(inv.taxable_amount) }];
  if (inv.igst > 0 || (inv.cgst === 0 && inv.sgst === 0 && pst && b.stateCode && pst !== b.stateCode)) tax.push({ label: `IGST @ ${pctOf(inv.igst, inv.taxable_amount, 1)}`, value: rs(inv.igst) });
  else tax.push({ label: `CGST @ ${pctOf(inv.cgst, inv.taxable_amount, 1)}`, value: rs(inv.cgst) }, { label: `SGST @ ${pctOf(inv.sgst, inv.taxable_amount, 1)}`, value: rs(inv.sgst) });
  tax.push({ label: 'Round off', value: `${ro > 0 ? '+' : ''}${formatINR(ro)}` }, { label: 'Invoice total', value: rs(inv.total), bold: true, size: 12 });
  pdf.totals(tax, 250);
  pdf.para(`Amount in words: ${amountInWords(inv.total)}`, { size: 9.5, bold: true });
  if (!pst) pdf.para("Note: recipient's state is not recorded, so tax is charged as within the state (CGST + SGST).", { size: 8.5, color: GREY });
  pdf.y -= 8;
  const bank: (string | [string, string])[] = [
    ['Bank', b.bankName ?? '—'], ['A/c no.', b.bankAccount ?? '—'], ['IFSC', b.bankIfsc ?? '—'], ['Payable by', dmy(inv.due_date)],
  ];
  pdf.infoBoxes([
    { title: 'Bank details', lines: bank },
    { title: 'Declaration', lines: ['We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct. Interest may be charged on payments received after the due date.'] },
  ]);
  pdf.signatures(["Receiver's signature", `For ${b.legalName} · Authorised signatory`], 60);
  if (inv.status === 'cancelled') pdf.stamp('CANCELLED');
  return pdf.save();
}

// ---------- party statement ----------
const drcr = (n: number) => (Math.abs(n) < 0.005 ? '0.00' : `${formatINR(Math.abs(n))} ${n > 0 ? 'Dr' : 'Cr'}`);

export async function statementPdf(b: Billing, s: Statement): Promise<Uint8Array> {
  const pdf = await Pdf.create('STATEMENT OF ACCOUNT', b, `${dmy(s.from)} to ${dmy(s.to)}`);
  pdf.infoBoxes([
    { title: 'Party', lines: [...partyLines(s.party), ...(s.party.phone ? [['Phone', s.party.phone] as [string, string]] : [])] },
    {
      title: 'Summary (Rs.)',
      lines: [['Opening', drcr(s.opening)], ['Invoices', formatINR(s.totalDebit)], ['Payments', formatINR(s.totalCredit)], ['Closing', drcr(s.closing)],
        ['Credit terms', `${s.party.credit_days} days${s.party.credit_limit != null ? ` · limit ${formatINR(s.party.credit_limit, 0)}` : ''}`]],
    },
  ]);
  pdf.table(
    [{ label: 'Date', width: 62 }, { label: 'Ref', width: 92 }, { label: 'Details', width: 150 }, { label: 'Debit', width: 72, align: 'right' }, { label: 'Credit', width: 72, align: 'right' }, { label: 'Balance', width: 88, align: 'right' }],
    [
      { cells: [dmy(s.from), '', 'Opening balance', '', '', drcr(s.opening)], bold: true },
      ...s.entries.map((e) => ({ cells: [dmy(e.date), e.ref, e.detail, e.debit ? formatINR(e.debit) : '', e.credit ? formatINR(e.credit) : '', drcr(e.balance)] })),
      { cells: [dmy(s.to), '', 'Closing balance', formatINR(s.totalDebit), formatINR(s.totalCredit), drcr(s.closing)], bold: true, fill: FILL },
    ],
    { size: 8.5 },
  );
  pdf.para('Ageing of unpaid invoices (payments applied to the oldest invoice first)', { size: 10, bold: true });
  pdf.y -= 4;
  const unpaid = r2(s.ageing.reduce((t, a) => t + a.amount, 0));
  pdf.table(
    s.ageing.map((a) => ({ label: a.bucket, width: 90, align: 'right' as const })).concat([{ label: 'Total due', width: 90, align: 'right' }]),
    [{ cells: [...s.ageing.map((a) => formatINR(a.amount)), formatINR(unpaid)], bold: false }],
  );
  if (s.open.length) {
    pdf.table(
      [{ label: 'Unpaid invoice', width: 130 }, { label: 'Date', width: 80 }, { label: 'Due', width: 80 }, { label: 'Days overdue', width: 90, align: 'right' }, { label: 'Balance (Rs.)', width: 110, align: 'right' }],
      s.open.map((o) => ({ cells: [o.invoice_no, dmy(o.invoice_date), dmy(o.due_date), o.days_overdue > 0 ? String(o.days_overdue) : '—', formatINR(o.balance)] })),
      { size: 8.5 },
    );
  }
  if (s.closing < -0.005) pdf.para(`Advance with us: Rs. ${formatINR(-s.closing)}.`, { size: 9, color: GREY });
  pdf.ensure(40);
  pdf.text('Please report any difference within 7 days of receiving this statement.', M, pdf.y - 9, { size: 8.5, color: GREY });
  pdf.text(`For ${b.legalName}`, PAGE_W - M, pdf.y - 9, { size: 9, bold: true, align: 'right', width: CONTENT_W / 2 });
  pdf.y -= 20;
  return pdf.save();
}
