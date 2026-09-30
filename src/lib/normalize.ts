// Strict formats + canonical names for everything written to the ledger.
// Used by manual entry, Excel import and photo reads, so the same lot / party / mill
import { formatMarketLocation, parseMarketLocation } from './location';
// is always stored the same way ("haridwar textiles " → "HARIDWAR TEXTILES" if that spelling exists).

import type { Q } from './db';
import { LedgerError } from './ledger-error';

/** Match key: lower-case letters and digits only. "Haridwar Tex." and "HARIDWAR  TEX" share a key. */
export const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const collapse = (v: unknown) => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim());

/** Codes (lot numbers, challan numbers): upper-case, spaces → "-", only A–Z 0–9 - / allowed. */
function code(v: unknown, label: string, max: number, required: boolean): string | null {
  const s = collapse(v).toUpperCase().replace(/\s*-\s*/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-');
  if (!s) {
    if (required) throw new LedgerError(`${label} is required.`);
    return null;
  }
  if (!/^[A-Z0-9][A-Z0-9/-]*$/.test(s)) throw new LedgerError(`${label} "${collapse(v)}" can only use letters, digits, "-" and "/".`);
  if (s.length > max) throw new LedgerError(`${label} must be ${max} characters or fewer.`);
  return s;
}

export const lotCode = (v: unknown, required = true) => code(v, 'Lot number', 30, required);
export const challanCode = (v: unknown) => code(v, 'Challan number', 40, false);

/** Meters: positive, at most 2 decimals kept, sane upper bound. null when empty. */
export function metersValue(v: unknown, label: string, opts: { allowZero?: boolean } = {}): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n < 0 || (n === 0 && !opts.allowZero)) throw new LedgerError(`${label} must be a ${opts.allowZero ? 'number (0 or more)' : 'positive number'}.`);
  if (n > 1_000_000) throw new LedgerError(`${label} looks too large (${n}). Check the number.`);
  return Math.round(n * 100) / 100;
}

/** Free-text name (party, mill, weaver, quality, design): single spaces, 2–100 chars, must contain a letter or digit. */
export function nameValue(v: unknown, label: string, max = 100): string | null {
  const s = collapse(v);
  if (!s) return null;
  if (!/[\p{L}\p{N}]/u.test(s)) throw new LedgerError(`${label} "${s}" is not a valid name.`);
  if (s.length > max) throw new LedgerError(`${label} must be ${max} characters or fewer.`);
  return s;
}

type NameField = 'party' | 'mill_name' | 'weaver_name';

/**
 * Canonical spelling: if the same name (ignoring case, spaces, dots) was used before, reuse that spelling.
 * Mills and weavers share one list (a mill can also be the weaver).
 */
export async function canonicalName(q: Q, field: NameField, value: string | null, excludeIds: number[] = []): Promise<string | null> {
  if (!value) return value;
  const key = nameKey(value);
  if (!key) return value;
  const cols = field === 'party' ? ['party'] : ['mill_name', 'weaver_name'];
  // excludeIds: rows being edited don't vote for their own old spelling (ledger edit mode).
  const skip = excludeIds.length ? ` AND NOT (id = ANY($2::int[]))` : '';
  for (const col of cols) {
    const r = await q(
      `SELECT ${col} AS name, COUNT(*) AS n FROM stock_movements
       WHERE ${col} IS NOT NULL AND regexp_replace(lower(${col}), '[^a-z0-9]', '', 'g') = $1${skip}
       GROUP BY ${col} ORDER BY n DESC LIMIT 1`,
      excludeIds.length ? [key, excludeIds] : [key],
    );
    if (r.rows[0]) return r.rows[0].name;
  }
  return value;
}

/** Canonical quality / design spelling from existing lots. */
export async function canonicalLotAttr(q: Q, col: 'quality' | 'design', value: string | null, excludeLots: string[] = []): Promise<string | null> {
  if (!value) return value;
  const skip = excludeLots.length ? ` AND NOT (lot_id = ANY($2::text[]))` : '';
  const r = await q(
    `SELECT ${col} AS v FROM lots WHERE regexp_replace(lower(${col}), '[^a-z0-9]', '', 'g') = $1${skip} GROUP BY ${col} ORDER BY COUNT(*) DESC LIMIT 1`,
    excludeLots.length ? [nameKey(value), excludeLots] : [nameKey(value)],
  );
  return r.rows[0]?.v ?? value;
}

// ---------- locations ----------
export const SYSTEM_LOCATIONS = { floor: 'Floor', dispatched: 'Dispatched', godown: 'Godown' } as const;

export async function locationPresetsFrom(q: Q): Promise<string[]> {
  const r = await q(`SELECT location_presets FROM app_settings WHERE id = 1`);
  return r.rows[0]?.location_presets ?? ['Godown', 'Shop', 'Floor'];
}

/**
 * Only locations from the firm's fixed list (My firm → Markets & locations) are accepted.
 * Returns the list's spelling. "Dispatched" is set by the system only.
 */
export async function allowedLocation(q: Q, v: unknown, required: boolean): Promise<string | null> {
  const s = collapse(v);
  if (!s) {
    if (required) throw new LedgerError('Location is required.');
    return null;
  }
  const presets = await locationPresetsFrom(q);
  const list = presets.some((p) => nameKey(p) === nameKey(SYSTEM_LOCATIONS.floor)) ? presets : [...presets, SYSTEM_LOCATIONS.floor];
  const hit = list.find((p) => nameKey(p) === nameKey(s));
  if (hit) return hit;
  // Or a market address: "<market> <shop> · Pipe <pipe>" with a market from My firm → Markets.
  const mk = await q(`SELECT markets FROM app_settings WHERE id = 1`);
  const markets: string[] = mk.rows[0]?.markets ?? [];
  const m = parseMarketLocation(s, markets);
  if (m) return formatMarketLocation(m.market, m.shop, m.pipe);
  throw new LedgerError(`"${s}" is not a known location. Use one of ${list.join(', ')}, or a market address like "${markets[0] ?? 'RRTM'} 245 · Pipe 3" (markets are set in My firm).`);
}
