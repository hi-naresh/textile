// Fabric Allocation agent — deterministic, no LLM.
// Suggests allocating free lots to open orders that still need fabric (one tap → autoAllocate),
// and flags lots where more is reserved than is actually in stock.
import type { Q } from '../db';
import type { AgentModule } from './types';
import { resolveMissing, suggest } from './suggest';
import { LedgerError } from '../ledger-error';
import { allLotStock } from '../stock';
import { listOrders, remainingNeed } from '../sales/orders';
import { autoAllocate } from '../sales/allocate';
import { meters } from '../sales/util';

const k = (s: string | null | undefined) => (s ?? '').toLowerCase();

export async function scanAllocation(q: Q): Promise<{ allocate: string[]; over: string[] }> {
  // Free stock per quality and per quality+design, in one read.
  const lots = await allLotStock(q);
  const byQ = new Map<string, { free: number; lots: number }>();
  const byQD = new Map<string, { free: number; lots: number }>();
  for (const l of lots) {
    if (l.free <= 0) continue;
    for (const [m, key] of [[byQ, k(l.quality)], [byQD, `${k(l.quality)}|${k(l.design)}`]] as const) {
      const cur = m.get(key) ?? { free: 0, lots: 0 };
      m.set(key, { free: cur.free + l.free, lots: cur.lots + 1 });
    }
  }
  // Orders are served in promise-date order; later orders only see what is left.
  const orders = await listOrders(q, { status: 'open', role: 'owner', limit: 1000, sort: 'promise' });
  const allocate: string[] = [];
  for (const o of orders) {
    const need = remainingNeed(o);
    if (need <= 0.5) continue;
    const pool = o.design ? byQD.get(`${k(o.quality)}|${k(o.design)}`) : byQ.get(k(o.quality));
    if (!pool || pool.free <= 0.5) continue;
    const can = Math.round(Math.min(need, pool.free) * 100) / 100;
    pool.free -= can;
    if (o.design) { const qq = byQ.get(k(o.quality)); if (qq) qq.free -= can; }
    const key = `allocate_order:${o.id}`;
    await suggest(q, {
      agent: 'allocation',
      kind: 'allocate_order',
      // Due within 3 days → worth a look now, not just "nice to have".
      severity: o.promise_date && (Date.parse(o.promise_date) - Date.now()) / 86_400_000 <= 3 ? 'warn' : 'info',
      title: `Allocate ${meters(can)} m ${o.quality}${o.design ? ` ${o.design}` : ''} to order #${o.id} (${o.party_name})?`,
      detail: can < need
        ? `Order needs ${meters(need)} m more; only ${meters(can)} m is free now.`
        : `Order needs ${meters(need)} m more; free stock covers it.`,
      payload: { order_id: o.id, meters: can },
      target: { type: 'order', id: o.id },
      actionLabel: 'Allocate',
      ownerOnly: false, // meters only; supervisors can reserve lots too
      dedupeKey: key,
    });
    allocate.push(key);
  }
  await resolveMissing(q, 'allocation', 'allocate_order', allocate);

  // Lots with more reserved than in stock (e.g. dispatched to someone else by hand).
  const r = await q(
    `SELECT a.lot_id, a.res, COALESCE(b.bal, 0) AS bal, a.orders
     FROM (SELECT lot_id, SUM(meters - dispatched_m) AS res, array_agg(DISTINCT order_id ORDER BY order_id) AS orders
           FROM allocations WHERE status = 'reserved' GROUP BY lot_id) a
     LEFT JOIN (SELECT lot_id, SUM(CASE WHEN direction = 'IN' THEN meters ELSE -meters END) AS bal FROM stock_movements GROUP BY lot_id) b ON b.lot_id = a.lot_id
     WHERE a.res > COALESCE(b.bal, 0) + 0.01`,
  );
  const over: string[] = [];
  for (const x of r.rows) {
    const key = `over_allocated:${x.lot_id}`;
    const orderList = (x.orders as number[]).map((id) => `#${id}`).join(', ');
    await suggest(q, {
      agent: 'allocation',
      kind: 'over_allocated',
      severity: 'bad',
      title: `Lot ${x.lot_id}: ${meters(Number(x.res))} m reserved but only ${meters(Math.max(0, Number(x.bal)))} m in stock`,
      detail: `Reserved for order ${orderList}. Release or move part of the reservation to another lot.`,
      payload: { lot_id: x.lot_id, reserved_m: Number(x.res), balance_m: Number(x.bal), order_ids: x.orders },
      target: { type: 'lot', id: x.lot_id },
      dedupeKey: key,
    });
    over.push(key);
  }
  await resolveMissing(q, 'allocation', 'over_allocated', over);
  return { allocate, over };
}

export const agent: AgentModule = {
  scan: async (q) => { await scanAllocation(q); },
  accept: async (s, q, actor) => {
    if (s.kind !== 'allocate_order') throw new LedgerError('Nothing to do for this one — dismiss it instead.');
    if (actor) {
      const u = await q(`SELECT role FROM users WHERE id = $1`, [actor]);
      // Same rule as the allocate API: owner and supervisors may reserve lots (meters only, no ₹).
      if (u.rows[0] && !['owner', 'supervisor', 'admin'].includes(u.rows[0].role)) throw new LedgerError('Only the owner or a supervisor can reserve fabric.', 403);
    }
    const orderId = Number(s.payload?.order_id);
    if (!Number.isInteger(orderId) || orderId <= 0) throw new LedgerError('This suggestion has no order.');
    const res = await autoAllocate(q, orderId, actor);
    if (!res.allocations.length) {
      throw new LedgerError(res.short_m > 0 ? `No free ${res.order.quality} stock left for order #${orderId}.` : `Order #${orderId} is already fully allocated.`);
    }
    const n = res.allocations.length;
    return `Allocated ${meters(res.allocated_m)} m from ${n} lot${n === 1 ? '' : 's'} to order #${orderId}${res.short_m > 0 ? ` — ${meters(res.short_m)} m still short` : ''}`;
  },
};
