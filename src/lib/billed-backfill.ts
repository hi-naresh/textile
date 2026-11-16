import { createHash } from 'node:crypto';
import type { Q } from './db';
import { calculatedBilledMeters } from './registers';
import { applyLedgerEdits } from './ledger-edit';
import { LedgerError } from './ledger-error';

export async function planBilledBackfill(q: Q) {
  const result = await q(`SELECT id, lot_id, sr_no, meters, bill_pct FROM stock_movements
    WHERE direction = 'OUT' AND kind = 'normal' AND billed_meters IS NULL AND bill_pct IS NOT NULL ORDER BY id`);
  return result.rows.map((r) => ({ id: Number(r.id), lot_id: String(r.lot_id), sr_no: r.sr_no == null ? null : Number(r.sr_no),
    meters: Number(r.meters), bill_pct: Number(r.bill_pct), billed_meters: calculatedBilledMeters(Number(r.meters), Number(r.bill_pct))! }));
}
export const billedPlanFingerprint = (plan: Awaited<ReturnType<typeof planBilledBackfill>>) => createHash('sha256').update(JSON.stringify(plan)).digest('hex');

/** Transaction required. Refuse a changed dry-run plan; every correction uses the normal edit audit. */
export async function applyBilledBackfill(q: Q, by: string, fingerprint: string) {
  const owner = await q("SELECT id FROM users WHERE id = $1 AND role = 'owner' AND active = true", [by]);
  if (!owner.rows.length) throw new LedgerError('Choose an active owner for the correction audit.');
  // Prevent concurrent inserts/edits from changing the reviewed set during the correction.
  await q('LOCK TABLE lots IN SHARE ROW EXCLUSIVE MODE');
  await q('LOCK TABLE stock_movements IN SHARE ROW EXCLUSIVE MODE');
  const plan = await planBilledBackfill(q);
  if (billedPlanFingerprint(plan) !== fingerprint) throw new LedgerError('The correction plan changed. Run and review a new dry run.');
  for (let i = 0; i < plan.length; i += 500) {
    await applyLedgerEdits(q, plan.slice(i, i + 500).map((r) => ({ target: 'movement', id: r.id, field: 'billed_meters', value: r.billed_meters })), by);
  }
  return plan.length;
}
