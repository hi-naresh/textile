// Party (client) lookup shared by orders, inquiries, dispatch, invoices and credit.
import type { Q } from './db';
import { LedgerError } from './ledger-error';
import { nameKey, nameValue } from './normalize';

/** Find a party by name (ignoring case/spaces/dots). With create=true, add it if new. */
export async function partyByName(q: Q, name: unknown, create = false): Promise<{ id: number; name: string } | null> {
  const n = nameValue(name, 'Party');
  if (!n) return null;
  const r = await q(`SELECT id, name FROM parties WHERE name_key = $1`, [nameKey(n)]);
  if (r.rows[0]) return r.rows[0];
  if (!create) return null;
  const ins = await q(`INSERT INTO parties (name) VALUES ($1) ON CONFLICT (name_key) DO UPDATE SET name = parties.name RETURNING id, name`, [n]);
  return ins.rows[0];
}

export async function partyById(q: Q, id: unknown): Promise<{ id: number; name: string; state_code: string | null; credit_days: number; credit_limit: number | null; gstin: string | null }> {
  const pid = Number(id);
  if (!Number.isInteger(pid) || pid <= 0) throw new LedgerError('A valid party is required.');
  const r = await q(`SELECT id, name, state_code, credit_days, credit_limit, gstin FROM parties WHERE id = $1`, [pid]);
  if (!r.rows[0]) throw new LedgerError('Party not found.', 404);
  const x = r.rows[0];
  return { ...x, credit_limit: x.credit_limit == null ? null : Number(x.credit_limit) };
}
