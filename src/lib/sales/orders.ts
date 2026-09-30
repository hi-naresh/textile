// Orders: fixed queries + validated writes. Used by /api/orders*, inquiry conversion and the agents.
import { markAgentsStale } from '../agents/stale';
import type { Q } from '../db';
import { LedgerError } from '../ledger-error';
import { canonicalLotAttr, metersValue, nameValue } from '../normalize';
import { partyById, partyByName } from '../parties';
import { refreshOrderStatus } from '../orderStatus';
import type { Allocation, Order } from '../domain';
import type { Role } from '../access';
import { dateValue, idValue, knownActor, num, rateValue, round2, todayIST } from './util';

export type OrderRow = Order & { party_phone: string | null; reserved_m: number; free_m?: number };
export type AllocationRow = Allocation & { quality: string; design: string };

export const ORDER_STATUSES = ['open', 'partly_dispatched', 'dispatched', 'cancelled'] as const;

// allocated_m = still-reserved meters + meters already dispatched against the order.
const ORDER_SQL = `
  SELECT o.id, o.party_id, p.name AS party_name, p.phone AS party_phone, o.quality, o.design, o.meters, o.rate_per_m,
         to_char(o.promise_date, 'YYYY-MM-DD') AS promise_date, o.status, o.inquiry_id, o.notes, o.created_at,
         COALESCE(a.res, 0) AS reserved_m, COALESCE(d.m, 0) AS dispatched_m
  FROM orders o
  JOIN parties p ON p.id = o.party_id
  LEFT JOIN (SELECT order_id, SUM(meters - dispatched_m) AS res FROM allocations WHERE status = 'reserved' GROUP BY order_id) a ON a.order_id = o.id
  LEFT JOIN (SELECT order_id, SUM(meters) AS m FROM stock_movements WHERE direction = 'OUT' AND order_id IS NOT NULL GROUP BY order_id) d ON d.order_id = o.id`;

export function toOrder(r: Record<string, unknown>, role: Role): OrderRow {
  const reserved = round2(Number(r.reserved_m));
  const dispatched = round2(Number(r.dispatched_m));
  return {
    id: Number(r.id), party_id: Number(r.party_id), party_name: String(r.party_name), party_phone: (r.party_phone as string) || null,
    quality: String(r.quality), design: (r.design as string) ?? null, meters: Number(r.meters),
    rate_per_m: role === 'owner' ? num(r.rate_per_m) : null,
    promise_date: (r.promise_date as string) ?? null, status: r.status as Order['status'],
    allocated_m: round2(reserved + dispatched), dispatched_m: dispatched, reserved_m: reserved,
    inquiry_id: num(r.inquiry_id), notes: (r.notes as string) ?? null, created_at: String(r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at),
  };
}

/** Meters the order still needs covered: meters − dispatched − still reserved. */
export const remainingNeed = (o: Pick<OrderRow, 'meters' | 'allocated_m'>) => round2(Math.max(0, o.meters - o.allocated_m));

/**
 * status filter: comma list of statuses. "open" means still open for dispatch (open + partly dispatched);
 * "all" or empty = everything.
 * sort: 'newest' (default, what people see: newest order first) or 'promise' (open first, earliest promise
 * date first — the order the allocation agent serves them in).
 */
export async function listOrders(q: Q, f: { status?: string | null; party_id?: unknown; role: Role; limit?: number; sort?: 'newest' | 'promise' }): Promise<OrderRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const st = (f.status ?? '').trim();
  if (st && st !== 'all') {
    const want = new Set<string>();
    for (const s of st.split(',').map((x) => x.trim())) {
      if (s === 'open' || s === 'active') { want.add('open'); want.add('partly_dispatched'); }
      else if ((ORDER_STATUSES as readonly string[]).includes(s)) want.add(s);
      else throw new LedgerError(`Unknown order status "${s}".`);
    }
    params.push([...want]);
    where.push(`o.status = ANY($${params.length}::text[])`);
  }
  if (f.party_id !== undefined && f.party_id !== null && f.party_id !== '') {
    params.push(idValue(f.party_id, 'party'));
    where.push(`o.party_id = $${params.length}`);
  }
  params.push(Math.min(Math.max(f.limit ?? 300, 1), 1000));
  const r = await q(
    `${ORDER_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ${f.sort === 'promise'
       ? `CASE WHEN o.status IN ('open', 'partly_dispatched') THEN 0 ELSE 1 END, o.promise_date NULLS LAST, o.id DESC`
       : 'o.created_at DESC, o.id DESC'}
     LIMIT $${params.length}`,
    params,
  );
  return r.rows.map((x) => toOrder(x, f.role));
}

export async function getOrder(q: Q, id: unknown, role: Role): Promise<OrderRow> {
  const oid = idValue(id, 'order');
  const r = await q(`${ORDER_SQL} WHERE o.id = $1`, [oid]);
  if (!r.rows[0]) throw new LedgerError(`Order #${oid} not found.`, 404);
  return toOrder(r.rows[0], role);
}

export async function orderAllocations(q: Q, orderId: number): Promise<AllocationRow[]> {
  const r = await q(
    `SELECT a.id, a.order_id, a.lot_id, a.meters, a.dispatched_m, a.status, a.created_at, l.quality, l.design
     FROM allocations a JOIN lots l ON l.lot_id = a.lot_id WHERE a.order_id = $1
     ORDER BY CASE a.status WHEN 'reserved' THEN 0 WHEN 'dispatched' THEN 1 ELSE 2 END, a.id`,
    [orderId],
  );
  return r.rows.map((x) => ({
    id: Number(x.id), order_id: Number(x.order_id), lot_id: x.lot_id, meters: Number(x.meters), dispatched_m: Number(x.dispatched_m),
    status: x.status, created_at: x.created_at instanceof Date ? x.created_at.toISOString() : String(x.created_at), quality: x.quality, design: x.design,
  }));
}

async function qualityKnown(q: Q, quality: string): Promise<boolean> {
  const r = await q(`SELECT 1 FROM lots WHERE lower(quality) = lower($1) LIMIT 1`, [quality]);
  return !!r.rows[0];
}

async function resolveParty(q: Q, b: Record<string, unknown>): Promise<{ id: number; name: string }> {
  if (b.party_id !== undefined && b.party_id !== null && b.party_id !== '') {
    const p = await partyById(q, b.party_id);
    return { id: p.id, name: p.name };
  }
  const p = await partyByName(q, b.party ?? b.party_name, true);
  if (!p) throw new LedgerError('Party is required.');
  return p;
}

export interface OrderInput {
  party?: unknown; party_name?: unknown; party_id?: unknown; quality?: unknown; design?: unknown; meters?: unknown;
  rate_per_m?: unknown; promise_date?: unknown; notes?: unknown; inquiry_id?: number | null;
}

/** Create an order (owner). Unknown quality is allowed with a warning (stock may not have arrived yet). */
export async function createOrder(q: Q, b: OrderInput, actorRaw: string | null): Promise<{ order: OrderRow; warnings: string[] }> {
  await markAgentsStale(q);
  const warnings: string[] = [];
  const party = await resolveParty(q, b as Record<string, unknown>);
  const qualityIn = nameValue(b.quality, 'Quality');
  if (!qualityIn) throw new LedgerError('Quality is required.');
  const quality = (await canonicalLotAttr(q, 'quality', qualityIn)) ?? qualityIn;
  if (!(await qualityKnown(q, quality))) warnings.push(`No lots of "${quality}" in stock records yet — check the spelling.`);
  const designIn = nameValue(b.design, 'Design');
  const design = designIn ? (await canonicalLotAttr(q, 'design', designIn)) ?? designIn : null;
  const meters = metersValue(b.meters, 'Meters');
  if (meters == null) throw new LedgerError('Meters is required.');
  // Every party gets its own rate: it is typed on each order (no rate list to fall back on).
  const rate = rateValue(b.rate_per_m, 'Rate');
  if (rate == null) warnings.push('No rate on this order yet. Add it before making the invoice.');
  const promise = dateValue(b.promise_date, 'Promise date');
  if (promise && promise < todayIST()) throw new LedgerError('Promise date is in the past.');
  const notes = b.notes == null || b.notes === '' ? null : String(b.notes).trim().slice(0, 500) || null;
  const actor = await knownActor(q, actorRaw);
  const ins = await q(
    `INSERT INTO orders (party_id, quality, design, meters, rate_per_m, promise_date, inquiry_id, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [party.id, quality, design, meters, rate, promise, b.inquiry_id ?? null, notes, actor],
  );
  const order = await getOrder(q, ins.rows[0].id, 'owner');
  return { order, warnings };
}

/** Release every still-reserved allocation of an order. Returns meters released. */
export async function releaseOrderAllocations(q: Q, orderId: number): Promise<number> {
  const r = await q(
    `UPDATE allocations SET status = 'released' WHERE order_id = $1 AND status = 'reserved' RETURNING meters - dispatched_m AS m`,
    [orderId],
  );
  return round2(r.rows.reduce((s, x) => s + Number(x.m), 0));
}

/** Edit an order or cancel it (owner). */
export async function updateOrder(q: Q, id: unknown, b: Record<string, unknown>): Promise<{ order: OrderRow; message: string; warnings: string[] }> {
  await markAgentsStale(q);
  const oid = idValue(id, 'order');
  const cur = await q(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [oid]);
  const o = cur.rows[0];
  if (!o) throw new LedgerError(`Order #${oid} not found.`, 404);
  const warnings: string[] = [];

  if (b.status !== undefined && b.status !== o.status) {
    if (b.status !== 'cancelled') throw new LedgerError('Status changes by itself from dispatches. You can only cancel an order.');
    if (o.status === 'dispatched') throw new LedgerError('This order is already dispatched and cannot be cancelled.');
    const released = await releaseOrderAllocations(q, oid);
    await q(`UPDATE orders SET status = 'cancelled', notes = COALESCE($2, notes), updated_at = NOW() WHERE id = $1`, [oid, typeof b.notes === 'string' && b.notes.trim() ? b.notes.trim().slice(0, 500) : null]);
    const order = await getOrder(q, oid, 'owner');
    return { order, message: `Order #${oid} cancelled${released > 0 ? ` — ${released} m released back to stock` : ''}.`, warnings };
  }
  if (o.status === 'cancelled') throw new LedgerError('This order is cancelled and cannot be edited.');

  const sets: string[] = [];
  const params: unknown[] = [oid];
  const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined;

  const activeAlloc = await q(`SELECT COUNT(*) AS n FROM allocations WHERE order_id = $1 AND status = 'reserved'`, [oid]);
  const hasActive = Number(activeAlloc.rows[0].n) > 0;

  if (has('party_id') || has('party')) {
    const p = await resolveParty(q, b);
    if (p.id !== o.party_id) set('party_id', p.id);
  }
  if (has('quality')) {
    const qi = nameValue(b.quality, 'Quality');
    if (!qi) throw new LedgerError('Quality is required.');
    const quality = (await canonicalLotAttr(q, 'quality', qi)) ?? qi;
    if (quality.toLowerCase() !== String(o.quality).toLowerCase()) {
      if (hasActive) throw new LedgerError('Release this order’s allocated lots before changing its quality.');
      if (!(await qualityKnown(q, quality))) warnings.push(`No lots of "${quality}" in stock records yet — check the spelling.`);
    }
    set('quality', quality);
  }
  if (has('design')) {
    const di = nameValue(b.design, 'Design');
    set('design', di ? (await canonicalLotAttr(q, 'design', di)) ?? di : null);
  }
  if (has('meters')) {
    const m = metersValue(b.meters, 'Meters');
    if (m == null) throw new LedgerError('Meters is required.');
    const d = await q(`SELECT COALESCE(SUM(meters), 0) AS m FROM stock_movements WHERE direction = 'OUT' AND order_id = $1`, [oid]);
    if (m < Number(d.rows[0].m) - 0.001) throw new LedgerError(`${Number(d.rows[0].m)} m already dispatched — meters cannot be less than that.`);
    set('meters', m);
  }
  if (has('rate_per_m')) set('rate_per_m', rateValue(b.rate_per_m, 'Rate'));
  if (has('promise_date')) set('promise_date', dateValue(b.promise_date, 'Promise date'));
  if (has('notes')) set('notes', b.notes == null || b.notes === '' ? null : String(b.notes).trim().slice(0, 500) || null);
  if (!sets.length) throw new LedgerError('Nothing to change.');
  await q(`UPDATE orders SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, params);
  await refreshOrderStatus(q, oid);
  const order = await getOrder(q, oid, 'owner');
  if (order.reserved_m > 0 && order.allocated_m > order.meters + 0.01) warnings.push(`${round2(order.allocated_m - order.meters)} m more is reserved than the order needs — release a lot.`);
  return { order, message: `Order #${oid} updated.`, warnings };
}
