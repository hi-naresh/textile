// Free stock = balance − meters reserved for orders (active allocations). Shared by the
// Allocation, Inquiry, Inventory and Order agents so they all agree on "available".
import type { Q } from './db';

export interface LotStock { lot_id: string; quality: string; design: string; balance: number; reserved: number; free: number; location: string | null; last_move: string | null }

const LOTS_SQL = `
  SELECT l.lot_id, l.quality, l.design,
         COALESCE(b.bal, 0) AS balance,
         COALESCE(a.res, 0) AS reserved,
         (SELECT location FROM lot_locations WHERE lot_id = l.lot_id ORDER BY ts DESC, id DESC LIMIT 1) AS location,
         b.last_move
  FROM lots l
  LEFT JOIN (SELECT lot_id, SUM(CASE WHEN direction = 'IN' THEN meters ELSE -meters END) AS bal, MAX(ts) AS last_move FROM stock_movements GROUP BY lot_id) b ON b.lot_id = l.lot_id
  LEFT JOIN (SELECT lot_id, SUM(meters - dispatched_m) AS res FROM allocations WHERE status = 'reserved' GROUP BY lot_id) a ON a.lot_id = l.lot_id`;

const toLot = (r: Record<string, unknown>): LotStock => {
  const balance = Number(r.balance);
  const reserved = Number(r.reserved);
  return { lot_id: String(r.lot_id), quality: String(r.quality), design: String(r.design), balance, reserved, free: Math.round((balance - reserved) * 100) / 100, location: (r.location as string) ?? null, last_move: r.last_move ? String(r.last_move) : null };
};

/** Lots of a quality (case-insensitive) with free stock > 0, oldest stock first. */
export async function freeLotsForQuality(q: Q, quality: string, design?: string | null): Promise<LotStock[]> {
  const r = await q(
    `SELECT * FROM (${LOTS_SQL}) x
     WHERE lower(x.quality) = lower($1) AND ($2::text IS NULL OR lower(x.design) = lower($2)) AND x.balance - x.reserved > 0
     ORDER BY x.last_move NULLS LAST, x.lot_id`,
    [quality, design ?? null],
  );
  return r.rows.map(toLot);
}

export async function lotStock(q: Q, lotId: string): Promise<LotStock | null> {
  const r = await q(`SELECT * FROM (${LOTS_SQL}) x WHERE x.lot_id = $1`, [lotId]);
  return r.rows[0] ? toLot(r.rows[0]) : null;
}

/** Every lot with a positive balance (for inventory scans). */
export async function allLotStock(q: Q): Promise<LotStock[]> {
  const r = await q(`SELECT * FROM (${LOTS_SQL}) x WHERE x.balance > 0 ORDER BY x.quality, x.lot_id`);
  return r.rows.map(toLot);
}

/** Free meters per quality. */
export async function freeByQuality(q: Q): Promise<{ quality: string; balance: number; reserved: number; free: number }[]> {
  const r = await q(
    `SELECT quality, SUM(balance) AS balance, SUM(reserved) AS reserved FROM (${LOTS_SQL}) x WHERE x.balance > 0 GROUP BY quality ORDER BY quality`,
  );
  return r.rows.map((x) => ({ quality: x.quality, balance: Number(x.balance), reserved: Number(x.reserved), free: Math.round((Number(x.balance) - Number(x.reserved)) * 100) / 100 }));
}

/**
 * Keep "reserved ≤ balance" true after an OUT that did not come out of a reservation (a photo-read
 * challan, a manual entry, another party's dispatch): the newest reservations on the lot shrink first.
 * Returns the orders whose reservation was cut, so callers can tell someone.
 */
export async function trimReservations(q: Q, lotId: string): Promise<{ order_id: number; cut: number }[]> {
  const s = await lotStock(q, lotId);
  if (!s || s.reserved <= Math.max(0, s.balance) + 0.001) return [];
  let excess = Math.round((s.reserved - Math.max(0, s.balance)) * 100) / 100;
  const rows = await q(
    `SELECT id, order_id, meters, dispatched_m FROM allocations
     WHERE lot_id = $1 AND status = 'reserved' ORDER BY created_at DESC, id DESC FOR UPDATE`,
    [lotId],
  );
  const out: { order_id: number; cut: number }[] = [];
  for (const r of rows.rows) {
    if (excess <= 0) break;
    const open = Number(r.meters) - Number(r.dispatched_m);
    const cut = Math.min(open, excess);
    if (cut <= 0) continue;
    if (cut >= open - 0.001) {
      if (Number(r.dispatched_m) > 0) await q(`UPDATE allocations SET meters = dispatched_m, status = 'dispatched' WHERE id = $1`, [r.id]);
      else await q(`UPDATE allocations SET status = 'released' WHERE id = $1`, [r.id]);
    } else {
      await q(`UPDATE allocations SET meters = meters - $2 WHERE id = $1`, [r.id, cut]);
    }
    out.push({ order_id: Number(r.order_id), cut: Math.round(cut * 100) / 100 });
    excess = Math.round((excess - cut) * 100) / 100;
  }
  return out;
}

/** Meters reserved on a lot for orders other than the given ones. */
export async function reservedForOthers(q: Q, lotId: string, orderIds: number[]): Promise<{ meters: number; orders: number[] }> {
  const r = await q(
    `SELECT order_id, SUM(meters - dispatched_m) AS m FROM allocations
     WHERE lot_id = $1 AND status = 'reserved' AND NOT (order_id = ANY($2::int[])) GROUP BY order_id ORDER BY order_id`,
    [lotId, orderIds],
  );
  return { meters: Math.round(r.rows.reduce((s, x) => s + Number(x.m), 0) * 100) / 100, orders: r.rows.map((x) => Number(x.order_id)) };
}
