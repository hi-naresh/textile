// Lots with their running stock state, straight from the lot row (kept by triggers — migration 010):
// no summing of movements, no per-lot location lookups. Server-side only.
//   lotsPage()   → the Stock screen's "Lots & balance" view (keyset-paged on lot no., newest first)
//   lotSearch()  → type-ahead for every lot picker (lot no. prefix first, then quality / design / location)
//   lotsByIds()  → a few known lots (dispatch lines, reserved lots, the lot being moved)
import type { NextRequest } from 'next/server';
import type { Q } from './db';
import { COOKIE } from './auth/config';

/** Must match idx_lots_search_trgm in scripts/migrations/010_stock_state_and_search.sql exactly. */
export const LOT_DOC = `lower(l.lot_id::text || ' ' || l.quality::text || ' ' || l.design::text || ' ' || COALESCE(l.cur_location, '')::text)`;
/** With COLLATE "C": must match idx_lots_lot_c (prefix LIKE + ordering from the index). */
const LOT_KEY = `lower(l.lot_id::text)`;

export const LOT_COLS = `l.lot_id, l.quality, l.design, l.grade, l.status, l.bal_m AS balance,
  l.cur_location AS location, l.cur_location_stage AS location_stage, l.cur_location_ts AS location_ts`;

/** Beyond this, counts show as "10,000+" (an exact count over millions of rows is the slow part). */
export const COUNT_CAP = 10_000;

export type LotRow = {
  lot_id: string; quality: string; design: string; grade: string; status: string; balance: number;
  location: string | null; location_stage: string | null; location_ts: string | null;
};

export function toLot(r: Record<string, unknown>): LotRow {
  return {
    lot_id: String(r.lot_id), quality: String(r.quality ?? ''), design: String(r.design ?? ''), grade: String(r.grade ?? ''),
    status: String(r.status ?? ''), balance: Number(r.balance ?? 0), location: (r.location as string) ?? null,
    location_stage: (r.location_stage as string) ?? null,
    location_ts: r.location_ts == null ? null : r.location_ts instanceof Date ? r.location_ts.toISOString() : String(r.location_ts),
  };
}

/** Escape LIKE wildcards so "50%" matches literally. */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const clip = (v: string | null | undefined, max = 100) => {
  const s = (v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : '';
};

export interface LotFilters { q: string; status: string; inStock: boolean; quality: string }
export const LOT_STATUSES = ['active', 'completed', 'dispatched', 'hold'];

export function lotFiltersFrom(sp: URLSearchParams): LotFilters {
  const status = (sp.get('status') ?? '').trim().toLowerCase();
  return {
    q: clip(sp.get('q')),
    status: LOT_STATUSES.includes(status) ? status : '',
    inStock: sp.get('in_stock') === '1',
    quality: clip(sp.get('quality')),
  };
}

function lotWhere(f: LotFilters, params: unknown[]): string[] {
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const parts: string[] = [];
  if (f.inStock) parts.push('l.bal_m > 0');
  if (f.status) parts.push(`l.status = ${p(f.status)}`);
  if (f.quality) parts.push(`lower(l.quality) = lower(${p(f.quality)})`);
  for (const word of f.q.toLowerCase().split(' ').filter(Boolean).slice(0, 6)) parts.push(`${LOT_DOC} LIKE ${p(`%${likeEscape(word)}%`)}`);
  return parts;
}

/** A trigram index can only narrow words of 3+ characters. */
const hasIndexableWord = (q: string) => q.split(' ').some((w) => w.length >= 3);

/** Count up to COUNT_CAP + 1 rows: exact below the cap, "more than" above it. */
export async function cappedCount(q: Q, from: string, where: string, params: unknown[]): Promise<{ total: number; capped: boolean }> {
  const r = await q(`SELECT count(*)::int AS n FROM (SELECT 1 FROM ${from} ${where} LIMIT ${COUNT_CAP + 1}) x`, params);
  const n = Number(r.rows[0]?.n ?? 0);
  return n > COUNT_CAP ? { total: COUNT_CAP, capped: true } : { total: n, capped: false };
}

/** One page of lots, lot no. newest first. `total` on the first page only. */
export async function lotsPage(q: Q, f: LotFilters, opts: { limit: number; cursor: string | null }) {
  const params: unknown[] = [];
  const parts = lotWhere(f, params);
  const countParams = [...params];
  const countWhere = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
  if (opts.cursor) { params.push(opts.cursor); parts.push(`l.lot_id < $${params.length}`); }
  params.push(opts.limit + 1);
  const where = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
  // With search words, find the matches through the trigram index first, then sort them. (Left to itself the planner
  // may walk every lot in number order looking for matches — 100+ ms at 200k lots when the matches are old lots.)
  const r = hasIndexableWord(f.q)
    ? await q(`WITH m AS MATERIALIZED (SELECT ${LOT_COLS} FROM lots l ${where}) SELECT * FROM m ORDER BY lot_id DESC LIMIT $${params.length}`, params)
    : await q(`SELECT ${LOT_COLS} FROM lots l ${where} ORDER BY l.lot_id DESC LIMIT $${params.length}`, params);
  const more = r.rows.length > opts.limit;
  const rows = r.rows.slice(0, opts.limit).map(toLot);
  let total: number | null = null;
  let capped = false;
  if (!opts.cursor) {
    // A short first page is the whole answer; only a full one needs counting.
    if (!more) total = rows.length;
    else ({ total, capped } = await cappedCount(q, 'lots l', countWhere, countParams));
  }
  return { rows, next: more ? rows[rows.length - 1].lot_id : null, total, total_capped: capped };
}

/**
 * Type-ahead: lots whose number starts with the text (in lot-number order), then lots whose number,
 * quality, design or location contains it. Empty text → the newest lots.
 */
export async function lotSearch(q: Q, f: LotFilters, limit: number): Promise<LotRow[]> {
  const text = f.q.toLowerCase();
  const base: unknown[] = [];
  const common = lotWhere({ ...f, q: '' }, base);
  if (!text) {
    const r = await q(`SELECT ${LOT_COLS} FROM lots l ${common.length ? `WHERE ${common.join(' AND ')}` : ''} ORDER BY l.lot_id DESC LIMIT ${limit}`, base);
    return r.rows.map(toLot);
  }
  const params = [...base, `${likeEscape(text)}%`];
  const pfx = `$${params.length}`;
  const w1 = [...common, `${LOT_KEY} COLLATE "C" LIKE ${pfx}`];
  const starts = await q(
    `SELECT ${LOT_COLS} FROM lots l WHERE ${w1.join(' AND ')} ORDER BY ${LOT_KEY} COLLATE "C" LIMIT ${limit}`,
    params,
  );
  const out = starts.rows.map(toLot);
  if (out.length >= limit) return out;
  const p2 = [...base];
  const w2 = [...common, ...lotWhere({ q: f.q, status: '', inStock: false, quality: '' }, p2)];
  p2.push(`${likeEscape(text)}%`);
  w2.push(`NOT (${LOT_KEY} COLLATE "C" LIKE $${p2.length})`);
  const has = await q(`SELECT ${LOT_COLS} FROM lots l WHERE ${w2.join(' AND ')} ORDER BY l.lot_id DESC LIMIT ${limit - out.length}`, p2);
  return [...out, ...has.rows.map(toLot)];
}

/** Every matching lot (Excel), lot no. order. Capped. */
export async function lotsAll(q: Q, f: LotFilters, cap = 200_000): Promise<LotRow[]> {
  const params: unknown[] = [];
  const parts = lotWhere(f, params);
  const r = await q(`SELECT ${LOT_COLS} FROM lots l ${parts.length ? `WHERE ${parts.join(' AND ')}` : ''} ORDER BY l.lot_id LIMIT ${cap}`, params);
  return r.rows.map(toLot);
}

export async function lotsByIds(q: Q, ids: string[]): Promise<LotRow[]> {
  if (!ids.length) return [];
  const r = await q(`SELECT ${LOT_COLS} FROM lots l WHERE l.lot_id = ANY($1::text[]) ORDER BY l.lot_id`, [ids]);
  return r.rows.map(toLot);
}

/**
 * Start a read before the session check finishes, so a signed-in request costs one database round trip
 * instead of two (≈200 ms each from Vercel to Supabase). Only when a session cookie is present; the result is
 * returned to the caller only after its auth check passes. Returns null (don't start) without a cookie.
 */
export function startEarly<T>(req: NextRequest, fn: () => Promise<T>): Promise<T> | null {
  if (!req.cookies.get(COOKIE.access)?.value) return null;
  const p = fn();
  p.catch(() => {}); // an unauthorised caller never awaits it
  return p;
}
