// Reservation check (agent key "allocation") — deterministic, no LLM.
// Catches lots where more is kept aside for orders than the lot still holds (e.g. after a ledger correction
// or a deleted IN entry), so an order doesn't look covered by fabric that isn't there. One tap releases the
// missing part (newest reservations shrink first — the same rule dispatches use).
// The old "Allocate X m to order #N?" cards are gone: keeping stock aside is offered on the Orders card
// (orders.ts), only for orders that are late or due soon, with the lots named.
import type { Q } from '../db';
import type { AgentModule } from './types';
import { resolveMissing, suggest } from './suggest';
import { LedgerError } from '../ledger-error';
import { trimReservations } from '../stock';
import { meters } from '../sales/util';

export async function scanAllocation(q: Q): Promise<{ over: string[] }> {
  // Retired kind: close any old "allocate_order" cards still open.
  await resolveMissing(q, 'allocation', 'allocate_order', []);

  // Only lots that have reservations are looked at (a handful), not the whole stock.
  const r = await q(
    `SELECT a.lot_id, a.res, COALESCE(b.bal, 0) AS bal, a.orders
     FROM (SELECT lot_id, SUM(meters - dispatched_m) AS res, array_agg(DISTINCT order_id ORDER BY order_id) AS orders
           FROM allocations WHERE status = 'reserved' GROUP BY lot_id) a
     LEFT JOIN LATERAL (SELECT SUM(CASE WHEN direction = 'IN' THEN meters ELSE -meters END) AS bal FROM stock_movements sm WHERE sm.lot_id = a.lot_id) b ON true
     WHERE a.res > COALESCE(b.bal, 0) + 0.01`,
  );
  const over: string[] = [];
  for (const x of r.rows) {
    const key = `over_allocated:${x.lot_id}`;
    const res = Number(x.res);
    const bal = Math.max(0, Number(x.bal));
    const missing = Math.round((res - bal) * 100) / 100;
    const orderList = (x.orders as number[]).map((id) => `#${id}`).join(', ');
    await suggest(q, {
      agent: 'allocation',
      kind: 'over_allocated',
      severity: 'bad',
      title: `Lot ${x.lot_id}: ${meters(res)} m kept aside for order ${orderList}, but only ${meters(bal)} m is in stock`,
      detail: `The order looks covered by ${meters(missing)} m that isn't there (the lot's stock was corrected or sent elsewhere).`,
      hint: `"Release ${meters(missing)} m" cuts the reservation down to what the lot really holds; the Orders card then offers other lots.`,
      payload: { lot_id: x.lot_id, reserved_m: res, balance_m: bal, missing_m: missing, order_ids: x.orders },
      target: { type: 'order', id: Number((x.orders as number[])[0]) },
      actionLabel: `Release ${meters(missing)} m`,
      ownerOnly: false,
      dedupeKey: key,
    });
    over.push(key);
  }
  await resolveMissing(q, 'allocation', 'over_allocated', over);
  return { over };
}

export const agent: AgentModule = {
  scan: async (q) => { await scanAllocation(q); },
  accept: async (s, q) => {
    if (s.kind !== 'over_allocated') throw new LedgerError('Nothing to do for this one — dismiss it instead.');
    const lotId = String(s.payload?.lot_id ?? '');
    if (!lotId) throw new LedgerError('This card has no lot.');
    await q(`SELECT lot_id FROM lots WHERE lot_id = $1 FOR UPDATE`, [lotId]);
    const cut = await trimReservations(q, lotId);
    if (!cut.length) return `Nothing to release — lot ${lotId} is fine now`;
    const total = Math.round(cut.reduce((t, c) => t + c.cut, 0) * 100) / 100;
    return `Released ${meters(total)} m on lot ${lotId} (order ${[...new Set(cut.map((c) => `#${c.order_id}`))].join(', ')})`;
  },
};
