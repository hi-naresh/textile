// Quality catalog (migration 017). Server-side only.
// Lots typed by hand (manual entry, ledger edit) may only use an active quality from this list, so the same cloth is
// never saved under two spellings. Photo reads and Excel imports are not blocked (they fall back to what was read).
import type { Q } from './db';
import { LedgerError } from './ledger-error';

export interface QualityRow { id: number; name: string; active: boolean; lots: number; in_stock_lots: number }

const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

export function checkQualityName(v: unknown): string {
  const s = clean(v);
  if (!s) throw new LedgerError('Quality name is required.');
  if (s.length > 100) throw new LedgerError('Quality name: up to 100 characters.');
  return s;
}

/** Every catalog quality with how many open lots use it. */
export async function listQualities(q: Q): Promise<QualityRow[]> {
  const r = await q(
    `SELECT c.id, c.name, c.active,
            COUNT(l.lot_id) FILTER (WHERE l.closed_at IS NULL)::int AS lots,
            COUNT(l.lot_id) FILTER (WHERE l.closed_at IS NULL AND l.bal_m > 0)::int AS in_stock_lots
       FROM qualities c LEFT JOIN lots l ON lower(l.quality) = lower(c.name)
      GROUP BY c.id ORDER BY lower(c.name)`,
  );
  return r.rows.map((x) => ({ id: Number(x.id), name: String(x.name), active: !!x.active, lots: Number(x.lots), in_stock_lots: Number(x.in_stock_lots) }));
}

export async function addQuality(q: Q, name: unknown, by: string | null) {
  const n = checkQualityName(name);
  const had = await q(`SELECT id, name, active FROM qualities WHERE lower(btrim(name)) = lower($1)`, [n]);
  if (had.rows[0]) {
    if (had.rows[0].active) throw new LedgerError(`${had.rows[0].name} is already in the catalog.`, 409);
    await q(`UPDATE qualities SET active = true WHERE id = $1`, [had.rows[0].id]);
    return { id: Number(had.rows[0].id), name: String(had.rows[0].name), created: false };
  }
  const r = await q(`INSERT INTO qualities (name, created_by) VALUES ($1, $2) RETURNING id, name`, [n, by]);
  return { id: Number(r.rows[0].id), name: String(r.rows[0].name), created: true };
}

/** Switch on / off, or rename (every lot with the old name is renamed too, so lots and catalog stay the same). */
export async function updateQuality(q: Q, input: { id: unknown; active?: unknown; name?: unknown }) {
  const id = Number(input.id);
  if (!Number.isInteger(id)) throw new LedgerError('Which quality? Send its id.');
  const cur = (await q(`SELECT id, name FROM qualities WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!cur) throw new LedgerError('That quality is not in the catalog.', 404);
  if (input.name !== undefined) {
    const n = checkQualityName(input.name);
    const clash = (await q(`SELECT name FROM qualities WHERE lower(btrim(name)) = lower($1) AND id <> $2`, [n, id])).rows[0];
    if (clash) throw new LedgerError(`${clash.name} is already in the catalog.`, 409);
    await q(`UPDATE qualities SET name = $2 WHERE id = $1`, [id, n]);
    await q(`UPDATE lots SET quality = $2 WHERE lower(quality) = lower($1) AND quality IS DISTINCT FROM $2`, [cur.name, n]);
  }
  if (typeof input.active === 'boolean') await q(`UPDATE qualities SET active = $2 WHERE id = $1`, [id, input.active]);
  return (await q(`SELECT id, name, active FROM qualities WHERE id = $1`, [id])).rows[0];
}

/** The catalog's spelling of a typed quality, or an error when it is not an active catalog quality. */
export async function catalogQuality(q: Q, v: unknown): Promise<string> {
  const n = clean(v);
  if (!n) throw new LedgerError('Quality is required.');
  const r = await q(`SELECT name, active FROM qualities WHERE lower(btrim(name)) = lower($1)`, [n]);
  if (!r.rows[0]) throw new LedgerError(`Quality "${n}" is not in the quality catalog. Pick one from the list, or add it in Stock ledger → Quality catalog first.`);
  if (!r.rows[0].active) throw new LedgerError(`Quality ${r.rows[0].name} is switched off in the quality catalog. Switch it on first.`);
  return String(r.rows[0].name);
}
