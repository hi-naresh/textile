// Stock ledger edit mode (owner): PATCH /api/stock/edit applies a batch of cell edits in ONE transaction.
// Every change is validated first; if any is invalid nothing is saved (422 with one problem per bad cell).
// Each changed field writes one ledger_edits row (who, when, old → new). No-op changes are skipped.
import type { Q } from './db';
import { LedgerError } from './ledger-error';
import { piecesValue, srValue } from './ledger';
import { canonicalLotAttr, canonicalName, challanCode, nameValue } from './normalize';
import { billedMetersValue, billPctValue, locCodeValue, lotStatusCodeValue, registerPctValue } from './registers';
import { markAgentsStale } from './agents/stale';
import { ledgerRowsByIds, type LedgerRow } from './ledger-query';

export const MOVEMENT_FIELDS = ['sr_no', 'pieces', 'source_doc_id', 'mill_name', 'weaver_name', 'party', 'quality', 'design',
  'register_pct', 'loc_code', 'bill_pct', 'billed_meters', 'lot_status_code'] as const;
const IN_ONLY = ['mill_name', 'weaver_name', 'register_pct', 'loc_code'];
const OUT_ONLY = ['party', 'bill_pct', 'billed_meters', 'lot_status_code'];
export const LOT_FIELDS = ['quality', 'design', 'grade', 'status'] as const;
export const LOT_STATUSES = ['active', 'completed', 'dispatched', 'hold'] as const;
export const MAX_CHANGES = 500;

type MovementField = (typeof MOVEMENT_FIELDS)[number];
type LotField = (typeof LOT_FIELDS)[number];
type Value = string | number | null;

export type EditChange =
  | { target: 'movement'; id: number; field: MovementField; value: Value }
  | { target: 'lot'; id: string; field: LotField; value: Value };

export interface EditProblem { target: 'movement' | 'lot'; id: number | string; field: string; message: string }

/** Some changes are invalid: answer 422 with `problems`, nothing saved. */
export class EditProblems extends LedgerError {
  problems: EditProblem[];
  constructor(problems: EditProblem[]) {
    super(problems.length === 1 ? problems[0].message : `${problems.length} changes need fixing. Nothing was saved.`, 422);
    this.problems = problems;
  }
}

const FIELD_LABEL: Record<string, string> = {
  sr_no: 'SR no.', pieces: 'Pieces (taka)', source_doc_id: 'Challan no.', mill_name: 'Mill', weaver_name: 'Weaver',
  party: 'Party', quality: 'Quality', design: 'Design', grade: 'Grade', status: 'Status',
  register_pct: '%', loc_code: 'Location code', bill_pct: 'L', billed_meters: 'NQTY (billed meters)', lot_status_code: 'LOT S',
};

/** Structural check of the request body. Anything malformed (unknown field, bad id) → 400. */
export function parseChanges(body: Record<string, unknown>): EditChange[] {
  const raw = body.changes;
  if (!Array.isArray(raw) || raw.length === 0) throw new LedgerError('Send the changes to save.');
  if (raw.length > MAX_CHANGES) throw new LedgerError(`Save at most ${MAX_CHANGES} changes at a time (got ${raw.length}).`);
  return raw.map((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new LedgerError(`Change ${i + 1} is not valid.`);
    const { target, id, field, value } = c as Record<string, unknown>;
    if (value !== null && typeof value !== 'string' && typeof value !== 'number') throw new LedgerError(`Change ${i + 1}: value must be text, a number or null.`);
    if (typeof value === 'string' && value.length > 500) throw new LedgerError(`Change ${i + 1}: value is too long.`);
    if (target === 'movement') {
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new LedgerError(`Change ${i + 1}: movement id must be a whole number.`);
      if (!MOVEMENT_FIELDS.includes(field as MovementField)) throw new LedgerError(`Change ${i + 1}: "${String(field).slice(0, 40)}" can't be edited on a movement.`);
      return { target, id, field: field as MovementField, value: value as Value };
    }
    if (target === 'lot') {
      if (typeof id !== 'string' || !id.trim() || id.length > 50) throw new LedgerError(`Change ${i + 1}: lot id must be the lot number.`);
      if (!LOT_FIELDS.includes(field as LotField)) throw new LedgerError(`Change ${i + 1}: "${String(field).slice(0, 40)}" can't be edited on a lot.`);
      return { target, id: id.trim(), field: field as LotField, value: value as Value };
    }
    throw new LedgerError(`Change ${i + 1}: target must be "movement" or "lot".`);
  });
}

interface MovementRow {
  id: number; lot_id: string; direction: 'IN' | 'OUT'; kind: string; sr_no: number | null; pieces: number | null; source_doc_id: string | null; mill_name: string | null; weaver_name: string | null; party: string | null;
  register_pct: number | null; loc_code: string | null; bill_pct: number | null; billed_meters: number | null; lot_status_code: string | null;
}
interface LotRow { lot_id: string; quality: string; design: string; grade: string | null; status: string | null }
export interface EditedLot { lot_id: string; quality: string; design: string; grade: string | null; status: string | null }

const str = (v: unknown) => (v == null ? null : String(v));
const same = (a: unknown, b: unknown) => str(a) === str(b);

function gradeValue(v: Value): string {
  const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim().toUpperCase();
  if (!s) throw new LedgerError('Grade is required.');
  if (s.length > 10) throw new LedgerError('Grade must be 10 characters or fewer.');
  if (!/^[A-Z0-9][A-Z0-9 +\-/]*$/.test(s)) throw new LedgerError(`Grade "${s}" can only use letters, digits, "+", "-" and "/".`);
  return s;
}
function statusValue(v: Value): string {
  const s = v == null ? '' : String(v).trim().toLowerCase();
  if (!(LOT_STATUSES as readonly string[]).includes(s)) throw new LedgerError(`Status must be one of ${LOT_STATUSES.join(', ')}.`);
  return s;
}
function requiredName(v: Value, label: string): string {
  const s = nameValue(v, label);
  if (!s) throw new LedgerError(`${label} is required.`);
  return s;
}

/** Apply a batch of edits. Call inside a transaction. */
export async function applyLedgerEdits(q: Q, changes: EditChange[], by: string | null): Promise<{ saved: number; rows: LedgerRow[]; lots: EditedLot[] }> {
  const problems: EditProblem[] = [];
  const problem = (c: { target: 'movement' | 'lot'; id: number | string; field: string }, message: string) => {
    if (!problems.some((p) => p.target === c.target && p.id === c.id && p.field === c.field)) problems.push({ target: c.target, id: c.id, field: c.field, message });
  };

  // 1. Lock the rows (in a fixed order, so two saves can't deadlock).
  const mvIds = [...new Set(changes.filter((c) => c.target === 'movement').map((c) => c.id as number))].sort((a, b) => a - b);
  const mvRes = mvIds.length
    ? await q(`SELECT id, lot_id, direction, kind, sr_no, pieces, source_doc_id, mill_name, weaver_name, party, register_pct, loc_code, bill_pct, billed_meters, lot_status_code
                 FROM stock_movements WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`, [mvIds])
    : { rows: [] };
  const n = (v: unknown) => (v == null ? null : Number(v));
  const movements = new Map<number, MovementRow>(mvRes.rows.map((r) => [Number(r.id), {
    ...r, id: Number(r.id), sr_no: n(r.sr_no), pieces: n(r.pieces), register_pct: n(r.register_pct), bill_pct: n(r.bill_pct), billed_meters: n(r.billed_meters),
  } as MovementRow]));

  // Quality / design belong to the lot: a change on a movement row edits its lot.
  type LotChange = { lot: string; field: LotField; value: Value; origin: { target: 'movement' | 'lot'; id: number | string; field: string } };
  const lotChanges: LotChange[] = [];
  const mvChanges: { m: MovementRow; field: Exclude<MovementField, 'quality' | 'design'>; value: Value; origin: EditProblem }[] = [];
  for (const c of changes) {
    if (c.target === 'lot') { lotChanges.push({ lot: c.id, field: c.field, value: c.value, origin: { target: 'lot', id: c.id, field: c.field } }); continue; }
    const m = movements.get(c.id);
    if (!m) { problem(c, `Movement #${c.id} no longer exists. Reload the ledger.`); continue; }
    if (m.kind === 'adjustment') { problem(c, 'Opening adjustments (from the Incoming register) can’t be edited.'); continue; }
    if (c.field === 'quality' || c.field === 'design') lotChanges.push({ lot: m.lot_id, field: c.field, value: c.value, origin: { target: 'movement', id: c.id, field: c.field } });
    else mvChanges.push({ m, field: c.field, value: c.value, origin: { target: 'movement', id: c.id, field: c.field, message: '' } });
  }

  const lotIds = [...new Set(lotChanges.map((c) => c.lot))].sort();
  const lotRes = lotIds.length ? await q(`SELECT lot_id, quality, design, grade, status FROM lots WHERE lot_id = ANY($1::text[]) ORDER BY lot_id FOR UPDATE`, [lotIds]) : { rows: [] };
  const lots = new Map<string, LotRow>(lotRes.rows.map((r) => [String(r.lot_id), r as LotRow]));

  // 2. Validate + normalise each value. Keyed by row+field: the same cell changed twice must agree.
  const editedMvIds = [...movements.keys()];
  const mvFinal = new Map<string, { m: MovementRow; field: string; value: string | number | null; origin: EditProblem }>();
  for (const c of mvChanges) {
    const { m, field } = c;
    let v: string | number | null;
    try {
      if (field === 'sr_no') v = srValue(c.value);
      else if (field === 'pieces') v = piecesValue(c.value);
      else if (field === 'source_doc_id') v = challanCode(c.value);
      else if (IN_ONLY.includes(field) && m.direction !== 'IN') throw new LedgerError(`${FIELD_LABEL[field]} is only for incoming (IN) entries.`);
      else if (OUT_ONLY.includes(field) && field !== 'party' && m.direction !== 'OUT') throw new LedgerError(`${FIELD_LABEL[field]} is only for outgoing (OUT) entries.`);
      else if (field === 'register_pct') v = registerPctValue(c.value);
      else if (field === 'loc_code') v = locCodeValue(c.value);
      else if (field === 'bill_pct') v = billPctValue(c.value);
      else if (field === 'billed_meters') v = billedMetersValue(c.value);
      else if (field === 'lot_status_code') v = lotStatusCodeValue(c.value);
      else if (field === 'mill_name' || field === 'weaver_name') {
        v = await canonicalName(q, field, nameValue(c.value, FIELD_LABEL[field]), editedMvIds);
      } else {
        if (m.direction !== 'OUT') throw new LedgerError('Party is only for outgoing (OUT) entries. Use Mill / Weaver for incoming.');
        v = await canonicalName(q, 'party', nameValue(c.value, 'Party'), editedMvIds);
      }
    } catch (e) {
      if (e instanceof LedgerError) { problem(c.origin, e.message); continue; }
      throw e;
    }
    const k = `${m.id}:${field}`;
    const prev = mvFinal.get(k);
    if (prev && !same(prev.value, v)) { problem(c.origin, `${FIELD_LABEL[field]} is changed twice in this batch with different values.`); continue; }
    mvFinal.set(k, { m, field, value: v, origin: c.origin });
  }

  const lotFinal = new Map<string, { lot: LotRow; field: LotField; value: string; origin: LotChange['origin'] }>();
  for (const c of lotChanges) {
    const lot = lots.get(c.lot);
    if (!lot) { problem(c.origin, `Lot ${c.lot} does not exist.`); continue; }
    let v: string;
    try {
      if (c.field === 'quality' || c.field === 'design') v = (await canonicalLotAttr(q, c.field, requiredName(c.value, FIELD_LABEL[c.field]), lotIds))!;
      else if (c.field === 'grade') v = gradeValue(c.value);
      else v = statusValue(c.value);
    } catch (e) {
      if (e instanceof LedgerError) { problem(c.origin, e.message); continue; }
      throw e;
    }
    const k = `${lot.lot_id}:${c.field}`;
    const prev = lotFinal.get(k);
    if (prev && prev.value !== v) { problem(c.origin, `${FIELD_LABEL[c.field]} of lot ${lot.lot_id} is changed twice in this batch with different values.`); continue; }
    lotFinal.set(k, { lot, field: c.field, value: v, origin: c.origin });
  }

  // 3. SR no. is unique per direction — against the database and between the changes in this batch.
  const srChanges = [...mvFinal.values()].filter((x) => x.field === 'sr_no' && !same(x.m.sr_no, x.value));
  const srMoving = srChanges.map((x) => x.m.id); // their old numbers become free
  for (const dir of ['IN', 'OUT'] as const) {
    const mine = srChanges.filter((x) => x.m.direction === dir && x.value != null);
    if (!mine.length) continue;
    const taken = await q(
      `SELECT sr_no, lot_id FROM stock_movements WHERE direction = $1 AND sr_no = ANY($2::int[]) AND NOT (id = ANY($3::int[]))`,
      [dir, mine.map((x) => x.value), srMoving.length ? srMoving : [0]],
    );
    const used = new Map<number, string>(taken.rows.map((r) => [Number(r.sr_no), String(r.lot_id)]));
    for (const x of mine) {
      const sr = x.value as number;
      const hit = used.get(sr);
      if (hit !== undefined) problem(x.origin, `SR ${sr} is already used by an ${dir} entry (lot ${hit}).`);
      else used.set(sr, x.m.lot_id); // a later change in this batch with the same SR collides with this one
    }
  }

  if (problems.length) throw new EditProblems(problems);

  // 4. Apply (skipping no-ops) and log every changed field.
  const log: { target: 'movement' | 'lot'; id: string; field: string; old: string | null; neu: string | null }[] = [];
  const mvSet = new Map<number, { m: MovementRow; sets: [string, string | number | null][] }>();
  for (const x of mvFinal.values()) {
    const old = x.m[x.field as keyof MovementRow];
    if (same(old, x.value)) continue;
    const e = mvSet.get(x.m.id) ?? { m: x.m, sets: [] };
    e.sets.push([x.field, x.value]);
    mvSet.set(x.m.id, e);
    log.push({ target: 'movement', id: String(x.m.id), field: x.field, old: str(old), neu: str(x.value) });
  }
  const lotSet = new Map<string, [string, string][]>();
  for (const x of lotFinal.values()) {
    const old = x.lot[x.field];
    if (same(old, x.value)) continue;
    lotSet.set(x.lot.lot_id, [...(lotSet.get(x.lot.lot_id) ?? []), [x.field, x.value]]);
    log.push({ target: 'lot', id: x.lot.lot_id, field: x.field, old: str(old), neu: x.value });
  }

  if (log.length) {
    await markAgentsStale(q);
    // Free the old SR numbers first so swaps inside one batch don't trip the unique index.
    const freeing = srChanges.filter((x) => x.m.sr_no != null).map((x) => x.m.id);
    if (freeing.length) await q(`UPDATE stock_movements SET sr_no = NULL WHERE id = ANY($1::int[])`, [freeing]);
    for (const [id, { sets }] of mvSet) {
      // Column names come from the MOVEMENT_FIELDS whitelist, never from the request text.
      const cols = sets.map(([f], i) => `${f} = $${i + 2}`).join(', ');
      await q(`UPDATE stock_movements SET ${cols} WHERE id = $1`, [id, ...sets.map(([, v]) => v)]);
      // The lot keeps the location code of its incoming entry (Lots & balance shows it).
      const loc = sets.find(([f]) => f === 'loc_code');
      if (loc) await q(`UPDATE lots SET loc_code = $2 WHERE lot_id = $1`, [mvSet.get(id)!.m.lot_id, loc[1]]);
    }
    for (const [lotId, sets] of lotSet) {
      const cols = sets.map(([f], i) => `${f} = $${i + 2}`).join(', ');
      await q(`UPDATE lots SET ${cols} WHERE lot_id = $1`, [lotId, ...sets.map(([, v]) => v)]);
    }
    await q(
      `INSERT INTO ledger_edits (target, target_id, field, old_value, new_value, edited_by)
       SELECT t, i, f, o, n, $6 FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) AS x(t, i, f, o, n)`,
      [log.map((l) => l.target), log.map((l) => l.id), log.map((l) => l.field), log.map((l) => l.old), log.map((l) => l.neu), by],
    );
  }

  const rows = await ledgerRowsByIds(q, [...mvSet.keys()]);
  const changedLots = [...lotSet.keys()];
  const lotOut = changedLots.length
    ? (await q(`SELECT lot_id, quality, design, grade, status FROM lots WHERE lot_id = ANY($1::text[]) ORDER BY lot_id`, [changedLots])).rows as EditedLot[]
    : [];
  return { saved: log.length, rows, lots: lotOut };
}

/** Last edits of one movement or lot (newest first), with the editor's name. */
export async function editHistory(q: Q, target: 'movement' | 'lot', id: string, limit = 20) {
  const r = await q(
    `SELECT le.field, le.old_value, le.new_value, le.edited_at, COALESCE(u.name, le.edited_by) AS edited_by
     FROM ledger_edits le LEFT JOIN users u ON u.id = le.edited_by
     WHERE le.target = $1 AND le.target_id = $2 ORDER BY le.edited_at DESC, le.id DESC LIMIT $3`,
    [target, id, limit],
  );
  return r.rows.map((x) => ({
    field: String(x.field), label: FIELD_LABEL[x.field] ?? String(x.field), old_value: x.old_value as string | null, new_value: x.new_value as string | null,
    edited_at: x.edited_at instanceof Date ? x.edited_at.toISOString() : String(x.edited_at), edited_by: (x.edited_by as string) ?? null,
  }));
}
