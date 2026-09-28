// Payments received (owner only) + the credit check used before a dispatch.
import { markAgentsStale } from '../agents/stale';
import type { Q } from '../db';
import type { Payment } from '../domain';
import { LedgerError } from '../ledger-error';
import { findParty, knownUser } from './master';
import { partyCredit, syncInvoiceStatuses, type PartyCredit } from './credit';
import { dateValue, idValue, rupeeValue, rupees, textValue } from './validate';

export const PAYMENT_MODES = ['cash', 'bank', 'upi', 'cheque', 'other'] as const;

const toPayment = (r: Record<string, unknown>): Payment => ({
  id: Number(r.id), party_id: Number(r.party_id), party_name: String(r.party_name ?? ''), invoice_id: r.invoice_id == null ? null : Number(r.invoice_id),
  amount: Number(r.amount), paid_on: String(r.paid_on), mode: r.mode as Payment['mode'], reference: (r.reference as string) ?? null,
});

const PAY_SELECT = `SELECT y.id, y.party_id, p.name AS party_name, y.invoice_id, y.amount, to_char(y.paid_on, 'YYYY-MM-DD') AS paid_on, y.mode, y.reference, i.invoice_no
  FROM payments y JOIN parties p ON p.id = y.party_id LEFT JOIN invoices i ON i.id = y.invoice_id`;

export async function listPayments(q: Q, f: { partyId?: unknown; from?: unknown; to?: unknown; limit?: number }): Promise<(Payment & { invoice_no: string | null })[]> {
  const pid = f.partyId != null && f.partyId !== '' ? idValue(f.partyId, 'party') : null;
  const from = dateValue(f.from, 'From');
  const to = dateValue(f.to, 'To');
  const r = await q(
    `${PAY_SELECT}
     WHERE ($1::int IS NULL OR y.party_id = $1) AND ($2::date IS NULL OR y.paid_on >= $2) AND ($3::date IS NULL OR y.paid_on <= $3)
     ORDER BY y.paid_on DESC, y.id DESC LIMIT $4`,
    [pid, from, to, Math.min(Math.max(f.limit ?? 200, 1), 1000)],
  );
  return r.rows.map((x) => ({ ...toPayment(x), invoice_no: x.invoice_no ?? null }));
}

export interface RecordPaymentResult { payment: Payment; outstanding: number; overdue: number; paid_invoices: string[]; credit: PartyCredit }

/** Record a payment and re-settle the party's invoices (FIFO). Call inside a transaction. */
export async function recordPayment(q: Q, b: Record<string, unknown>, actor: string | null): Promise<RecordPaymentResult> {
  await markAgentsStale(q);
  const party = await findParty(q, b.party, b.party_id);
  if (!party) {
    if (b.party == null && b.party_id == null) throw new LedgerError('Choose the party who paid.');
    throw new LedgerError(`Party "${String(b.party ?? b.party_id)}" not found. Add it in Settings → Parties first.`, 404);
  }
  // One payment at a time per party, so FIFO settlement never races.
  await q(`SELECT id FROM parties WHERE id = $1 FOR UPDATE`, [party.id]);
  const amount = rupeeValue(b.amount, 'Amount', { max: 1e10 })!;
  const paidOn = dateValue(b.paid_on, 'Payment date', { notFuture: true });
  const mode = b.mode == null || b.mode === '' ? 'bank' : String(b.mode).toLowerCase();
  if (!(PAYMENT_MODES as readonly string[]).includes(mode)) throw new LedgerError(`Mode must be one of: ${PAYMENT_MODES.join(', ')}.`);
  const reference = textValue(b.reference, 'Reference', 60);
  let invoiceId: number | null = null;
  if (b.invoice_id != null && b.invoice_id !== '') {
    invoiceId = idValue(b.invoice_id, 'invoice');
    const i = await q(`SELECT party_id, status, invoice_no FROM invoices WHERE id = $1`, [invoiceId]);
    if (!i.rows[0]) throw new LedgerError('Invoice not found.', 404);
    if (Number(i.rows[0].party_id) !== party.id) throw new LedgerError(`Invoice ${i.rows[0].invoice_no} belongs to another party.`);
    if (i.rows[0].status === 'cancelled') throw new LedgerError(`Invoice ${i.rows[0].invoice_no} is cancelled.`);
  }
  // Same reference twice for one party is almost always a double entry (double tap, re-entry).
  if (reference) {
    const dup = await q(`SELECT to_char(paid_on, 'DD Mon') AS d, amount FROM payments WHERE party_id = $1 AND lower(reference) = lower($2) LIMIT 1`, [party.id, reference]);
    if (dup.rows[0]) throw new LedgerError(`A payment with reference "${reference}" from ${party.name} is already recorded (${rupees(Number(dup.rows[0].amount))} on ${dup.rows[0].d}).`, 409);
  }
  const ins = await q(
    `INSERT INTO payments (party_id, invoice_id, amount, paid_on, mode, reference, created_by)
     VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5, $6, $7) RETURNING id`,
    [party.id, invoiceId, amount, paidOn, mode, reference, await knownUser(q, actor)],
  );
  const paidInvoices = await syncInvoiceStatuses(q, party.id);
  const row = (await q(`${PAY_SELECT} WHERE y.id = $1`, [ins.rows[0].id])).rows[0];
  const credit = (await partyCredit(q, party.id))!;
  return { payment: toPayment(row), outstanding: credit.outstanding, overdue: credit.overdue, paid_invoices: paidInvoices, credit };
}

export interface CreditCheck { ok: boolean; warn: string | null; outstanding?: number; limit?: number | null; overdue?: number; available?: number | null }

/**
 * Before a dispatch / order: warn when the party has overdue invoices or would cross its limit.
 * Owners get amounts; everyone else gets a neutral warning with no ₹.
 */
export async function creditCheck(q: Q, ref: { party?: unknown; party_id?: unknown; amount?: unknown }, isOwner: boolean): Promise<CreditCheck> {
  const party = await findParty(q, ref.party, ref.party_id);
  const amount = ref.amount == null || ref.amount === '' ? 0 : rupeeValue(ref.amount, 'Amount', { allowZero: true, max: 1e10 })!;
  if (!party) return isOwner ? { ok: true, warn: null, outstanding: 0, limit: null } : { ok: true, warn: null };
  const c = await partyCredit(q, party.id);
  const outstanding = c?.outstanding ?? 0;
  const overdue = c?.overdue ?? 0;
  const limit = party.credit_limit;
  const overLimit = limit != null && outstanding + amount > limit;
  const problems: string[] = [];
  if (overdue > 0) problems.push(`${party.name} has ${rupees(overdue)} overdue for ${c!.oldest_due_days} day${c!.oldest_due_days === 1 ? '' : 's'}`);
  if (overLimit) {
    const after = outstanding + amount;
    problems.push(outstanding > limit!
      ? `${party.name} is already ${rupees(outstanding - limit!)} over the credit limit of ${rupees(limit!)}`
      : `this would take ${party.name} to ${rupees(after)}, over the credit limit of ${rupees(limit!)}`);
  }
  // Over the limit is a stop-and-ask; overdue alone is a warning (dispatch still allowed).
  const ok = !overLimit;
  if (!isOwner) {
    if (!problems.length) return { ok: true, warn: null };
    const why = overdue > 0 && overLimit ? 'payment overdue and over credit limit' : overdue > 0 ? 'payment overdue' : 'over credit limit';
    return { ok: false, warn: `Check with the owner before dispatching to ${party.name} — ${why}.` };
  }
  const warn = !problems.length ? null : problems.map((p, i) => (i === 0 ? p[0].toUpperCase() + p.slice(1) : p)).join('; ') + '.';
  return { ok, warn, outstanding, limit, overdue, available: c?.available ?? null };
}
