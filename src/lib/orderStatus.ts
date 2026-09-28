// Order status from what has actually been dispatched against it. Shared by the Order,
// Allocation and Logistics agents. Call after anything that changes an order's dispatches.
import type { Q } from './db';

export async function refreshOrderStatus(q: Q, orderId: number): Promise<{ status: string; dispatched: number; meters: number } | null> {
  const o = await q(`SELECT id, meters, status FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
  if (!o.rows[0]) return null;
  const meters = Number(o.rows[0].meters);
  const d = await q(`SELECT COALESCE(SUM(meters), 0) AS m FROM stock_movements WHERE direction = 'OUT' AND order_id = $1`, [orderId]);
  const dispatched = Number(d.rows[0].m);
  // Allocations: what went out from each reserved lot for this order.
  await q(
    `UPDATE allocations a SET dispatched_m = LEAST(a.meters, COALESCE(x.m, 0)),
            status = CASE WHEN a.status = 'released' THEN 'released' WHEN COALESCE(x.m, 0) >= a.meters THEN 'dispatched' ELSE 'reserved' END
     FROM (SELECT a2.id, (SELECT SUM(sm.meters) FROM stock_movements sm WHERE sm.direction = 'OUT' AND sm.order_id = a2.order_id AND sm.lot_id = a2.lot_id) AS m
           FROM allocations a2 WHERE a2.order_id = $1) x
     WHERE a.id = x.id`,
    [orderId],
  );
  if (o.rows[0].status === 'cancelled') return { status: 'cancelled', dispatched, meters };
  // 2% tolerance: cloth is rarely cut to the exact meter.
  const status = dispatched <= 0 ? 'open' : dispatched >= meters * 0.98 ? 'dispatched' : 'partly_dispatched';
  await q(`UPDATE orders SET status = $2, updated_at = NOW() WHERE id = $1`, [orderId, status]);
  if (status === 'dispatched') await q(`UPDATE allocations SET status = 'released' WHERE order_id = $1 AND status = 'reserved'`, [orderId]);
  return { status, dispatched, meters };
}
