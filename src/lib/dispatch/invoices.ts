// GST invoices (owner only): create from a dispatch, record one made in Tally, list with
// paid / balance (payments applied FIFO per party), cancel.
import { markAgentsStale } from '../agents/stale';
import type { Q } from '../db';
import { syncInvoiceStatuses } from '../money/credit';
import type { Invoice, InvoiceLine } from '../domain';
import { LedgerError } from '../ledger-error';
import { nextInvoiceNo, readBilling } from '../billing';
import { partyById, partyByName } from '../parties';
import { rateFor } from '../pricing';
import { resolve } from '../agents/suggest';
import { addDays, applyPaymentsFifo, computeGst, isIsoDate, partyState, r2, type GstResult } from '../gst';
import { dbToday, textOrNull, validActor } from './common';

const INVOICE_COLS = `i.id, i.invoice_no, i.party_id, p.name AS party_name, i.dispatch_id, i.order_id,
  to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
  i.taxable_amount, i.cgst, i.sgst, i.igst, i.total, i.lines, i.status, i.source, i.exported_at, i.created_at`;

type Row = Record<string, unknown>;

export function toInvoice(r: Row, paid = 0, balance?: number): Invoice & { exported_at: string | null } {
  const total = Number(r.total);
  const lines = (Array.isArray(r.lines) ? r.lines : []) as InvoiceLine[];
  const bal = balance ?? r2(total - paid);
  return {
    id: Number(r.id), invoice_no: String(r.invoice_no), party_id: Number(r.party_id), party_name: String(r.party_name ?? ''),
    dispatch_id: r.dispatch_id == null ? null : Number(r.dispatch_id), order_id: r.order_id == null ? null : Number(r.order_id),
    invoice_date: String(r.invoice_date), due_date: String(r.due_date),
    taxable_amount: Number(r.taxable_amount), cgst: Number(r.cgst), sgst: Number(r.sgst), igst: Number(r.igst), total,
    lines: lines.map((l) => ({ ...l, meters: Number(l.meters), rate: Number(l.rate), amount: Number(l.amount) })),
    // "paid" is derived from payments (or set by hand); cancelled is stored.
    status: r.status === 'cancelled' ? 'cancelled' : r.status === 'paid' || bal <= 0.005 ? 'paid' : paid > 0.005 ? 'part_paid' : 'open',
    source: r.source === 'tally' ? 'tally' : 'app', paid, balance: r.status === 'cancelled' ? 0 : bal,
    exported_at: r.exported_at ? new Date(String(r.exported_at)).toISOString() : null,
  };
}

/** Rates the caller may pass for lots/qualities without a saved rate: { [lot_id or quality]: ₹/m }. */
function fallbackRate(rates: unknown, lotId: string, quality: string): number | null {
  if (!rates || typeof rates !== 'object') return null;
  const m = rates as Record<string, unknown>;
  for (const k of [lotId, quality]) {
    const v = m[k] ?? Object.entries(m).find(([key]) => key.toLowerCase() === k.toLowerCase())?.[1];
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0 && n < 100_000) return r2(n);
  }
  return null;
}

export interface CreatedInvoice { invoice: Invoice; note: string | null; gst: GstResult }

/**
 * GST invoice for a dispatch. Rate per line: order rate → saved rate (party, then general) → rates[lot_id | quality].
 * Must run inside the caller's transaction (takes the next invoice number).
 */
export async function createInvoiceForDispatch(
  q: Q, dispatchId: number, opts: { rates?: unknown; invoice_date?: unknown; actor?: string | null } = {},
): Promise<CreatedInvoice> {
  await markAgentsStale(q);
  if (!Number.isInteger(dispatchId) || dispatchId <= 0) throw new LedgerError('A valid dispatch is required.');
  const d = await q(`SELECT * FROM dispatches WHERE id = $1 FOR UPDATE`, [dispatchId]);
  const disp = d.rows[0];
  if (!disp) throw new LedgerError(`Dispatch #${dispatchId} not found.`, 404);
  if (!disp.party_id) throw new LedgerError(`Dispatch #${dispatchId} has no party.`);
  const dup = await q(`SELECT invoice_no FROM invoices WHERE dispatch_id = $1 AND status <> 'cancelled' LIMIT 1`, [dispatchId]);
  if (dup.rows[0]) throw new LedgerError(`Dispatch #${dispatchId} already has invoice ${dup.rows[0].invoice_no}.`, 409);

  const invoiceDate = opts.invoice_date == null || opts.invoice_date === '' ? await dbToday(q) : opts.invoice_date;
  if (!isIsoDate(invoiceDate)) throw new LedgerError('Invoice date must be YYYY-MM-DD.');

  const party = await partyById(q, disp.party_id);
  const mv = await q(
    `SELECT sm.id, sm.lot_id, sm.meters, sm.order_id, l.quality, l.design, o.rate_per_m AS order_rate
     FROM stock_movements sm JOIN lots l ON l.lot_id = sm.lot_id
     LEFT JOIN orders o ON o.id = COALESCE(sm.order_id, $2)
     WHERE sm.dispatch_id = $1 AND sm.direction = 'OUT' ORDER BY sm.id`,
    [dispatchId, disp.order_id],
  );
  if (!mv.rows.length) throw new LedgerError(`Dispatch #${dispatchId} has no lots.`);

  const missing = new Set<string>();
  const lines = [];
  for (const m of mv.rows) {
    const orderRate = m.order_rate != null && Number(m.order_rate) > 0 ? Number(m.order_rate) : null;
    const rate = orderRate ?? (await rateFor(q, m.quality, party.id, invoiceDate)) ?? fallbackRate(opts.rates, m.lot_id, m.quality);
    if (rate == null) { missing.add(m.quality); continue; }
    lines.push({ lot_id: m.lot_id, quality: m.quality, design: m.design, meters: Number(m.meters), rate });
  }
  if (missing.size) {
    const list = [...missing];
    throw new LedgerError(`No rate for ${list.join(', ')}. Add a ₹/m rate for ${list.length > 1 ? 'these qualities' : 'this quality'} (Settings → Rates, or on the order), or enter it on the invoice.`);
  }

  const billing = await readBilling(q);
  const gst = computeGst({ lines, hsn: billing.hsnCode, gstRatePct: billing.gstRatePct, firmState: billing.stateCode, partyState: partyState(party) });
  const invoiceNo = await nextInvoiceNo(q, new Date(`${invoiceDate}T12:00:00Z`));
  const dueDate = addDays(invoiceDate, party.credit_days ?? 30);
  const actor = await validActor(q, opts.actor);
  const ins = await q(
    `INSERT INTO invoices (invoice_no, party_id, dispatch_id, order_id, invoice_date, due_date, taxable_amount, cgst, sgst, igst, total, lines, status, source, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'open', 'app', $13) RETURNING id`,
    [invoiceNo, party.id, dispatchId, disp.order_id, invoiceDate, dueDate, gst.taxable, gst.cgst, gst.sgst, gst.igst, gst.total,
     JSON.stringify(gst.lines.map(({ lot_id, quality, hsn, meters, rate, amount }) => ({ lot_id, quality, hsn, meters, rate, amount }))), actor],
  );
  await resolve(q, `invoice_missing:${dispatchId}`);
  const invoice = await getInvoice(q, Number(ins.rows[0].id));
  await syncInvoiceStatuses(q, party.id); // advance payments may already cover it
  return { invoice, note: gst.note, gst };
}

/** An invoice made in Tally: amounts only (no lines, no PDF from us). */
export async function recordTallyInvoice(q: Q, b: Record<string, unknown>, actorRaw: string | null): Promise<Invoice> {
  await markAgentsStale(q);
  const invoiceNo = textOrNull(b.invoice_no, 30);
  if (!invoiceNo) throw new LedgerError('Invoice number is required.');
  const pid = typeof b.party === 'number' || (typeof b.party === 'string' && /^\d+$/.test(b.party.trim())) ? Number(b.party) : null;
  const party = pid ? await partyById(q, pid) : await (async () => {
    const p = await partyByName(q, b.party, true);
    if (!p) throw new LedgerError('Party is required.');
    return partyById(q, p.id);
  })();
  const invoiceDate = b.invoice_date ?? (await dbToday(q));
  if (!isIsoDate(invoiceDate)) throw new LedgerError('Invoice date must be YYYY-MM-DD.');
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, '')));
  const total = num(b.total);
  if (total == null || !Number.isFinite(total) || total <= 0 || total > 1e11) throw new LedgerError('Invoice total must be a positive amount.');
  const taxable = num(b.taxable_amount) ?? total;
  if (!Number.isFinite(taxable) || taxable < 0 || taxable > total) throw new LedgerError('Taxable amount must be between 0 and the total.');
  const due = b.due_date == null || b.due_date === '' ? addDays(invoiceDate, party.credit_days ?? 30) : b.due_date;
  if (!isIsoDate(due)) throw new LedgerError('Due date must be YYYY-MM-DD.');
  if (due < invoiceDate) throw new LedgerError('Due date cannot be before the invoice date.');
  let dispatchId: number | null = null;
  if (b.dispatch_id != null && b.dispatch_id !== '') {
    dispatchId = Number(b.dispatch_id);
    const d = await q(`SELECT party_id FROM dispatches WHERE id = $1`, [dispatchId]);
    if (!d.rows[0]) throw new LedgerError(`Dispatch #${b.dispatch_id} not found.`, 404);
    if (d.rows[0].party_id !== party.id) throw new LedgerError(`Dispatch #${dispatchId} is for another party.`);
  }
  const exists = await q(`SELECT id FROM invoices WHERE invoice_no = $1`, [invoiceNo]);
  if (exists.rows[0]) throw new LedgerError(`Invoice ${invoiceNo} is already recorded.`, 409);
  const ins = await q(
    `INSERT INTO invoices (invoice_no, party_id, dispatch_id, invoice_date, due_date, taxable_amount, total, lines, status, source, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '[]'::jsonb, 'open', 'tally', $8) RETURNING id`,
    [invoiceNo, party.id, dispatchId, invoiceDate, due, r2(taxable), r2(total), await validActor(q, actorRaw)],
  );
  if (dispatchId) await resolve(q, `invoice_missing:${dispatchId}`);
  await syncInvoiceStatuses(q, party.id);
  return getInvoice(q, Number(ins.rows[0].id));
}

/** Total payments per party (optionally up to a date). */
async function paymentsByParty(q: Q, partyIds: number[] | null, upTo?: string | null): Promise<Map<number, number>> {
  const r = await q(
    `SELECT party_id, SUM(amount) AS s FROM payments
     WHERE ($1::int[] IS NULL OR party_id = ANY($1)) AND ($2::date IS NULL OR paid_on <= $2::date) GROUP BY party_id`,
    [partyIds, upTo ?? null],
  );
  return new Map(r.rows.map((x) => [Number(x.party_id), Number(x.s)]));
}

export interface InvoiceFilter { party_id?: number | null; status?: string | null; from?: string | null; to?: string | null; source?: string | null; id?: number | null }

/** Invoices with paid + balance. FIFO runs over each party's whole history, then filters apply. */
export async function listInvoices(q: Q, f: InvoiceFilter = {}): Promise<(Invoice & { exported_at: string | null; days_overdue: number })[]> {
  const r = await q(
    `SELECT ${INVOICE_COLS}, (CURRENT_DATE - i.due_date) AS days_overdue
     FROM invoices i JOIN parties p ON p.id = i.party_id
     WHERE ($1::int IS NULL OR i.party_id = $1)
       AND ($2::int IS NULL OR i.party_id = (SELECT party_id FROM invoices WHERE id = $2))
     ORDER BY i.invoice_date, i.id`,
    [f.party_id ?? null, f.id ?? null],
  );
  const parties = [...new Set(r.rows.map((x) => Number(x.party_id)))];
  const paid = await paymentsByParty(q, parties.length ? parties : [-1]);
  const fifo = applyPaymentsFifo(r.rows.map((x) => ({ id: Number(x.id), party_id: Number(x.party_id), invoice_date: x.invoice_date, total: Number(x.total), status: x.status })), paid);
  const all = r.rows.map((x) => {
    const p = fifo.get(Number(x.id)) ?? { paid: 0, balance: Number(x.total) };
    return { ...toInvoice(x, p.paid, p.balance), days_overdue: Number(x.days_overdue) };
  });
  return all
    .filter((x) => (f.id ? x.id === f.id : true))
    .filter((x) => {
      if (!f.status) return true;
      const unpaid = x.status === 'open' || x.status === 'part_paid';
      if (f.status === 'overdue') return unpaid && x.days_overdue > 0;
      if (f.status === 'open') return unpaid; // "open" = anything still to collect
      return x.status === f.status;
    })
    .filter((x) => (f.source ? x.source === f.source : true))
    .filter((x) => (f.from ? x.invoice_date >= f.from : true))
    .filter((x) => (f.to ? x.invoice_date <= f.to : true))
    .reverse(); // newest first
}

export async function getInvoice(q: Q, id: number): Promise<Invoice & { exported_at: string | null; days_overdue: number }> {
  if (!Number.isInteger(id) || id <= 0) throw new LedgerError('A valid invoice id is required.');
  const [inv] = await listInvoices(q, { id });
  if (!inv) throw new LedgerError('Invoice not found.', 404);
  return inv;
}

export async function cancelInvoice(q: Q, id: number): Promise<Invoice> {
  await markAgentsStale(q);
  const r = await q(`UPDATE invoices SET status = 'cancelled' WHERE id = $1 AND status <> 'cancelled' RETURNING id, party_id`, [id]);
  if (!r.rowCount) {
    const e = await q(`SELECT status FROM invoices WHERE id = $1`, [id]);
    if (!e.rows[0]) throw new LedgerError('Invoice not found.', 404);
    throw new LedgerError('This invoice is already cancelled.');
  }
  await syncInvoiceStatuses(q, Number(r.rows[0].party_id)); // payments move to the next open invoice
  return getInvoice(q, id);
}
