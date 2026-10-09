// Strict formats + canonical names for everything written to the ledger.
// Used by manual entry, Excel import and photo reads, so the same lot / party / mill
import { formatMarketLocation, marketList, OLD_PLACES, parseMarketLocation, SYSTEM_PLACES } from './location';
import { addShop } from './markets';
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
/** Places the app writes itself (never picked by a person). Godown is only on rows from before markets (migration 014). */
export const SYSTEM_LOCATIONS = { floor: 'Floor', dispatched: 'Dispatched' } as const;

/** A checked market location: the label stored in lot_locations.location + its structured copy. */
export interface Place { location: string; market_id: number; shop_no: string; pipe_no: number | null }

export interface MarketRow { id: number; name: string; code: string; active: boolean }
export async function marketRows(q: Q): Promise<MarketRow[]> {
  const r = await q(`SELECT id, name, code, active FROM markets ORDER BY sort_order, lower(name), id`);
  return r.rows.map((x) => ({ id: Number(x.id), name: String(x.name), code: String(x.code), active: !!x.active }));
}

/**
 * Read a location typed / picked / imported by a person against the active markets → the stored label + parts.
 * Errors (plain words) when there is no market or shop no., the pipe no. is not 1–999, or it names a fixed place
 * (Godown, Shop) or a place only the app sets (Floor, Dispatched): throws the reason. Pure (no database).
 */
export type ReadPlace = Omit<Place, 'market_id'> & { market: MarketRow };
export function readPlace(text: string, markets: MarketRow[]): ReadPlace {
  const s = collapse(text);
  const example = `${markets.find((m) => m.active)?.code ?? 'LM'} 245 · Pipe 3`;
  const list = marketList(markets);
  const hint = list ? ` Markets: ${list}.` : ' No markets yet — the owner adds them in My firm → Markets & locations.';
  const r = parseMarketLocation(s, markets);
  if (r && !r.ok) throw new LedgerError(r.error);
  if (!r) {
    const key = nameKey(s);
    if (SYSTEM_PLACES.some((p) => nameKey(p) === key)) throw new LedgerError(`"${s}" is set by the app (job cards and dispatch), not picked. Use a market and shop no., like "${example}".`);
    if (OLD_PLACES.some((p) => nameKey(p) === key)) throw new LedgerError(`"${s}" is no longer a location. Use a market and shop no., like "${example}".${hint}`);
    const off = parseMarketLocation(s, markets, { includeInactive: true });
    if (off && off.ok) throw new LedgerError(`Market ${off.place.market.name} (${off.place.market.code}) is switched off. Switch it on in My firm, or pick another market.`);
    throw new LedgerError(`"${s}" is not a market location. Write it like "${example}" (market, shop no., pipe no.).${hint}`);
  }
  const m = r.place.market as MarketRow;
  return { market: m, location: formatMarketLocation(m.code, r.place.shop, r.place.pipe), shop_no: r.place.shop, pipe_no: r.place.pipe };
}

/**
 * The location a person gave (manual entry, moving a lot, confirming a photo read, the app's Excel template).
 * Accepts only an active market + shop no. (+ optional pipe 1–999). A shop not in that market's list is added when
 * `addShopsBy` is set (owner / supervisor: user id, or null for "unknown user"), otherwise refused.
 */
export async function allowedLocation(q: Q, v: unknown, opts: { required: boolean; addShopsBy?: string | null | false }): Promise<Place | null> {
  const s = collapse(v);
  if (!s) {
    if (opts.required) throw new LedgerError('Pick a location: market and shop no.');
    return null;
  }
  const place = readPlace(s, await marketRows(q));
  const shop = await q(`SELECT id, active FROM market_shops WHERE market_id = $1 AND shop_no = $2`, [place.market.id, place.shop_no]);
  if (!shop.rows[0]?.active) {
    if (opts.addShopsBy === false || opts.addShopsBy === undefined) {
      throw new LedgerError(`Shop ${place.shop_no} is not in ${place.market.name}'s list. Ask the owner or a supervisor to add it.`);
    }
    await addShop(q, place.market.id, place.shop_no, opts.addShopsBy);
  }
  return { location: place.location, market_id: place.market.id, shop_no: place.shop_no, pipe_no: place.pipe_no };
}
