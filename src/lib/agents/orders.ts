// Order Management agent — deterministic. Flags open orders close to (or past) their promise date
// that don't have enough fabric allocated or dispatched yet. Orders themselves are created and
// edited through /api/orders (src/lib/sales/orders.ts).
import type { Q } from '../db';
import type { AgentModule } from './types';
import { resolveMissing, suggest } from './suggest';
import { listOrders } from '../sales/orders';
import { daysBetween, meters, todayIST } from '../sales/util';

const DUE_WITHIN_DAYS = 2;

function whenText(days: number): string {
  if (days < 0) return `${-days} day${days === -1 ? '' : 's'} late`;
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  return `due in ${days} days`;
}

export async function scanOrders(q: Q, today = todayIST()): Promise<{ due: string[]; overdue: string[] }> {
  const orders = await listOrders(q, { status: 'open', role: 'owner', limit: 1000 });
  const due: string[] = [];
  const overdue: string[] = [];
  for (const o of orders) {
    if (!o.promise_date) continue;
    const days = daysBetween(today, o.promise_date);
    if (days > DUE_WITHIN_DAYS) continue;
    const short = Math.round((o.meters - o.allocated_m) * 100) / 100;
    if (short <= Math.max(0.5, o.meters * 0.02)) continue; // enough reserved / dispatched (2% cutting tolerance)
    const late = days < 0;
    const key = `${late ? 'order_overdue' : 'order_due'}:${o.id}`;
    const pct = o.meters > 0 ? Math.round((o.allocated_m / o.meters) * 100) : 0;
    await suggest(q, {
      agent: 'orders',
      kind: late ? 'order_overdue' : 'order_due',
      severity: late ? 'bad' : 'warn',
      title: `Order #${o.id} for ${o.party_name} ${late ? 'is ' : ''}${whenText(days)} — ${meters(short)} m not ready`,
      detail: `${o.quality}${o.design ? ` ${o.design}` : ''}: ${meters(o.meters)} m ordered, ${meters(o.dispatched_m)} m dispatched, ${meters(o.reserved_m)} m reserved (${pct}% covered). Promised for ${o.promise_date}.`,
      payload: { order_id: o.id, short_m: short, promise_date: o.promise_date },
      target: { type: 'order', id: o.id },
      dedupeKey: key,
    });
    (late ? overdue : due).push(key);
  }
  await resolveMissing(q, 'orders', 'order_due', due);
  await resolveMissing(q, 'orders', 'order_overdue', overdue);
  return { due, overdue };
}

export const agent: AgentModule = {
  scan: async (q) => { await scanOrders(q); },
};
