// Stock ledger + lot location writes, shared by:
//   POST /api/stock (manual), POST /api/capture (AI auto-commit), POST /api/capture/confirm (review),
//   /api/job-cards (create / close) and /api/lots/location (manual move).
// Every function takes the transaction's `q` so callers control the transaction.

import type { Q } from './db';

export class LedgerError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const LOCATION_PRESETS = ['Godown', 'Shop', 'Floor'] as const;
export const DISPATCHED = 'Dispatched';
export type LocationStage = 'arrival' | 'job_card' | 'returned' | 'dispatch' | 'moved';

// ---------- small parsers ----------
const text = (v: unknown, max = 150): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
};

/** Positive number or null. Throws on a value that is present but invalid. */
const positive = (v: unknown, label: string): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) throw new LedgerError(`${label} must be a positive number.`);
  return Math.round(n * 100) / 100;
};

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

async function lockLot(q: Q, lotId: string) {
  // Serialises concurrent writes (e.g. two dispatches) against the same lot.
  const r = await q(`SELECT lot_id FROM lots WHERE lot_id = $1 FOR UPDATE`, [lotId]);
  return (r.rowCount ?? 0) > 0;
}

// ---------- location ----------
export async function moveLot(
  q: Q,
  input: { lot_id: string; location: string; stage: LocationStage; note?: string | null; job_card_id?: number | null; stock_movement_id?: number | null; moved_by?: string | null },
) {
  const location = text(input.location, 100);
  if (!location) throw new LedgerError('Location is required.');
  const r = await q(
    `INSERT INTO lot_locations (lot_id, location, stage, note, job_card_id, stock_movement_id, moved_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [input.lot_id, location, input.stage, text(input.note, 500), input.job_card_id ?? null, input.stock_movement_id ?? null, input.moved_by ?? null],
  );
  return r.rows[0];
}

/** Manual move from the UI. */
export async function moveLotManually(q: Q, input: { lot_id: unknown; location: unknown; note?: unknown; moved_by?: unknown }) {
  const lotId = text(input.lot_id, 50);
  if (!lotId) throw new LedgerError('lot_id is required.');
  if (!(await lockLot(q, lotId))) throw new LedgerError(`Lot ${lotId} does not exist.`, 404);
  const location = text(input.location, 100);
  if (!location) throw new LedgerError('Location is required.');
  if ((await currentLocation(q, lotId)) === location) throw new LedgerError(`${lotId} is already at ${location}.`);
  return moveLot(q, { lot_id: lotId, location, stage: 'moved', note: text(input.note, 500), moved_by: text(input.moved_by, 50) });
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
  capture_event_id?: number | null;
  moved_by?: string | null;
}

/**
 * Record incoming stock. Stock quantity (`meters`) = finished meters if given, else grey meters.
 * `requireLotDetails`: manual entry must name quality + design for a new lot; photo reads fall back to "Unknown".
 */
export async function recordIncoming(q: Q, input: IncomingInput, opts: { requireLotDetails: boolean }) {
  const lotId = text(input.lot_id, 50);
  if (!lotId) throw new LedgerError('Lot number is required.');
  const grey = positive(input.grey_meters, 'Grey meters');
  const finished = positive(input.finished_meters, 'Finished meters');
  const legacy = positive(input.meters, 'Meters');
  const stockMeters = finished ?? legacy ?? grey;
  if (stockMeters == null) throw new LedgerError('Enter finished meters or grey meters.');

  const exists = await lockLot(q, lotId);
  if (!exists) {
    const quality = text(input.quality, 100);
    const design = text(input.design, 100);
    if (opts.requireLotDetails && (!quality || !design)) throw new LedgerError('Quality and design are required for a new lot.');
    await q(`INSERT INTO lots (lot_id, quality, design, grade, status) VALUES ($1, $2, $3, 'A', 'active')`, [lotId, quality ?? 'Unknown Quality', design ?? 'Unknown Design']);
  }

  const mv = await q(
    `INSERT INTO stock_movements (lot_id, direction, meters, grey_meters, finished_meters, mill_name, weaver_name, party, source_doc_id, capture_event_id)
     VALUES ($1, 'IN', $2, $3, $4, $5, $6, NULL, $7, $8) RETURNING *`,
    [lotId, stockMeters, grey, finished ?? (grey == null ? legacy : null), text(input.mill_name), text(input.weaver_name), text(input.source_doc, 100), input.capture_event_id ?? null],
  );
  const movement = mv.rows[0];
  const challan = text(input.source_doc, 100);
  // No location given (e.g. a photo read): a new lot lands in the godown; an existing lot stays where it is.
  const location = text(input.location, 100) ?? (exists ? await currentLocation(q, lotId) : null) ?? 'Godown';
  await moveLot(q, {
    lot_id: lotId,
    location,
    stage: 'arrival',
    note: `${stockMeters} m received${challan ? ` on challan ${challan}` : ''}`,
    stock_movement_id: movement.id,
    moved_by: input.moved_by ?? null,
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
}

/** Record a dispatch. Party (destination client) is required. */
export async function recordOutgoing(q: Q, input: OutgoingInput) {
  const lotId = text(input.lot_id, 50);
  if (!lotId) throw new LedgerError('Lot number is required.');
  const meters = positive(input.meters, 'Meters');
  if (meters == null) throw new LedgerError('Meters are required.');
  const party = text(input.party);
  if (!party) throw new LedgerError('Party (the client receiving the goods) is required for outgoing stock.');

  if (!(await lockLot(q, lotId))) throw new LedgerError(`Lot ${lotId} does not exist.`);
  const balance = await lotBalance(q, lotId);
  if (balance < meters) throw new LedgerError(`Insufficient stock. Lot ${lotId} has ${balance} m, dispatch asks for ${meters} m.`);

  const mv = await q(
    `INSERT INTO stock_movements (lot_id, direction, meters, party, source_doc_id, capture_event_id)
     VALUES ($1, 'OUT', $2, $3, $4, $5) RETURNING *`,
    [lotId, meters, party, text(input.source_doc, 100), input.capture_event_id ?? null],
  );
  const movement = mv.rows[0];
  const remaining = Math.round((balance - meters) * 100) / 100;
  const here = (await currentLocation(q, lotId)) ?? 'Godown';
  await moveLot(q, {
    lot_id: lotId,
    // Fully dispatched lots leave the premises; a partial dispatch keeps the rest where it is.
    location: remaining <= 0 ? DISPATCHED : here,
    stage: 'dispatch',
    note: `${meters} m to ${party}${remaining > 0 ? ` · ${remaining} m left` : ''}`,
    stock_movement_id: movement.id,
    moved_by: input.moved_by ?? null,
  });
  return movement;
}

// ---------- job cards ----------
export async function createJobCard(
  q: Q,
  input: { lot_id?: unknown; process?: unknown; worker_id?: unknown; meters_in?: unknown; shift?: unknown; moved_by?: string | null },
) {
  const lotId = text(input.lot_id, 50);
  const process = text(input.process, 100);
  const workerId = text(input.worker_id, 50);
  const metersIn = positive(input.meters_in, 'Meters');
  if (!lotId || !process || !workerId || metersIn == null) throw new LedgerError('Lot, process, worker and meters are required.');

  const w = await q('SELECT name FROM workers WHERE id = $1', [workerId]);
  if (!w.rowCount) throw new LedgerError(`Worker ${workerId} does not exist.`);
  if (!(await lockLot(q, lotId))) throw new LedgerError(`Lot ${lotId} does not exist.`);

  const jc = await q(
    `INSERT INTO job_cards (lot_id, process, worker_id, meters_in, status) VALUES ($1, $2, $3, $4, 'in-process') RETURNING *`,
    [lotId, process, workerId, metersIn],
  );
  const card = jc.rows[0];
  await q(
    `INSERT INTO allotments (worker_id, job_card_id, meters_allotted, shift, date) VALUES ($1, $2, $3, $4, CURRENT_DATE)`,
    [workerId, card.id, metersIn, text(input.shift, 20) ?? 'Morning'],
  );
  await moveLot(q, { lot_id: lotId, location: 'Floor', stage: 'job_card', note: `JC-${card.id} · ${process} · ${w.rows[0].name}`, job_card_id: card.id, moved_by: input.moved_by ?? null });
  return card;
}

/** Close a job card with meters out, roll up the worker's day, and send the lot back to the godown when its last open card closes. */
export async function closeJobCard(q: Q, input: { id?: unknown; meters_out?: unknown; moved_by?: string | null }) {
  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) throw new LedgerError('A valid job card id is required.');
  if (input.meters_out === null || input.meters_out === undefined || input.meters_out === '') throw new LedgerError('Meters out is required.');
  const metersOut = typeof input.meters_out === 'number' ? input.meters_out : parseFloat(String(input.meters_out));
  if (!Number.isFinite(metersOut) || metersOut < 0) throw new LedgerError('Meters out must be zero or more.');

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
    await moveLot(q, { lot_id: card.lot_id, location: 'Godown', stage: 'returned', note: `JC-${id} closed · ${metersOut} m out`, job_card_id: id, moved_by: input.moved_by ?? null });
  }

  const metersIn = parseFloat(card.meters_in);
  const shortage = metersIn - metersOut;
  return { ...card, meters_in: metersIn, meters_out: metersOut, shortage, shortage_pct: metersIn > 0 ? (shortage / metersIn) * 100 : 0 };
}

/** Find the open job card for a folding read when the photo had no card number. */
export async function resolveOpenJobCard(q: Q, jobCardId: unknown, lotId: unknown): Promise<number | null> {
  const id = Number(jobCardId);
  if (Number.isInteger(id) && id > 0) return id;
  const lot = text(lotId, 50);
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
export async function applyCaptureRead(q: Q, type: CaptureType, data: Record<string, unknown>, eventId: number, actor: string | null) {
  if (type === 'incoming_stock') {
    // Reads taken before 26 Sep 2026 stored the supplier as `party`; treat it as the mill.
    const legacy = !data.mill_name && data.party ? { mill_name: data.party } : {};
    await recordIncoming(q, { ...data, ...legacy, capture_event_id: eventId, moved_by: actor }, { requireLotDetails: false });
    return data;
  }
  if (type === 'outgoing_stock') {
    await recordOutgoing(q, { ...data, capture_event_id: eventId, moved_by: actor });
    return data;
  }
  const jobCardId = await resolveOpenJobCard(q, data.job_card_id, data.lot_id);
  if (!jobCardId) throw new LedgerError('Job card number is missing and no open card was found for this lot.');
  await closeJobCard(q, { id: jobCardId, meters_out: data.meters_out, moved_by: actor });
  return { ...data, job_card_id: jobCardId };
}

export function errorResponseBody(err: unknown): { status: number; body: { error: string } } {
  if (err instanceof LedgerError) return { status: err.status, body: { error: err.message } };
  console.error('[Ledger] Unexpected error', err);
  return { status: 500, body: { error: 'Something went wrong while saving. Nothing was changed.' } };
}
