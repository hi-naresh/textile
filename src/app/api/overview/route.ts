import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { can } from '@/lib/access';
import { requireCap } from '@/lib/apiAuth';
import { creditSummary, creditTotals } from '@/lib/money/credit';
import { respond } from '@/lib/money/http';
import { todayIST } from '@/lib/sales/util';

// GET → the few figures the owner's home screen shows that no other request already gives (one small request).
// { orders: { open, open_m, late, due_today, due_week }, money: { outstanding, overdue, parties_overdue } | null }
// money (₹) is only sent to the owner with finance access; supervisors get null.
export async function GET(req: NextRequest) {
  return respond(async () => {
    const actor = await requireCap(req, 'orders.view');
    const today = todayIST();
    const o = await query(
      `SELECT COUNT(*)::int AS open,
              COALESCE(SUM(GREATEST(o.meters - COALESCE(d.m, 0), 0)), 0) AS open_m,
              COUNT(*) FILTER (WHERE o.promise_date < $1::date)::int AS late,
              COUNT(*) FILTER (WHERE o.promise_date = $1::date)::int AS due_today,
              COUNT(*) FILTER (WHERE o.promise_date > $1::date AND o.promise_date <= $1::date + 7)::int AS due_week
       FROM orders o
       LEFT JOIN (SELECT order_id, SUM(meters) AS m FROM stock_movements WHERE direction = 'OUT' AND order_id IS NOT NULL GROUP BY order_id) d ON d.order_id = o.id
       WHERE o.status IN ('open', 'partly_dispatched')`,
      [today],
    );
    const r = o.rows[0];
    let money: { outstanding: number; overdue: number; parties_overdue: number } | null = null;
    if (actor.role === 'owner' && can('owner', 'finance.view')) {
      const t = await creditTotals(query, await creditSummary(query));
      money = { outstanding: t.outstanding, overdue: t.overdue, parties_overdue: t.parties_overdue };
    }
    return {
      orders: { open: Number(r.open), open_m: Math.round(Number(r.open_m) * 10) / 10, late: Number(r.late), due_today: Number(r.due_today), due_week: Number(r.due_week) },
      money,
    };
  });
}
