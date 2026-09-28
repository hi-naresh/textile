// Credit & payments maths (owner only). Deterministic:
//  outstanding = Σ invoices (not cancelled) − Σ payments
//  payments settle invoices FIFO (oldest invoice first; a payment tagged to an invoice settles that one first)
//  ageing buckets of each invoice's unpaid part by days past its DUE date.
// All sums are done in paise (integers) to avoid float drift.
import type { Q } from '../db';
import { round2, seq } from './validate';

export type BucketKey = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90p';
export type Buckets = Record<BucketKey, number>;
export const BUCKET_LABEL: Record<BucketKey, string> = { current: 'Not due', d1_30: '1–30', d31_60: '31–60', d61_90: '61–90', d90p: '90+' };

export interface InvoiceIn { id: number; invoice_no: string; party_id: number; invoice_date: string; due_date: string; total: number; days_past_due: number; status: string }
export interface PaymentIn { party_id: number; invoice_id: number | null; amount: number; paid_on: string }

export interface OpenInvoice { id: number; invoice_no: string; invoice_date: string; due_date: string; total: number; paid: number; unpaid: number; days_past_due: number }

export interface PartyCredit {
  party_id: number; name: string; phone: string | null; credit_limit: number | null; credit_days: number;
  invoiced: number; paid: number; outstanding: number; overdue: number; buckets: Buckets;
  limit: number | null; available: number | null; over_limit: number; oldest_due_days: number;
  last_payment: { amount: number; paid_on: string } | null;
  invoices: OpenInvoice[]; // every non-cancelled invoice with its settled / unpaid split (oldest first)
}

const P = (n: number) => Math.round(Number(n) * 100);
const R = (p: number) => p / 100;
const emptyBuckets = (): Buckets => ({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90p: 0 });

export function bucketOf(daysPastDue: number): BucketKey {
  if (daysPastDue <= 0) return 'current';
  if (daysPastDue <= 30) return 'd1_30';
  if (daysPastDue <= 60) return 'd31_60';
  if (daysPastDue <= 90) return 'd61_90';
  return 'd90p';
}

/**
 * Pure FIFO settlement for ONE party. `invoices` must exclude cancelled ones.
 * Returns each invoice's paid / unpaid part (oldest first) and any unapplied advance (paise → ₹).
 */
export function settle(invoices: InvoiceIn[], payments: PaymentIn[]): { rows: OpenInvoice[]; advance: number } {
  const inv = [...invoices].sort((a, b) => a.invoice_date.localeCompare(b.invoice_date) || a.due_date.localeCompare(b.due_date) || a.id - b.id);
  const paid = new Map<number, number>(inv.map((i) => [i.id, 0]));
  let pool = 0;
  // 1) payments tagged to an invoice settle that invoice first
  for (const p of payments) {
    const amt = P(p.amount);
    const target = p.invoice_id != null ? inv.find((i) => i.id === p.invoice_id) : undefined;
    if (!target) { pool += amt; continue; }
    const room = P(target.total) - paid.get(target.id)!;
    const use = Math.max(0, Math.min(room, amt));
    paid.set(target.id, paid.get(target.id)! + use);
    pool += amt - use;
  }
  // 2) the rest settles the oldest invoices first
  for (const i of inv) {
    if (pool <= 0) break;
    const room = P(i.total) - paid.get(i.id)!;
    const use = Math.min(room, pool);
    if (use > 0) { paid.set(i.id, paid.get(i.id)! + use); pool -= use; }
  }
  return {
    rows: inv.map((i) => ({
      id: i.id, invoice_no: i.invoice_no, invoice_date: i.invoice_date, due_date: i.due_date, total: round2(i.total),
      paid: R(paid.get(i.id)!), unpaid: R(P(i.total) - paid.get(i.id)!), days_past_due: i.days_past_due,
    })),
    advance: R(pool),
  };
}

export function summarize(party: { id: number; name: string; phone: string | null; credit_limit: number | null; credit_days: number }, invoices: InvoiceIn[], payments: PaymentIn[]): PartyCredit {
  const { rows } = settle(invoices, payments);
  const b = emptyBuckets();
  const bp: Record<BucketKey, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90p: 0 };
  let overdueP = 0;
  let oldest = 0;
  for (const r of rows) {
    const u = P(r.unpaid);
    if (u <= 0) continue;
    bp[bucketOf(r.days_past_due)] += u;
    if (r.days_past_due > 0) { overdueP += u; oldest = Math.max(oldest, r.days_past_due); }
  }
  (Object.keys(b) as BucketKey[]).forEach((k) => { b[k] = R(bp[k]); });
  const invP = invoices.reduce((s, i) => s + P(i.total), 0);
  const payP = payments.reduce((s, p) => s + P(p.amount), 0);
  const outP = invP - payP;
  const limitP = party.credit_limit == null ? null : P(party.credit_limit);
  const last = [...payments].sort((a, b2) => b2.paid_on.localeCompare(a.paid_on))[0];
  return {
    party_id: party.id, name: party.name, phone: party.phone, credit_limit: party.credit_limit, credit_days: party.credit_days,
    invoiced: R(invP), paid: R(payP), outstanding: R(outP), overdue: R(overdueP), buckets: b,
    limit: party.credit_limit, available: limitP == null ? null : R(limitP - Math.max(0, outP)),
    over_limit: limitP == null ? 0 : R(Math.max(0, outP - limitP)), oldest_due_days: oldest,
    last_payment: last ? { amount: round2(last.amount), paid_on: last.paid_on } : null,
    invoices: rows,
  };
}

/**
 * Credit picture per party. With `partyIds`, only those parties (any activity or not);
 * otherwise every party with at least one invoice or payment.
 */
export async function creditSummary(q: Q, partyIds?: number[]): Promise<PartyCredit[]> {
  const only = partyIds && partyIds.length ? partyIds : null;
  const [parties, inv, pay] = await seq([
    () => q(`SELECT id, name, phone, credit_limit, credit_days FROM parties p
       WHERE ($1::int[] IS NOT NULL AND id = ANY($1::int[]))
          OR ($1::int[] IS NULL AND (EXISTS (SELECT 1 FROM invoices i WHERE i.party_id = p.id AND i.status <> 'cancelled')
                                  OR EXISTS (SELECT 1 FROM payments y WHERE y.party_id = p.id)))
       ORDER BY name`, [only]),
    () => q(`SELECT id, invoice_no, party_id, to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date, to_char(due_date, 'YYYY-MM-DD') AS due_date,
              total, (CURRENT_DATE - due_date)::int AS days_past_due, status
       FROM invoices WHERE status <> 'cancelled' AND ($1::int[] IS NULL OR party_id = ANY($1::int[]))`, [only]),
    () => q(`SELECT party_id, invoice_id, amount, to_char(paid_on, 'YYYY-MM-DD') AS paid_on FROM payments WHERE ($1::int[] IS NULL OR party_id = ANY($1::int[]))`, [only])]);
  const invBy = new Map<number, InvoiceIn[]>();
  for (const r of inv.rows) {
    const x: InvoiceIn = { id: Number(r.id), invoice_no: r.invoice_no, party_id: Number(r.party_id), invoice_date: r.invoice_date, due_date: r.due_date, total: Number(r.total), days_past_due: Number(r.days_past_due), status: r.status };
    invBy.set(x.party_id, [...(invBy.get(x.party_id) ?? []), x]);
  }
  const payBy = new Map<number, PaymentIn[]>();
  for (const r of pay.rows) {
    const x: PaymentIn = { party_id: Number(r.party_id), invoice_id: r.invoice_id == null ? null : Number(r.invoice_id), amount: Number(r.amount), paid_on: r.paid_on };
    payBy.set(x.party_id, [...(payBy.get(x.party_id) ?? []), x]);
  }
  return parties.rows.map((p) => summarize(
    { id: Number(p.id), name: p.name, phone: p.phone ?? null, credit_limit: p.credit_limit == null ? null : Number(p.credit_limit), credit_days: Number(p.credit_days) },
    invBy.get(Number(p.id)) ?? [], payBy.get(Number(p.id)) ?? [],
  ));
}

export async function partyCredit(q: Q, partyId: number): Promise<PartyCredit | null> {
  return (await creditSummary(q, [partyId]))[0] ?? null;
}

export interface CreditTotals { outstanding: number; overdue: number; buckets: Buckets; parties_overdue: number; parties_over_limit: number; collected_this_month: number; invoiced_this_month: number; advance: number }

export async function creditTotals(q: Q, rows: PartyCredit[]): Promise<CreditTotals> {
  const b = emptyBuckets();
  let out = 0, od = 0, adv = 0, nOd = 0, nOl = 0;
  for (const r of rows) {
    if (r.outstanding > 0) out += P(r.outstanding); else adv += -P(r.outstanding);
    od += P(r.overdue);
    if (r.overdue > 0) nOd++;
    if (r.over_limit > 0) nOl++;
    (Object.keys(b) as BucketKey[]).forEach((k) => { b[k] = round2(b[k] + r.buckets[k]); });
  }
  const m = await q(
    `SELECT (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE date_trunc('month', paid_on) = date_trunc('month', CURRENT_DATE)) AS collected,
            (SELECT COALESCE(SUM(total), 0) FROM invoices WHERE status <> 'cancelled' AND date_trunc('month', invoice_date) = date_trunc('month', CURRENT_DATE)) AS invoiced`,
  );
  return {
    outstanding: R(out), overdue: R(od), buckets: b, parties_overdue: nOd, parties_over_limit: nOl,
    collected_this_month: Number(m.rows[0].collected), invoiced_this_month: Number(m.rows[0].invoiced), advance: R(adv),
  };
}

/** After a payment (inside its transaction): mark fully settled invoices 'paid', re-open any that are not. Returns newly paid invoice numbers. */
export async function syncInvoiceStatuses(q: Q, partyId: number): Promise<string[]> {
  const c = await partyCredit(q, partyId);
  if (!c) return [];
  const paidIds = c.invoices.filter((i) => i.unpaid <= 0).map((i) => i.id);
  const openIds = c.invoices.filter((i) => i.unpaid > 0).map((i) => i.id);
  const r = await q(`UPDATE invoices SET status = 'paid' WHERE id = ANY($1::int[]) AND status = 'open' RETURNING invoice_no`, [paidIds]);
  if (openIds.length) await q(`UPDATE invoices SET status = 'open' WHERE id = ANY($1::int[]) AND status = 'paid'`, [openIds]);
  return r.rows.map((x) => String(x.invoice_no));
}
