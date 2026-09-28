// Fabric allocation: reserve lots for an order. Deterministic greedy match —
// same quality (and design if the order names one), free stock only, fewest lots, oldest stock first.
import { markAgentsStale } from '../agents/stale';
import type { Q } from '../db';
import { LedgerError } from '../ledger-error';
import { metersValue } from '../normalize';
import { freeLotsForQuality, lotStock, type LotStock } from '../stock';
import { refreshOrderStatus } from '../orderStatus';
import { getOrder, remainingNeed, type OrderRow } from './orders';
import { idValue, knownActor, round2 } from './util';

export interface AllocateResult { allocations: { id: number; lot_id: string; meters: number }[]; allocated_m: number; short_m: number; order: OrderRow }

async function lockOpenOrder(q: Q, orderId: number): Promise<OrderRow> {
  const lock = await q(`SELECT id, status FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
  if (!lock.rows[0]) throw new LedgerError(`Order #${orderId} not found.`, 404);
  await refreshOrderStatus(q, orderId);
  const o = await getOrder(q, orderId, 'owner');
  if (o.status === 'cancelled') throw new LedgerError(`Order #${orderId} is cancelled.`);
  if (o.status === 'dispatched') throw new LedgerError(`Order #${orderId} is already dispatched.`);
  return o;
}

/** Lock the lots so two allocations at once can't reserve the same free meters. */
async function lockLots(q: Q, lotIds: string[]): Promise<void> {
  if (lotIds.length) await q(`SELECT lot_id FROM lots WHERE lot_id = ANY($1::text[]) ORDER BY lot_id FOR UPDATE`, [lotIds]);
}

/**
 * Pick lots: the fewest lots that cover the need; among those, the oldest stock first.
 * (k = lots needed when taking the biggest first; then walk oldest-first, keeping only picks
 * that still let the remaining need be covered by k − picked lots.)
 */
export function pickLots(lots: LotStock[], need: number): { lot: LotStock; meters: number }[] {
  const pool = lots.filter((l) => l.free > 0.001);
  if (need <= 0 || !pool.length) return [];
  const bySize = [...pool].sort((a, b) => b.free - a.free);
  let k = 0;
  let acc = 0;
  while (k < bySize.length && acc < need - 0.001) { acc += bySize[k].free; k++; }
  const canCover = (rest: LotStock[], slots: number, needLeft: number) =>
    needLeft <= 0.001 || [...rest].sort((a, b) => b.free - a.free).slice(0, slots).reduce((s, l) => s + l.free, 0) >= needLeft - 0.001;
  const picks: { lot: LotStock; meters: number }[] = [];
  let remaining = need;
  let available = [...pool]; // already oldest first
  while (remaining > 0.001 && picks.length < k && available.length) {
    const slotsAfter = k - picks.length - 1;
    const choice = available.find((l) => canCover(available.filter((x) => x !== l), slotsAfter, remaining - l.free)) ?? available[0];
    const take = round2(Math.min(choice.free, remaining));
    picks.push({ lot: choice, meters: take });
    remaining = round2(remaining - take);
    available = available.filter((x) => x !== choice);
  }
  return picks;
}

async function reserve(q: Q, orderId: number, lotId: string, meters: number, actor: string | null): Promise<{ id: number; lot_id: string; meters: number }> {
  // Top up an existing reservation of the same lot for this order instead of adding a second row.
  const ex = await q(`SELECT id FROM allocations WHERE order_id = $1 AND lot_id = $2 AND status = 'reserved' ORDER BY id LIMIT 1`, [orderId, lotId]);
  if (ex.rows[0]) {
    const u = await q(`UPDATE allocations SET meters = meters + $2 WHERE id = $1 RETURNING id`, [ex.rows[0].id, meters]);
    return { id: Number(u.rows[0].id), lot_id: lotId, meters };
  }
  const ins = await q(
    `INSERT INTO allocations (order_id, lot_id, meters, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [orderId, lotId, meters, actor],
  );
  return { id: Number(ins.rows[0].id), lot_id: lotId, meters };
}

/** Reserve free lots for whatever the order still needs. Safe to call repeatedly. */
export async function autoAllocate(q: Q, orderId: number, actorRaw: string | null): Promise<AllocateResult> {
  await markAgentsStale(q);
  const o = await lockOpenOrder(q, orderId);
  const need = remainingNeed(o);
  if (need <= 0) return { allocations: [], allocated_m: 0, short_m: 0, order: o };
  const first = await freeLotsForQuality(q, o.quality, o.design);
  await lockLots(q, first.map((l) => l.lot_id));
  const lots = await freeLotsForQuality(q, o.quality, o.design); // re-read after the lock
  const actor = await knownActor(q, actorRaw);
  const out: AllocateResult['allocations'] = [];
  for (const p of pickLots(lots, need)) out.push(await reserve(q, orderId, p.lot.lot_id, p.meters, actor));
  const allocated = round2(out.reduce((s, a) => s + a.meters, 0));
  const order = await getOrder(q, orderId, 'owner');
  return { allocations: out, allocated_m: allocated, short_m: round2(Math.max(0, need - allocated)), order };
}

/** Reserve a chosen lot for an order (owner). */
export async function manualAllocate(q: Q, orderId: number, lotIdRaw: unknown, metersRaw: unknown, actorRaw: string | null): Promise<AllocateResult> {
  await markAgentsStale(q);
  const lotId = typeof lotIdRaw === 'string' ? lotIdRaw.trim() : '';
  if (!lotId) throw new LedgerError('Pick a lot.');
  const meters = metersValue(metersRaw, 'Meters');
  if (meters == null) throw new LedgerError('Meters is required.');
  const o = await lockOpenOrder(q, orderId);
  await lockLots(q, [lotId]);
  const lot = await lotStock(q, lotId);
  if (!lot) throw new LedgerError(`Lot ${lotId} not found.`, 404);
  if (lot.quality.toLowerCase() !== o.quality.toLowerCase()) throw new LedgerError(`Lot ${lotId} is ${lot.quality}, but the order is for ${o.quality}.`);
  if (meters > lot.free + 0.001) throw new LedgerError(`Only ${Math.max(0, lot.free)} m of lot ${lotId} is free (${lot.balance} m in stock, ${lot.reserved} m already reserved).`);
  const need = remainingNeed(o);
  if (need <= 0) throw new LedgerError(`Order #${orderId} is already fully allocated.`);
  if (meters > need + 0.001) throw new LedgerError(`Order #${orderId} needs only ${need} m more.`);
  const a = await reserve(q, orderId, lotId, meters, await knownActor(q, actorRaw));
  const order = await getOrder(q, orderId, 'owner');
  return { allocations: [a], allocated_m: meters, short_m: round2(Math.max(0, need - meters)), order };
}

/** Release one reservation (owner). Anything already dispatched from it stays counted on the order. */
export async function releaseAllocation(q: Q, idRaw: unknown): Promise<{ id: number; order_id: number; lot_id: string; released_m: number }> {
  await markAgentsStale(q);
  const id = idValue(idRaw, 'allocation');
  const r = await q(`SELECT id, order_id, lot_id, meters, dispatched_m, status FROM allocations WHERE id = $1 FOR UPDATE`, [id]);
  const a = r.rows[0];
  if (!a) throw new LedgerError('Allocation not found.', 404);
  if (a.status !== 'reserved') throw new LedgerError(`This allocation is already ${a.status}.`);
  await q(`UPDATE allocations SET status = 'released' WHERE id = $1`, [id]);
  return { id, order_id: Number(a.order_id), lot_id: a.lot_id, released_m: round2(Number(a.meters) - Number(a.dispatched_m)) };
}

/** Lots that could fill an order: same quality with free stock; same design first. */
export async function allocationCandidates(q: Q, orderId: unknown): Promise<{ order: OrderRow; need_m: number; lots: (LotStock & { design_match: boolean })[] }> {
  const o = await getOrder(q, orderId, 'owner');
  const lots = await freeLotsForQuality(q, o.quality);
  const dm = (l: LotStock) => !o.design || l.design.toLowerCase() === o.design.toLowerCase();
  const sorted = [...lots].sort((a, b) => Number(dm(b)) - Number(dm(a)));
  return { order: o, need_m: remainingNeed(o), lots: sorted.map((l) => ({ ...l, design_match: dm(l) })) };
}
