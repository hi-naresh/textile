// Order Management agent — deterministic, no LLM. One card per order that is late, or due in the next
// DUE_SOON_DAYS days and not ready. It says what is still to send, how much of that quality is free, and —
// when free stock exists and not everything is kept aside — offers "Keep N m aside", naming the lots it
// will reserve (the same greedy pick as autoAllocate: fewest lots, oldest stock first).
// This replaces the old Allocation "Allocate X m to order #N?" cards (same order, two cards, no reason given).
// Orders themselves are created and edited through /api/orders (src/lib/sales/orders.ts).
import type { Q } from '../db';
import type { AgentModule } from './types';
import { resolveMissing, suggest } from './suggest';
import { listOrders, remainingNeed, type OrderRow } from '../sales/orders';
import { autoAllocate, pickLots } from '../sales/allocate';
import type { LotStock } from '../stock';
import { LedgerError } from '../ledger-error';
import { daysBetween, meters, round2, todayIST } from '../sales/util';

export const DUE_SOON_DAYS = 3;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dm = (iso: string) => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}`;
const lc = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
/** Cloth is rarely cut to the exact meter: under 2% (min 0.5 m) left counts as done. */
const tol = (o: OrderRow) => Math.max(0.5, o.meters * 0.02);

function whenText(days: number, iso: string): string {
  if (days < 0) return `is ${-days} day${days === -1 ? '' : 's'} late (was due ${dm(iso)})`;
  if (days === 0) return 'is due today';
  if (days === 1) return `is due tomorrow (${dm(iso)})`;
  return `is due in ${days} days (${dm(iso)})`;
}

/** Lots of these qualities with free stock (balance − kept aside > 0), oldest stock first. Only the qualities asked for. */
async function freeLots(q: Q, qualities: string[]): Promise<LotStock[]> {
  if (!qualities.length) return [];
  const r = await q(
    `SELECT l.lot_id, l.quality, l.design, b.bal AS balance, COALESCE(a.res, 0) AS reserved, b.last_move
     FROM lots l
     JOIN LATERAL (SELECT SUM(CASE WHEN sm.direction = 'IN' THEN sm.meters ELSE -sm.meters END) AS bal, MAX(sm.ts) AS last_move
                   FROM stock_movements sm WHERE sm.lot_id = l.lot_id) b ON true
     LEFT JOIN LATERAL (SELECT SUM(al.meters - al.dispatched_m) AS res FROM allocations al
                        WHERE al.lot_id = l.lot_id AND al.status = 'reserved') a ON true
     WHERE lower(l.quality) = ANY($1::text[]) AND b.bal - COALESCE(a.res, 0) > 0.001
     ORDER BY b.last_move NULLS LAST, l.lot_id`,
    [qualities],
  );
  return r.rows.map((x) => {
    const balance = Number(x.balance);
    const reserved = Number(x.reserved);
    return { lot_id: String(x.lot_id), quality: String(x.quality), design: String(x.design ?? ''), balance, reserved, free: round2(balance - reserved), location: null, last_move: x.last_move ? String(x.last_move) : null };
  });
}

export async function scanOrders(q: Q, today = todayIST()): Promise<{ due: string[]; overdue: string[] }> {
  const orders = await listOrders(q, { status: 'open', role: 'owner', limit: 1000, sort: 'promise' });
  const hot = orders.filter((o) => o.promise_date && daysBetween(today, o.promise_date) <= DUE_SOON_DAYS);
  // Free stock is shared: orders are served in promise-date order and later ones only see what is left.
  const lots = await freeLots(q, [...new Set(hot.map((o) => lc(o.quality)))]);
  const due: string[] = [];
  const overdue: string[] = [];
  for (const o of hot) {
    const days = daysBetween(today, o.promise_date!);
    const late = days < 0;
    const toSend = round2(o.meters - o.dispatched_m);
    const need = remainingNeed(o); // not sent and not kept aside
    if (toSend <= tol(o)) continue; // sent (the status catches up on the next dispatch)
    if (!late && need <= tol(o)) continue; // due soon but everything is kept aside: nothing to do yet

    const what = `${o.quality}${o.design ? ` ${o.design}` : ''}`;
    const pool = lots.filter((l) => lc(l.quality) === lc(o.quality) && (!o.design || lc(l.design) === lc(o.design)) && l.free > 0.001);
    const freeM = round2(pool.reduce((s, l) => s + l.free, 0));
    const picks = need > tol(o) ? pickLots(pool, need) : [];
    for (const p of picks) p.lot.free = round2(p.lot.free - p.meters);
    const canKeep = round2(picks.reduce((s, p) => s + p.meters, 0));

    const facts = [`Sent ${meters(o.dispatched_m)} of ${meters(o.meters)} m.`];
    if (o.reserved_m > 0) facts.push(`${meters(o.reserved_m)} m is already kept aside and ready to send.`);
    let hint: string | null = null;
    let actionLabel: string | null = null;
    if (need <= tol(o)) {
      facts.push('Everything left is kept aside.');
      hint = 'Send it from the Dispatch screen ("Use reserved lots" fills in the lots).';
    } else if (canKeep > 0) {
      const lotList = picks.slice(0, 4).map((p) => `${p.lot.lot_id} (${meters(p.meters)} m)`).join(', ') + (picks.length > 4 ? ` + ${picks.length - 4} more` : '');
      facts.push(canKeep < need
        ? `Only ${meters(canKeep)} m of ${what} is free — ${meters(round2(need - canKeep))} m short. Buy or process more, or tell the party.`
        : `${meters(need)} m is not kept aside yet. You have ${meters(freeM)} m of ${what} free.`);
      actionLabel = `Keep ${meters(canKeep)} m aside`;
      hint = `"${actionLabel}" reserves lot${picks.length === 1 ? '' : 's'} ${lotList} for this order, so ${picks.length === 1 ? 'it isn\'t' : 'they aren\'t'} sold to anyone else and Dispatch fills ${picks.length === 1 ? 'it' : 'them'} in for you.`;
    } else {
      facts.push(`No free ${what} in stock — ${meters(need)} m short. Buy or process more, or tell the party.`);
    }

    const key = `${late ? 'order_overdue' : 'order_due'}:${o.id}`;
    await suggest(q, {
      agent: 'orders',
      kind: late ? 'order_overdue' : 'order_due',
      severity: late ? 'bad' : 'warn',
      title: `Order #${o.id} for ${o.party_name} ${whenText(days, o.promise_date!)} — ${meters(toSend)} m ${what} still to send`,
      detail: facts.join(' '),
      hint,
      payload: { order_id: o.id, to_send_m: toSend, need_m: need, free_m: freeM, promise_date: o.promise_date, lots: picks.map((p) => ({ lot_id: p.lot.lot_id, meters: p.meters })) },
      target: { type: 'order', id: o.id },
      actionLabel,
      ownerOnly: false, // meters only; supervisors can keep lots aside too (orders.allocate)
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
  accept: async (s, q, actor) => {
    if (actor) {
      const u = await q(`SELECT role FROM users WHERE id = $1`, [actor]);
      // Same rule as the allocate API: owner and supervisors may keep lots aside (meters only, no ₹).
      if (u.rows[0] && !['owner', 'supervisor', 'admin'].includes(u.rows[0].role)) throw new LedgerError('Only the owner or a supervisor can keep fabric aside.', 403);
    }
    const orderId = Number(s.payload?.order_id);
    if (!Number.isInteger(orderId) || orderId <= 0) throw new LedgerError('This card has no order.');
    const res = await autoAllocate(q, orderId, actor);
    if (!res.allocations.length) {
      throw new LedgerError(res.short_m > 0 ? `No free ${res.order.quality} left to keep aside for order #${orderId}.` : `Everything for order #${orderId} is already kept aside.`);
    }
    const list = res.allocations.map((a) => `${a.lot_id} ${meters(a.meters)} m`).join(', ');
    return `Kept ${meters(res.allocated_m)} m aside for order #${orderId}: ${list}${res.short_m > 0 ? ` — still ${meters(res.short_m)} m short` : ''}`;
  },
};
