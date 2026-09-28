// Party ledger statement (owner only): opening balance, invoices (debit) and payments (credit)
// by date with a running balance, closing balance, and ageing of what is still unpaid.
import type { Q } from '../db';
import { LedgerError } from '../ledger-error';
import { AGEING_BUCKETS, ageingBucket, applyPaymentsFifo, daysBetween, isIsoDate, r2 } from '../gst';
import { dbToday } from './common';

export interface StatementEntry { date: string; kind: 'invoice' | 'payment'; ref: string; detail: string; debit: number; credit: number; balance: number }
export interface Statement {
  party: { id: number; name: string; address: string | null; city: string | null; gstin: string | null; state_code: string | null; phone: string | null; credit_days: number; credit_limit: number | null };
  from: string; to: string; opening: number; closing: number; totalDebit: number; totalCredit: number;
  entries: StatementEntry[];
  ageing: { bucket: string; amount: number }[];
  open: { invoice_no: string; invoice_date: string; due_date: string; balance: number; days_overdue: number }[];
}

/** Indian financial year start (1 April) for a date. */
export const fyStart = (iso: string) => {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return `${m >= 4 ? y : y - 1}-04-01`;
};

export async function partyStatement(q: Q, partyId: number, fromRaw?: string | null, toRaw?: string | null): Promise<Statement> {
  if (!Number.isInteger(partyId) || partyId <= 0) throw new LedgerError('A valid party is required.');
  const pr = await q(`SELECT id, name, address, city, gstin, state_code, phone, credit_days, credit_limit FROM parties WHERE id = $1`, [partyId]);
  if (!pr.rows[0]) throw new LedgerError('Party not found.', 404);
  const p = pr.rows[0];
  for (const [k, v] of [['from', fromRaw], ['to', toRaw]] as const) if (v && !isIsoDate(v)) throw new LedgerError(`"${k}" must be a date like 2026-09-28.`);
  const to = toRaw && isIsoDate(toRaw) ? toRaw : await dbToday(q);
  const from = fromRaw && isIsoDate(fromRaw) ? fromRaw : fyStart(to);
  if (from > to) throw new LedgerError('"From" date is after "to" date.');

  const inv = await q(
    `SELECT id, invoice_no, source, status, to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date, to_char(due_date, 'YYYY-MM-DD') AS due_date, total, lines
     FROM invoices WHERE party_id = $1 AND status <> 'cancelled' AND invoice_date <= $2::date ORDER BY invoice_date, id`,
    [partyId, to],
  );
  const pay = await q(
    `SELECT pm.id, to_char(pm.paid_on, 'YYYY-MM-DD') AS paid_on, pm.amount, pm.mode, pm.reference, i.invoice_no
     FROM payments pm LEFT JOIN invoices i ON i.id = pm.invoice_id
     WHERE pm.party_id = $1 AND pm.paid_on <= $2::date ORDER BY pm.paid_on, pm.id`,
    [partyId, to],
  );

  const before = (d: string) => d < from;
  const opening = r2(
    inv.rows.filter((x) => before(x.invoice_date)).reduce((s, x) => s + Number(x.total), 0) -
    pay.rows.filter((x) => before(x.paid_on)).reduce((s, x) => s + Number(x.amount), 0),
  );

  const rows: Omit<StatementEntry, 'balance'>[] = [
    ...inv.rows.filter((x) => !before(x.invoice_date)).map((x) => {
      const meters = (Array.isArray(x.lines) ? x.lines : []).reduce((s: number, l: { meters?: number }) => s + Number(l.meters ?? 0), 0);
      return { date: x.invoice_date, kind: 'invoice' as const, ref: x.invoice_no, detail: `Sales invoice${x.source === 'tally' ? ' (Tally)' : ''}${meters ? ` · ${r2(meters)} m` : ''}`, debit: Number(x.total), credit: 0 };
    }),
    ...pay.rows.filter((x) => !before(x.paid_on)).map((x) => ({
      date: x.paid_on, kind: 'payment' as const, ref: x.reference || `PMT-${x.id}`,
      detail: `Payment received (${x.mode})${x.invoice_no ? ` against ${x.invoice_no}` : ''}`, debit: 0, credit: Number(x.amount),
    })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind === b.kind ? 0 : a.kind === 'invoice' ? -1 : 1));

  let bal = opening;
  const entries = rows.map((r) => { bal = r2(bal + r.debit - r.credit); return { ...r, balance: bal }; });
  const totalDebit = r2(rows.reduce((s, r) => s + r.debit, 0));
  const totalCredit = r2(rows.reduce((s, r) => s + r.credit, 0));

  // Ageing as of "to": payments up to then, applied oldest invoice first.
  const paid = r2(pay.rows.reduce((s, x) => s + Number(x.amount), 0));
  const fifo = applyPaymentsFifo(inv.rows.map((x) => ({ id: Number(x.id), party_id: partyId, invoice_date: x.invoice_date, total: Number(x.total), status: x.status })), new Map([[partyId, paid]]));
  const buckets = new Map<string, number>(AGEING_BUCKETS.map((b) => [b, 0]));
  const open: Statement['open'] = [];
  for (const x of inv.rows) {
    const b = fifo.get(Number(x.id))?.balance ?? 0;
    if (b <= 0.005) continue;
    const od = daysBetween(x.due_date, to);
    buckets.set(ageingBucket(od), r2((buckets.get(ageingBucket(od)) ?? 0) + b));
    open.push({ invoice_no: x.invoice_no, invoice_date: x.invoice_date, due_date: x.due_date, balance: b, days_overdue: od });
  }

  return {
    party: { ...p, id: Number(p.id), credit_days: Number(p.credit_days), credit_limit: p.credit_limit == null ? null : Number(p.credit_limit) },
    from, to, opening, closing: bal, totalDebit, totalCredit, entries,
    ageing: [...buckets.entries()].map(([bucket, amount]) => ({ bucket, amount })),
    open,
  };
}
