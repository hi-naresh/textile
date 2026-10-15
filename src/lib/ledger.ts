// Stock ledger + lot location writes, shared by:
//   POST /api/stock (manual), POST /api/capture (AI auto-commit), POST /api/capture/confirm (review),
//   /api/job-cards (create / close) and /api/lots/location (manual move).
// Every function takes the transaction's `q` so callers control the transaction.

import { markAgentsStale } from './agents/stale';
import { trimReservations } from './stock';
import type { Q } from './db';
import { LedgerError } from './ledger-error';
import { allowedLocation, canonicalLotAttr, canonicalName, challanCode, dateValue, lotCode, lotStatusValue, metersValue, nameKey, nameValue, SYSTEM_LOCATIONS, type Place } from './normalize';
import { billedMetersValue, billPctValue, entryStatusValue, locCodeValue, lotStatusCodeValue, registerPctValue } from './registers';

export { LedgerError };
import { afterOutgoing } from './agents/hooks';
import { logError } from './errors';

export const DISPATCHED = SYSTEM_LOCATIONS.dispatched;
export type LocationStage = 'arrival' | 'job_card' | 'returned' | 'dispatch' | 'moved';

// ---------- small parsers ----------
const text = (v: unknown, max = 150): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
};

/** SR no. (paper-register serial): whole number above 0, or null when empty. */
export function srValue(v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const s = String(v).replace(/,/g, '').trim();
  const n = Number(s);
  if (!/^\d+(\.0+)?$/.test(s) || !Number.isSafeInteger(n) || n <= 0) throw new LedgerError(`SR no. must be a whole number above 0 (got "${String(v).trim().slice(0, 20)}").`);
  if (n > 2_000_000_000) throw new LedgerError(`SR no. ${n} is too large.`);
  return n;
}

/** Pieces ("taka"): whole number, 0 or more, or null when empty. */
export function piecesValue(v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const s = String(v).replace(/,/g, '').trim();
  const n = Number(s);
  if (!/^\d+(\.0+)?$/.test(s) || !Number.isSafeInteger(n)) throw new LedgerError(`Pieces (taka) must be a whole number, 0 or more (got "${String(v).trim().slice(0, 20)}").`);
  if (n > 1_000_000) throw new LedgerError(`Pieces (taka) ${n} looks too large. Check the number.`);
  return n;
}

const DIR_WORD = { IN: 'incoming', OUT: 'outgoing' } as const;

/** Next SR no. for a direction: last used + 1 (1 when none yet). */
export async function nextSr(q: Q, direction: 'IN' | 'OUT'): Promise<{ last: number | null; next: number }> {
  const r = await q(`SELECT MAX(sr_no) AS last FROM stock_movements WHERE direction = $1`, [direction]);
  const last = r.rows[0]?.last == null ? null : Number(r.rows[0].last);
  return { last, next: (last ?? 0) + 1 };
}

/** The entry already using this SR no. in this direction, if any. */
export async function srTaken(q: Q, direction: 'IN' | 'OUT', sr: number): Promise<{ lot_id: string; ts: string } | null> {
  const r = await q(`SELECT lot_id, to_char(ts, 'DD Mon YYYY') AS ts FROM stock_movements WHERE direction = $1 AND sr_no = $2 LIMIT 1`, [direction, sr]);
  return r.rows[0] ?? null;
}

async function assertSrFree(q: Q, direction: 'IN' | 'OUT', sr: number | null) {
  if (sr == null) return;
  const hit = await srTaken(q, direction, sr);
  if (!hit) return;
  const { next } = await nextSr(q, direction);
  throw new LedgerError(`SR no. ${sr} is already used on another ${DIR_WORD[direction]} entry (${hit.lot_id}, ${hit.ts}). Next free number: ${next}.`, 409);
}

export const importRef = (v: unknown): string | null => {
  const s = text(v, 60);
  if (s && !/^[A-Za-z0-9]{6,32}:\d{1,7}$/.test(s)) throw new LedgerError('Import reference is not valid.');
  return s;
};

// ---------- per-batch memo (Excel import: many rows in one transaction) ----------
/**
 * Optional cache shared by the rows of one import chunk: canonical spellings, location checks and the
 * "agents stale" flag are looked up once per chunk instead of once per row. Only pass it inside ONE transaction.
 */
export interface LedgerMemo { values: Map<string, unknown>; staleMarked: boolean }
export const newLedgerMemo = (): LedgerMemo => ({ values: new Map(), staleMarked: false });

async function memoised<T>(memo: LedgerMemo | undefined, key: string, fn: () => Promise<T>): Promise<T> {
  if (!memo) return fn();
  if (memo.values.has(key)) return memo.values.get(key) as T;
  const v = await fn();
  memo.values.set(key, v);
  return v;
}
export const nameMemo = (memo: LedgerMemo | undefined, q: Q, field: 'party' | 'mill_name' | 'weaver_name', v: string | null) =>
  v == null ? Promise.resolve(null) : memoised(memo, `name:${field === 'party' ? 'party' : 'mw'}:${nameKey(v)}`, () => canonicalName(q, field, v));
export const lotAttrMemo = (memo: LedgerMemo | undefined, q: Q, col: 'quality' | 'design', v: string | null) =>
  v == null ? Promise.resolve(null) : memoised(memo, `lot:${col}:${nameKey(v)}`, () => canonicalLotAttr(q, col, v));
export async function staleOnce(q: Q, memo: LedgerMemo | undefined) {
  if (memo?.staleMarked) return;
  await markAgentsStale(q);
  if (memo) memo.staleMarked = true;
}

// ---------- lookups ----------
async function lotBalance(q: Q, lotId: string): Promise<number> {
  const r = await q(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN meters ELSE -meters END), 0) AS balance
     FROM stock_movements WHERE lot_id = $1`,
    [lotId],
  );
  return parseFloat(r.rows[0].balance);
}

export async function currentLocation(q: Q, lotId: string): Promise<string | null> {
  const r = await q(`SELECT location FROM lot_locations WHERE lot_id = $1 ORDER BY ts DESC, id DESC LIMIT 1`, [lotId]);
  return r.rows[0]?.location ?? null;
}

/** Where a lot is (label + market parts when it is a market location); `exceptSystem`: the latest place that is not Floor / Dispatched. */
export async function currentPlace(q: Q, lotId: string, exceptSystem = false): Promise<StoredPlace | null> {
  const r = await q(
    `SELECT location, market_id, shop_no, pipe_no FROM lot_locations
      WHERE lot_id = $1${exceptSystem ? ` AND location NOT IN ('${SYSTEM_LOCATIONS.floor}', '${SYSTEM_LOCATIONS.dispatched}')` : ''}
      ORDER BY ts DESC, id DESC LIMIT 1`,
    [lotId],
  );
  const x = r.rows[0];
  return x ? { location: String(x.location), market_id: x.market_id == null ? null : Number(x.market_id), shop_no: x.shop_no ?? null, pipe_no: x.pipe_no == null ? null : Number(x.pipe_no) } : null;
}
/** A lot_locations label with its structured copy (NULL parts for system / older labels). */
export type StoredPlace = { location: string; market_id: number | null; shop_no: string | null; pipe_no: number | null };

export async function lockLot(q: Q, lotId: string) {
  // Serialises concurrent writes (e.g. two dispatches) against the same lot.
  const r = await q(`SELECT lot_id FROM lots WHERE lot_id = $1 FOR UPDATE`, [lotId]);
  return (r.rowCount ?? 0) > 0;
}

/** A closed lot (migration 016) takes no new entries, job cards or moves. Call after lockLot. */
export async function assertLotOpen(q: Q, lotId: string) {
  const r = await q(`SELECT closed_at FROM lots WHERE lot_id = $1`, [lotId]);
  if (r.rows[0]?.closed_at) throw new LedgerError(`Lot ${lotId} is closed. The owner can reopen it from Stock ledger → Lots & balance → Closed.`, 409);
}

// ---------- location ----------
export async function moveLot(
  q: Q,
  input: {
    lot_id: string; location: string; stage: LocationStage; note?: string | null; job_card_id?: number | null; stock_movement_id?: number | null; moved_by?: string | null;
    /** Market parts of the label (from allowedLocation / currentPlace); omitted for Floor / Dispatched. */
    place?: Pick<StoredPlace, 'market_id' | 'shop_no' | 'pipe_no'> | null;
    ts?: string | null;
  },
) {
  const location = text(input.location, 100);
  if (!location) throw new LedgerError('Location is required.');
  const p = input.place?.market_id != null ? input.place : null;
  const r = await q(
    `INSERT INTO lot_locations (lot_id, location, stage, note, job_card_id, stock_movement_id, moved_by, market_id, shop_no, pipe_no, ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::timestamp, CURRENT_TIMESTAMP)) RETURNING *`,
    [input.lot_id, location, input.stage, text(input.note, 500), input.job_card_id ?? null, input.stock_movement_id ?? null, input.moved_by ?? null,
      p?.market_id ?? null, p?.shop_no ?? null, p?.pipe_no ?? null, input.ts ?? null],
  );
  return r.rows[0];
}

/** Manual move from the UI (a market location only). `add_shops_by`: the caller may add a new shop no. to the market. */
export async function moveLotManually(q: Q, input: { lot_id: unknown; location: unknown; note?: unknown; moved_by?: unknown; add_shops_by?: string | null | false }) {
  const lotId = lotCode(input.lot_id)!;
  if (!(await lockLot(q, lotId))) throw new LedgerError(`Lot ${lotId} does not exist.`, 404);
  await assertLotOpen(q, lotId);
  const here = await currentLocation(q, lotId);
  const place = (await allowedLocation(q, input.location, { required: true, addShopsBy: input.add_shops_by ?? false }))!;
  if (here === place.location) throw new LedgerError(`${lotId} is already at ${place.location}.`);
  return moveLot(q, { lot_id: lotId, location: place.location, place, stage: 'moved', note: text(input.note, 500), moved_by: text(input.moved_by, 50) });
}

// ---------- incoming ----------
export interface IncomingInput {
  lot_id?: unknown;
  quality?: unknown;
  design?: unknown;
  grey_meters?: unknown;
  finished_meters?: unknown;
  meters?: unknown; // legacy: older photo reads / API callers
  mill_name?: unknown;
  weaver_name?: unknown;
  source_doc?: unknown;
  location?: unknown;
  purchase_rate?: unknown; // ₹/m grey purchase rate (Pu.Rate), for costing
  sr_no?: unknown; // paper-register serial, unique per direction
  pieces?: unknown; // taka
  import_ref?: unknown; // "<batch>:<row>" from an Excel import
  capture_event_id?: number | null;
  moved_by?: string | null;
  register_pct?: unknown; // Incoming register "%" (optional, meaning not confirmed)
  loc_code?: unknown; // Incoming register location code ("212", "142+143")
  date?: unknown; // back-date entry (YYYY-MM-DD or DD-MM-YYYY)
  /** Set by the server route, never from the request body: a new shop no. in `location` is added for this user (owner / supervisor). */
  add_shops_by?: string | null | false;
}

/**
 * Record incoming stock. Stock quantity (`meters`) = finished meters if given, else grey meters.
 * `requireLotDetails`: manual entry must name quality + design for a new lot; photo reads fall back to "Unknown".
 */
export async function recordIncoming(q: Q, input: IncomingInput, opts: { requireLotDetails: boolean; memo?: LedgerMemo }) {
  const memo = opts.memo;
  await staleOnce(q, memo);
  const lotId = lotCode(input.lot_id)!;
  const date = dateValue(input.date);
  const sr = srValue(input.sr_no);
  const pieces = piecesValue(input.pieces);
  const ref = importRef(input.import_ref);
  const grey = metersValue(input.grey_meters, 'Grey meters');
  const finished = metersValue(input.finished_meters, 'Finished meters');
  const legacy = metersValue(input.meters, 'Meters');
  const stockMeters = finished ?? legacy ?? grey;
  if (stockMeters == null) throw new LedgerError('Enter finished meters or grey meters.');
  if (grey != null && finished != null && finished > grey * 1.1) throw new LedgerError(`Finished meters (${finished}) can't be much more than grey meters (${grey}). Check the numbers.`);
  const mill = await nameMemo(memo, q, 'mill_name', nameValue(input.mill_name, 'Mill'));
  const weaver = await nameMemo(memo, q, 'weaver_name', nameValue(input.weaver_name, 'Weaver'));
  const challan = challanCode(input.source_doc);
  const pct = registerPctValue(input.register_pct);
  const locCode = locCodeValue(input.loc_code);
  const locKey = String(input.location ?? '').trim();
  const givenLocation: Place | null = await memoised(memo, `loc:${locKey}`, () => allowedLocation(q, input.location, { required: false, addShopsBy: input.add_shops_by ?? false }));
  await assertSrFree(q, 'IN', sr);

  const exists = await lockLot(q, lotId);
  if (exists) await assertLotOpen(q, lotId);
  if (!exists) {
    const quality = await lotAttrMemo(memo, q, 'quality', nameValue(input.quality, 'Quality'));
    const design = await lotAttrMemo(memo, q, 'design', nameValue(input.design, 'Design'));
    if (opts.requireLotDetails && (!quality || !design)) throw new LedgerError('Quality and design are required for a new lot.');
    await q(`INSERT INTO lots (lot_id, quality, design, grade, status, loc_code) VALUES ($1, $2, $3, 'A', 'active', $4)`, [lotId, quality ?? 'Unknown Quality', design ?? 'Unknown Design', locCode]);
  } else {
    if (locCode) {
      await q(`UPDATE lots SET loc_code = $2 WHERE lot_id = $1 AND loc_code IS DISTINCT FROM $2`, [lotId, locCode]);
    }
    // Re-activate a lot that was marked dispatched if new incoming stock arrives
    await q(`UPDATE lots SET status = 'active' WHERE lot_id = $1 AND status = 'dispatched'`, [lotId]);
  }

  const mv = await q(
    `INSERT INTO stock_movements (lot_id, direction, meters, grey_meters, finished_meters, mill_name, weaver_name, party, source_doc_id, capture_event_id, purchase_rate, sr_no, pieces, import_ref, register_pct, loc_code, ts)
     VALUES ($1, 'IN', $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10, $11, $12, $13, $14, COALESCE(($15::date + interval '12 hours'), CURRENT_TIMESTAMP)) RETURNING *`,
    [lotId, stockMeters, grey, finished ?? (grey == null ? legacy : null), mill, weaver, challan, input.capture_event_id ?? null, metersValue(input.purchase_rate, 'Purchase rate'), sr, pieces, ref, pct, locCode, date],
  );
  const movement = mv.rows[0];
  // No location given (e.g. a photo read): an existing lot stays where it is; a new lot (or one that was dispatched)
  // has no location until someone places it ("Not recorded" — the Stock agent lists lots with stock but no location).
  const here = exists && !givenLocation ? await currentPlace(q, lotId) : null;
  const place: StoredPlace | null = givenLocation ?? (here && here.location !== SYSTEM_LOCATIONS.dispatched ? here : null);
  if (place) await moveLot(q, {
    lot_id: lotId,
    location: place.location,
    place,
    stage: 'arrival',
    note: `${stockMeters} m received${challan ? ` on challan ${challan}` : ''}`,
    stock_movement_id: movement.id,
    moved_by: input.moved_by ?? null,
    ts: date ? `${date} 12:00:00` : null,
  });
  return movement;
}

// ---------- outgoing ----------
export interface OutgoingInput {
  lot_id?: unknown;
  meters?: unknown;
  party?: unknown;
  source_doc?: unknown;
  capture_event_id?: number | null;
  moved_by?: string | null;
  order_id?: number | null; // set when dispatched against a known order (Logistics agent)
  dispatch_id?: number | null; // truck / parcel grouping
  sr_no?: unknown;
  pieces?: unknown;
  import_ref?: unknown;
  bill_pct?: unknown; // sales register "L" (optional)
  billed_meters?: unknown; // sales register NQTY (optional)
  lot_status_code?: unknown; // sales register "LOT S" code (optional, data only)
  date?: unknown; // back-date entry (YYYY-MM-DD or DD-MM-YYYY)
  status?: unknown; // lot status ('active' | 'completed' | 'dispatched' | 'hold')
  entry_status?: unknown; // status of this entry: 'packed' | 'running' (default) | 'end' (migration 015)
}

/**
 * Record a dispatch. Party (destination client) is required.
 * `endAllowed`: the caller may mark the entry End (capability stock.end, checked by the route — never from the body).
 */
export async function recordOutgoing(q: Q, input: OutgoingInput, opts: { memo?: LedgerMemo; endAllowed?: boolean } = {}) {
  const memo = opts.memo;
  await staleOnce(q, memo);
  const lotId = lotCode(input.lot_id)!;
  const date = dateValue(input.date);
  const sr = srValue(input.sr_no);
  const pieces = piecesValue(input.pieces);
  const ref = importRef(input.import_ref);
  const meters = metersValue(input.meters, 'Meters');
  if (meters == null) throw new LedgerError('Meters are required.');
  const party = await nameMemo(memo, q, 'party', nameValue(input.party, 'Party'));
  const challan = challanCode(input.source_doc);
  const billPct = billPctValue(input.bill_pct);
  const billed = billedMetersValue(input.billed_meters);
  const statusCode = lotStatusCodeValue(input.lot_status_code);
  const explicitStatus = lotStatusValue(input.status);
  const entryStatus = entryStatusValue(input.entry_status) ?? 'running';
  if (entryStatus === 'end' && !opts.endAllowed) throw new LedgerError('You can’t mark an entry End. Ask the owner to switch it on for you, or choose Packed or Running.', 403);
  if (!party) throw new LedgerError('Party (the client receiving the goods) is required for outgoing stock.');
  await assertSrFree(q, 'OUT', sr);

  if (!(await lockLot(q, lotId))) throw new LedgerError(`Lot ${lotId} does not exist.`);
  await assertLotOpen(q, lotId);
  const balance = await lotBalance(q, lotId);

  const mv = await q(
    `INSERT INTO stock_movements (lot_id, direction, meters, party, source_doc_id, capture_event_id, order_id, dispatch_id, sr_no, pieces, import_ref, bill_pct, billed_meters, lot_status_code, entry_status, ts)
     VALUES ($1, 'OUT', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, COALESCE(($15::date + interval '12 hours'), CURRENT_TIMESTAMP)) RETURNING *`,
    [lotId, meters, party, challan, input.capture_event_id ?? null, input.order_id ?? null, input.dispatch_id ?? null, sr, pieces, ref, billPct, billed, statusCode, entryStatus, date],
  );
  const movement = mv.rows[0];
  // Logistics agent: link the dispatch to its order / allocation, update order status (same transaction).
  await afterOutgoing(q, movement, input.moved_by ?? null);
  // Stock that was reserved for an order but went out another way: shrink those reservations.
  await trimReservations(q, lotId);
  const remaining = Math.round((balance - meters) * 100) / 100;

  // Status update: if explicit status given, update it; otherwise if lot is emptied or over-dispatched (remaining <= 0), update to 'dispatched'
  if (explicitStatus) {
    await q(`UPDATE lots SET status = $2 WHERE lot_id = $1`, [lotId, explicitStatus]);
  } else if (remaining <= 0) {
    await q(`UPDATE lots SET status = 'dispatched' WHERE lot_id = $1`, [lotId]);
  }

  // Fully dispatched lots leave the premises; a partial dispatch keeps the rest where it is (no row when it has no location).
  const here = remaining <= 0 ? null : await currentPlace(q, lotId);
  if (remaining <= 0 || here) await moveLot(q, {
    lot_id: lotId,
    location: remaining <= 0 ? DISPATCHED : here!.location,
    place: remaining <= 0 ? null : here,
    stage: 'dispatch',
    note: `${meters} m to ${party}${remaining > 0 ? ` · ${remaining} m left` : remaining < 0 ? ` · ${remaining} m balance` : ''}`,
    stock_movement_id: movement.id,
    moved_by: input.moved_by ?? null,
    ts: date ? `${date} 12:00:00` : null,
  });
  // End = the last sale from this lot: close it (balance → 0 with a closing adjustment).
  if (entryStatus === 'end') await closeLot(q, lotId, { reason: 'end_entry', by: input.moved_by ?? null, endMovementId: Number(movement.id) });
  return movement;
}

// ---------- closing a lot (migration 016) ----------
export type CloseReason = 'end_entry' | 'manual' | 'register';
export interface LotClosed { lot_id: string; adjustment_m: number; movement_id: number | null }

/**
 * Close a lot: whatever its entries leave (or overshoot) is written off with a closing adjustment so the balance is
 * exactly 0, then the lot is marked closed (status completed) and leaves for "Dispatched".
 * `endMovementId`: the End entry that closes it — the adjustment and closed_at take that entry's time (back-dated
 * entries close on their own date). Without one (manual close) it is now, and the lot's last sale (if any) is marked
 * End so the ledger shows why it closed; reopening turns it back to Running. Run inside the caller's transaction.
 */
export async function closeLot(q: Q, lotId: string, o: { reason: CloseReason; by?: string | null; endMovementId?: number | null; note?: unknown }): Promise<LotClosed> {
  if (!(await lockLot(q, lotId))) throw new LedgerError(`Lot ${lotId} does not exist.`, 404);
  const cur = await q(`SELECT closed_at FROM lots WHERE lot_id = $1`, [lotId]);
  if (cur.rows[0].closed_at) throw new LedgerError(`Lot ${lotId} is already closed.`, 409);
  await markAgentsStale(q);
  const at = o.endMovementId
    ? ((await q(`SELECT to_char(ts, 'YYYY-MM-DD HH24:MI:SS.US') AS ts FROM stock_movements WHERE id = $1 AND lot_id = $2`, [o.endMovementId, lotId])).rows[0]?.ts as string | undefined) ?? null
    : null;
  let endId = o.endMovementId ?? null;
  if (!endId) {
    const last = (await q(
      `SELECT id, entry_status FROM stock_movements WHERE lot_id = $1 AND direction = 'OUT' AND kind = 'normal' ORDER BY ts DESC, id DESC LIMIT 1`, [lotId],
    )).rows[0] as { id: number; entry_status: string | null } | undefined;
    if (last) {
      endId = Number(last.id);
      if (last.entry_status !== 'end') {
        await q(`UPDATE stock_movements SET entry_status = 'end' WHERE id = $1`, [endId]);
        await q(`INSERT INTO ledger_edits (target, target_id, field, old_value, new_value, edited_by) VALUES ('movement', $1, 'entry_status', $2, 'end', $3)`,
          [String(endId), last.entry_status, o.by ?? null]);
      }
    }
  }
  const adjustment = Math.round((await lotBalance(q, lotId)) * 100) / 100;
  let movementId: number | null = null;
  if (Math.abs(adjustment) >= 0.01) {
    const mv = await q(
      `INSERT INTO stock_movements (lot_id, direction, meters, kind, ts) VALUES ($1, $2, $3, 'closing', COALESCE($4::timestamp, CURRENT_TIMESTAMP)) RETURNING id`,
      [lotId, adjustment > 0 ? 'OUT' : 'IN', Math.abs(adjustment), at],
    );
    movementId = Number(mv.rows[0].id);
  }
  const note = text(o.note, 500);
  await q(
    `UPDATE lots SET closed_at = COALESCE($2::timestamp, CURRENT_TIMESTAMP), closed_by = $3, close_reason = $4, close_note = $5, status = 'completed' WHERE lot_id = $1`,
    [lotId, at, o.by ?? null, o.reason, note],
  );
  await trimReservations(q, lotId); // nothing is left to keep aside for orders
  if ((await currentLocation(q, lotId)) !== DISPATCHED) {
    await moveLot(q, {
      lot_id: lotId, location: DISPATCHED, stage: 'dispatch', moved_by: o.by ?? null, ts: at,
      stock_movement_id: movementId ?? endId,
      note: `Lot closed${adjustment > 0 ? ` · ${adjustment} m left over written off` : adjustment < 0 ? ` · ${-adjustment} m over written back` : ''}`,
    });
  }
  await q(
    `INSERT INTO lot_closures (lot_id, action, reason, adjustment_m, movement_id, end_movement_id, by_user, note) VALUES ($1, 'close', $2, $3, $4, $5, $6, $7)`,
    [lotId, o.reason, adjustment, movementId, endId, o.by ?? null, note],
  );
  return { lot_id: lotId, adjustment_m: adjustment, movement_id: movementId };
}

/**
 * Reopen a closed lot: the closing adjustment is removed (its balance is what its entries leave again), the End entry
 * that closed it becomes Running (logged as an edit) — unless `keepEndEntry` is that entry, i.e. the caller is changing
 * it itself — and a lot with stock left goes back to its last place before it closed. Reservations trimmed when it
 * closed are not restored. Run inside the caller's transaction.
 */
export async function reopenLot(q: Q, lotId: string, o: { by?: string | null; note?: unknown; keepEndEntry?: number | null } = {}): Promise<{ lot_id: string; balance: number }> {
  if (!(await lockLot(q, lotId))) throw new LedgerError(`Lot ${lotId} does not exist.`, 404);
  const cur = await q(`SELECT closed_at FROM lots WHERE lot_id = $1`, [lotId]);
  if (!cur.rows[0].closed_at) throw new LedgerError(`Lot ${lotId} is not closed.`, 409);
  await markAgentsStale(q);
  const last = (await q(
    `SELECT reason, adjustment_m, end_movement_id FROM lot_closures WHERE lot_id = $1 AND action = 'close' ORDER BY id DESC LIMIT 1`, [lotId],
  )).rows[0] as { reason: CloseReason | null; adjustment_m: string; end_movement_id: number | null } | undefined;
  await q(`DELETE FROM stock_movements WHERE lot_id = $1 AND kind = 'closing'`, [lotId]);
  const endId = last?.end_movement_id ?? null;
  if (endId && endId !== o.keepEndEntry) {
    const up = await q(`UPDATE stock_movements SET entry_status = 'running' WHERE id = $1 AND entry_status = 'end' RETURNING id`, [endId]);
    if (up.rowCount) {
      await q(`INSERT INTO ledger_edits (target, target_id, field, old_value, new_value, edited_by) VALUES ('movement', $1, 'entry_status', 'end', 'running', $2)`, [String(endId), o.by ?? null]);
    }
  }
  const balance = Math.round((await lotBalance(q, lotId)) * 100) / 100;
  await q(
    `UPDATE lots SET closed_at = NULL, closed_by = NULL, close_reason = NULL, close_note = NULL, status = $2 WHERE lot_id = $1`,
    [lotId, balance > 0 ? 'active' : 'dispatched'],
  );
  if (balance > 0) {
    const place = await currentPlace(q, lotId, true);
    if (place) await moveLot(q, { lot_id: lotId, location: place.location, place, stage: 'moved', note: `Lot reopened · ${balance} m in stock`, moved_by: o.by ?? null });
  }
  await q(
    `INSERT INTO lot_closures (lot_id, action, reason, adjustment_m, end_movement_id, by_user, note) VALUES ($1, 'reopen', $2, $3, $4, $5, $6)`,
    [lotId, last?.reason ?? null, Number(last?.adjustment_m ?? 0), endId, o.by ?? null, text(o.note, 500)],
  );
  return { lot_id: lotId, balance };
}

// ---------- job cards ----------
export async function createJobCard(
  q: Q,
  input: { lot_id?: unknown; process?: unknown; worker_id?: unknown; meters_in?: unknown; shift?: unknown; moved_by?: string | null },
) {
  const lotId = lotCode(input.lot_id, false);
  const process = text(input.process, 100);
  const workerId = text(input.worker_id, 50);
  const metersIn = metersValue(input.meters_in, 'Meters');
  if (!lotId || !process || !workerId || metersIn == null) throw new LedgerError('Lot, process, worker and meters are required.');

  const w = await q('SELECT name FROM workers WHERE id = $1', [workerId]);
  if (!w.rowCount) throw new LedgerError(`Worker ${workerId} does not exist.`);
  if (!(await lockLot(q, lotId))) throw new LedgerError(`Lot ${lotId} does not exist.`);
  await assertLotOpen(q, lotId);

  const jc = await q(
    `INSERT INTO job_cards (lot_id, process, worker_id, meters_in, status) VALUES ($1, $2, $3, $4, 'in-process') RETURNING *`,
    [lotId, process, workerId, metersIn],
  );
  const card = jc.rows[0];
  await q(
    `INSERT INTO allotments (worker_id, job_card_id, meters_allotted, shift, date) VALUES ($1, $2, $3, $4, CURRENT_DATE)`,
    [workerId, card.id, metersIn, text(input.shift, 20) ?? 'Morning'],
  );
  await moveLot(q, { lot_id: lotId, location: SYSTEM_LOCATIONS.floor, stage: 'job_card', note: `JC-${card.id} · ${process} · ${w.rows[0].name}`, job_card_id: card.id, moved_by: input.moved_by ?? null });
  return card;
}

/** Close a job card with meters out, roll up the worker's day, and send the lot back to where it was before the floor when its last open card closes. */
export async function closeJobCard(q: Q, input: { id?: unknown; meters_out?: unknown; moved_by?: string | null }) {
  await markAgentsStale(q);
  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) throw new LedgerError('A valid job card id is required.');
  const metersOut = metersValue(input.meters_out, 'Meters out', { allowZero: true });
  if (metersOut == null) throw new LedgerError('Meters out is required.');

  const upd = await q(
    `UPDATE job_cards SET meters_out = $1, status = 'closed', ts_closed = NOW() WHERE id = $2 RETURNING *`,
    [metersOut, id],
  );
  if (!upd.rowCount) throw new LedgerError(`Job card ${id} not found.`, 404);
  const card = upd.rows[0];

  // Worker's efficiency for today across all of today's allotments.
  const sum = await q(
    `SELECT COALESCE(SUM(a.meters_allotted), 0) AS allotted,
            COALESCE(SUM(CASE WHEN jc.status = 'closed' THEN jc.meters_out ELSE 0 END), 0) AS done
     FROM allotments a JOIN job_cards jc ON jc.id = a.job_card_id
     WHERE a.worker_id = $1 AND a.date = CURRENT_DATE`,
    [card.worker_id],
  );
  const allotted = parseFloat(sum.rows[0].allotted);
  const done = parseFloat(sum.rows[0].done);
  const eff = allotted > 0 ? (done / allotted) * 100 : 0;
  const target = await q(`SELECT efficiency_target_pct FROM app_settings WHERE id = 1`);
  const targetPct = target.rows[0] ? parseFloat(target.rows[0].efficiency_target_pct) : 85;
  await q(
    `INSERT INTO efficiency_daily (worker_id, date, allotted, done, efficiency_pct, flagged)
     VALUES ($1, CURRENT_DATE, $2, $3, $4, $5)
     ON CONFLICT (worker_id, date) DO UPDATE SET allotted = $2, done = $3, efficiency_pct = $4, flagged = $5`,
    [card.worker_id, allotted, done, Math.min(eff, 999.99), eff < targetPct],
  );

  const open = await q(`SELECT 1 FROM job_cards WHERE lot_id = $1 AND status <> 'closed' LIMIT 1`, [card.lot_id]);
  if (!open.rowCount) {
    // Back to its place before the floor (its last location that is not Floor / Dispatched). A lot that never had one
    // stays on "Floor" until someone moves it.
    const back = (await currentLocation(q, card.lot_id)) === SYSTEM_LOCATIONS.floor ? await currentPlace(q, card.lot_id, true) : null;
    if (back) await moveLot(q, { lot_id: card.lot_id, location: back.location, place: back, stage: 'returned', note: `JC-${id} closed · ${metersOut} m out`, job_card_id: id, moved_by: input.moved_by ?? null });
  }

  const metersIn = parseFloat(card.meters_in);
  const shortage = metersIn - metersOut;
  return { ...card, meters_in: metersIn, meters_out: metersOut, shortage, shortage_pct: metersIn > 0 ? (shortage / metersIn) * 100 : 0 };
}

/** Find the open job card for a folding read when the photo had no card number. */
export async function resolveOpenJobCard(q: Q, jobCardId: unknown, lotId: unknown): Promise<number | null> {
  const id = Number(jobCardId);
  if (Number.isInteger(id) && id > 0) return id;
  const lot = lotCode(lotId, false);
  if (!lot) return null;
  const r = await q(`SELECT id FROM job_cards WHERE lot_id = $1 AND status IN ('open', 'in-process') ORDER BY ts_created DESC LIMIT 1`, [lot]);
  return r.rows[0]?.id ?? null;
}

// ---------- photo reads ----------
export type CaptureType = 'incoming_stock' | 'outgoing_stock' | 'job_card_folding';

/**
 * Apply a confirmed photo read to the ledger (used by AI auto-commit and by review confirm).
 * Returns the data as saved (e.g. with the resolved job card id).
 */
export async function applyCaptureRead(
  q: Q, type: CaptureType, data: Record<string, unknown>, eventId: number, actor: string | null,
  opts: { location?: unknown; addShopsBy?: string | null | false } = {},
) {
  if (type === 'incoming_stock') {
    // Reads taken before 26 Sep 2026 stored the supplier as `party`; treat it as the mill.
    const legacy = !data.mill_name && data.party ? { mill_name: data.party } : {};
    // Location: only what the reviewer picked on confirm (a photo read never sets one by itself).
    await recordIncoming(q, { ...data, ...legacy, location: opts.location ?? null, add_shops_by: opts.addShopsBy ?? false, import_ref: null, capture_event_id: eventId, moved_by: actor }, { requireLotDetails: false });
    return opts.location ? { ...data, location: String(opts.location) } : data;
  }
  if (type === 'outgoing_stock') {
    await recordOutgoing(q, { ...data, import_ref: null, capture_event_id: eventId, moved_by: actor });
    return data;
  }
  const jobCardId = await resolveOpenJobCard(q, data.job_card_id, data.lot_id);
  if (!jobCardId) throw new LedgerError('Job card number is missing and no open card was found for this lot.');
  await closeJobCard(q, { id: jobCardId, meters_out: data.meters_out, moved_by: actor });
  return { ...data, job_card_id: jobCardId };
}

export function errorResponseBody(err: unknown): { status: number; body: { error: string } } {
  if (err instanceof LedgerError) return { status: err.status, body: { error: err.message } };
  if (err instanceof SyntaxError) return { status: 400, body: { error: 'The request body is not valid JSON.' } };
  // Postgres rejected the input itself (NUL byte, bad number / date text): the caller's mistake, not a server fault.
  const code = (err as { code?: string } | null)?.code;
  // Two saves raced for the same SR no. / import row: the unique index caught it.
  if (code === '23505') {
    const c = (err as { constraint?: string }).constraint;
    if (c === 'stock_movements_sr_unique') return { status: 409, body: { error: 'That SR no. was just used by another entry. Use the next number.' } };
    if (c === 'stock_movements_import_ref_unique') return { status: 409, body: { error: 'These rows were already imported.' } };
  }
  if (code === '22021' || code === '22P05' || code === '22P02' || code === '22003' || code === '22007' || code === '22008') {
    return { status: 400, body: { error: 'Some of the values sent are not valid.' } };
  }
  logError('api', err);
  return { status: 500, body: { error: 'Something went wrong, try again. Nothing was changed.' } };
}
