// Logistics & Dispatch agent — hook on every OUT movement (manual, photo read, import or dispatch
// screen), inside the dispatch's own transaction. Links the movement to its order and updates the
// order's status. It runs inside a SAVEPOINT: a failing agent never breaks the dispatch itself.
import type { Q } from '../db';
import { nameKey } from '../normalize';
import { refreshOrderStatus } from '../orderStatus';
import { suggest } from './suggest';

export interface OrderCandidate {
  id: number; party_name: string; quality: string; meters: number; dispatched: number; promise_date: string | null; has_alloc: boolean;
}

/** Open / partly dispatched orders of the movement's party with the lot's quality, best match first. */
export async function orderCandidates(q: Q, m: { lot_id: string; party: string; meters: number; id?: number }): Promise<{ quality: string | null; candidates: OrderCandidate[] }> {
  const lot = await q(`SELECT quality FROM lots WHERE lot_id = $1`, [m.lot_id]);
  const quality: string | null = lot.rows[0]?.quality ?? null;
  const key = nameKey(m.party || '');
  if (!quality || !key) return { quality, candidates: [] };
  const r = await q(
    `SELECT o.id, p.name AS party_name, o.quality, o.meters, to_char(o.promise_date, 'YYYY-MM-DD') AS promise_date,
            COALESCE((SELECT SUM(sm.meters) FROM stock_movements sm WHERE sm.direction = 'OUT' AND sm.order_id = o.id AND sm.id IS DISTINCT FROM $4), 0) AS dispatched,
            EXISTS (SELECT 1 FROM allocations a WHERE a.order_id = o.id AND a.lot_id = $3 AND a.status = 'reserved') AS has_alloc
     FROM orders o JOIN parties p ON p.id = o.party_id
     WHERE p.name_key = $1 AND lower(btrim(o.quality)) = lower(btrim($2)) AND o.status IN ('open', 'partly_dispatched')`,
    [key, quality, m.lot_id, m.id ?? null],
  );
  const c: OrderCandidate[] = r.rows.map((x) => ({
    id: Number(x.id), party_name: x.party_name, quality: x.quality, meters: Number(x.meters), dispatched: Number(x.dispatched),
    promise_date: x.promise_date, has_alloc: !!x.has_alloc,
  }));
  // Allocation on this lot first, then the order whose remaining meters are closest, then the earliest promise date.
  const gap = (o: OrderCandidate) => Math.abs(o.meters - o.dispatched - m.meters);
  c.sort((a, b) => Number(b.has_alloc) - Number(a.has_alloc) || gap(a) - gap(b) || (a.promise_date ?? '9999').localeCompare(b.promise_date ?? '9999') || a.id - b.id);
  return { quality, candidates: c };
}

export function matchSuggestion(m: { id: number; lot_id: string; party: string; meters: number }, c: OrderCandidate[]) {
  const best = c[0];
  const fmtM = (n: number) => `${n.toLocaleString('en-IN', { maximumFractionDigits: 1 })} m`;
  return {
    agent: 'logistics' as const,
    kind: 'match_dispatch',
    severity: 'warn' as const,
    title: `${fmtM(m.meters)} of ${m.lot_id} went to ${m.party} — which order?`,
    detail: `Open ${best.quality} orders for ${m.party}: ${c.slice(0, 4).map((o) => `#${o.id} (${fmtM(o.meters - o.dispatched)} left${o.promise_date ? `, due ${o.promise_date}` : ''}${o.has_alloc ? ', lot reserved' : ''})`).join('; ')}${c.length > 4 ? '…' : ''}.`,
    payload: { movement_id: m.id, order_id: best.id, candidates: c.map((o) => o.id) },
    target: { type: 'order', id: best.id },
    actionLabel: `Link to order #${best.id}`,
    dedupeKey: `match_dispatch:${m.id}`,
  };
}

/** Put a movement on an order (and its dispatch, when the dispatch has none) and refresh the order status. */
export async function linkMovement(q: Q, movementId: number, orderId: number): Promise<void> {
  await q(`UPDATE stock_movements SET order_id = $2 WHERE id = $1`, [movementId, orderId]);
  await q(
    `UPDATE dispatches d SET order_id = $2 FROM stock_movements sm
     WHERE sm.id = $1 AND d.id = sm.dispatch_id AND d.order_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM stock_movements x WHERE x.dispatch_id = d.id AND x.order_id IS NOT NULL AND x.order_id <> $2)`,
    [movementId, orderId],
  );
  await refreshOrderStatus(q, orderId);
}

async function handle(q: Q, mv: Record<string, unknown>): Promise<void> {
  const m = { id: Number(mv.id), lot_id: String(mv.lot_id ?? ''), party: String(mv.party ?? ''), meters: Number(mv.meters) };
  const orderId = mv.order_id == null ? null : Number(mv.order_id);
  const key = nameKey(m.party);

  // Lot reserved for a different party's order?
  const other = await q(
    `SELECT a.order_id, p.name AS party_name FROM allocations a JOIN orders o ON o.id = a.order_id JOIN parties p ON p.id = o.party_id
     WHERE a.lot_id = $1 AND a.status = 'reserved' AND p.name_key <> $2 AND o.status IN ('open', 'partly_dispatched')
     ORDER BY a.id LIMIT 3`,
    [m.lot_id, key],
  );
  if (other.rows.length) {
    const list = other.rows.map((x) => `order #${x.order_id} (${x.party_name})`).join(', ');
    await suggest(q, {
      agent: 'logistics', kind: 'reserved_for_other', severity: 'warn',
      title: `${m.lot_id} was reserved for ${list} but ${m.meters} m went to ${m.party}`,
      detail: 'Check the reservation: release it, or reserve another lot for that order.',
      payload: { movement_id: m.id, lot_id: m.lot_id, order_ids: other.rows.map((x) => Number(x.order_id)) },
      target: { type: 'order', id: Number(other.rows[0].order_id) },
      dedupeKey: `reserved_for_other:${m.id}`,
    });
  }

  if (orderId) {
    await refreshOrderStatus(q, orderId);
    return;
  }
  const { candidates } = await orderCandidates(q, m);
  if (!candidates.length) return;
  const withAlloc = candidates.filter((c) => c.has_alloc);
  if (candidates.length === 1 || withAlloc.length === 1) {
    await linkMovement(q, m.id, (withAlloc.length === 1 ? withAlloc[0] : candidates[0]).id);
    return;
  }
  await suggest(q, matchSuggestion(m, candidates));
}

export async function onOutgoing(q: Q, movement: Record<string, unknown>, actor: string | null): Promise<void> {
  void actor;
  let savepoint = true;
  try {
    await q('SAVEPOINT agent_hook');
  } catch (e) {
    // Not inside a transaction: nothing to protect, run unguarded but never throw.
    savepoint = false;
    console.error('[logistics] no transaction around the dispatch hook', e);
  }
  try {
    await handle(q, movement);
    if (savepoint) await q('RELEASE SAVEPOINT agent_hook');
  } catch (e) {
    console.error('[logistics] dispatch hook failed (dispatch kept)', e);
    if (savepoint) {
      try {
        await q('ROLLBACK TO SAVEPOINT agent_hook');
        await q('RELEASE SAVEPOINT agent_hook');
      } catch (e2) {
        console.error('[logistics] savepoint rollback failed', e2);
      }
    }
  }
}
