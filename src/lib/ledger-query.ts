// Stock ledger filtering, shared by GET /api/stock/ledger (paged) and GET /api/stock/export (Excel).
// Server-side only. Filters combine with AND; `q` is free text (every word must match somewhere:
// lot, quality, design, party, mill, weaver, challan, SR no. or the location the movement put the lot in).
import type { Q } from './db';

export interface LedgerFilters {
  q: string | null;
  direction: 'IN' | 'OUT' | null;
  quality: string | null;
  design: string | null;
  lot: string | null;
  party: string | null;
  from: string | null; // YYYY-MM-DD
  to: string | null;
  today?: boolean; // the database's today (same "today" as every other today-figure)
}

const clip = (v: string | null, max = 100) => {
  const s = (v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};
const isDate = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null);

export function filtersFrom(sp: URLSearchParams): LedgerFilters {
  const dir = sp.get('direction');
  return {
    q: clip(sp.get('q')),
    direction: dir === 'IN' || dir === 'OUT' ? dir : null,
    quality: clip(sp.get('quality')),
    design: clip(sp.get('design')),
    lot: clip(sp.get('lot'), 50),
    party: clip(sp.get('party')),
    from: isDate(sp.get('from')),
    to: isDate(sp.get('to')),
    today: sp.get('today') === '1',
  };
}

/** Escape LIKE wildcards so "50%" matches literally. */
const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** WHERE clause over `sm` (stock_movements) joined with `l` (lots). Params start at $1. */
export function whereFor(f: LedgerFilters): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (f.direction) parts.push(`sm.direction = ${p(f.direction)}`);
  if (f.quality) parts.push(`lower(l.quality) = lower(${p(f.quality)})`);
  if (f.design) parts.push(`lower(l.design) = lower(${p(f.design)})`);
  if (f.lot) parts.push(`sm.lot_id ILIKE ${p(like(f.lot))}`);
  if (f.party) parts.push(`sm.party ILIKE ${p(like(f.party))}`);
  if (f.from) parts.push(`sm.ts >= ${p(f.from)}::date`);
  if (f.to) parts.push(`sm.ts < ${p(f.to)}::date + 1`);
  if (f.today) parts.push(`sm.ts >= CURRENT_DATE AND sm.ts < CURRENT_DATE + 1`);
  if (f.q) {
    for (const word of f.q.split(' ').slice(0, 6)) {
      const w = p(like(word));
      const sr = /^\d{1,9}$/.test(word) ? ` OR sm.sr_no = ${p(Number(word))}` : '';
      parts.push(`(sm.lot_id ILIKE ${w} OR l.quality ILIKE ${w} OR l.design ILIKE ${w} OR sm.party ILIKE ${w} OR sm.mill_name ILIKE ${w}
        OR sm.weaver_name ILIKE ${w} OR sm.source_doc_id ILIKE ${w}${sr}
        OR EXISTS (SELECT 1 FROM lot_locations ll WHERE ll.lot_id = sm.lot_id AND ll.stock_movement_id = sm.id AND ll.location ILIKE ${w}))`);
    }
  }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

/** Columns for a ledger row (no ₹: this feed is shared with supervisors). `loc`: where the movement put the lot. */
const COLS = `sm.id, sm.lot_id, sm.direction, sm.meters, sm.grey_meters, sm.finished_meters, sm.mill_name, sm.weaver_name, sm.party,
  sm.source_doc_id, sm.capture_event_id, sm.sr_no, sm.pieces, sm.ts, (sm.import_ref IS NOT NULL) AS imported,
  to_char(sm.ts, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS ts_key, l.quality, l.design, (sm.ts::date = CURRENT_DATE) AS is_today,
  (SELECT ll.location FROM lot_locations ll WHERE ll.lot_id = sm.lot_id AND ll.stock_movement_id = sm.id ORDER BY ll.id DESC LIMIT 1) AS location,
  EXISTS (SELECT 1 FROM ledger_edits le WHERE le.target = 'movement' AND le.target_id = sm.id::text) AS edited`;

export interface LedgerRow {
  id: number; lot_id: string; direction: 'IN' | 'OUT'; meters: number; grey_meters: number | null; finished_meters: number | null;
  mill_name: string | null; weaver_name: string | null; party: string | null; source_doc_id: string | null; capture_event_id: number | null;
  sr_no: number | null; pieces: number | null; ts: string; imported: boolean; quality: string; design: string; is_today: boolean; location: string | null;
  edited: boolean; // changed in the ledger's edit mode (see ledger_edits)
}

const num = (v: unknown) => (v == null ? null : Number(v));
function toRow(r: Record<string, unknown>): LedgerRow {
  return {
    id: Number(r.id), lot_id: String(r.lot_id), direction: r.direction as 'IN' | 'OUT', meters: Number(r.meters),
    grey_meters: num(r.grey_meters), finished_meters: num(r.finished_meters),
    mill_name: (r.mill_name as string) ?? null, weaver_name: (r.weaver_name as string) ?? null, party: (r.party as string) ?? null,
    source_doc_id: (r.source_doc_id as string) ?? null, capture_event_id: num(r.capture_event_id), sr_no: num(r.sr_no), pieces: num(r.pieces),
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts), imported: !!r.imported,
    quality: String(r.quality ?? ''), design: String(r.design ?? ''), is_today: !!r.is_today, location: (r.location as string) ?? null,
    edited: !!r.edited,
  };
}

// Cursor = the last row's (ts, id), opaque to the browser.
export function encodeCursor(tsKey: string, id: number) { return Buffer.from(`${tsKey}|${id}`).toString('base64url'); }
export function decodeCursor(c: string | null): { ts: string; id: number } | null {
  if (!c) return null;
  try {
    const [ts, id] = Buffer.from(c, 'base64url').toString('utf8').split('|');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/.test(ts) || !/^\d{1,12}$/.test(id)) return null;
    return { ts, id: Number(id) };
  } catch {
    return null;
  }
}

/** One page, newest first, keyset on (ts, id). `total` only on the first page (no cursor). */
export async function ledgerPage(q: Q, f: LedgerFilters, opts: { limit: number; cursor: { ts: string; id: number } | null }) {
  const w = whereFor(f);
  const params = [...w.params];
  let where = w.sql;
  if (opts.cursor) {
    params.push(opts.cursor.ts, opts.cursor.id);
    where += `${where ? ' AND' : 'WHERE'} (sm.ts, sm.id) < ($${params.length - 1}::timestamp, $${params.length})`;
  }
  params.push(opts.limit + 1);
  const r = await q(
    `SELECT ${COLS} FROM stock_movements sm JOIN lots l ON l.lot_id = sm.lot_id ${where}
     ORDER BY sm.ts DESC, sm.id DESC LIMIT $${params.length}`,
    params,
  );
  const more = r.rows.length > opts.limit;
  const page = r.rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  let total: number | null = null;
  if (!opts.cursor) {
    const c = await q(`SELECT COUNT(*)::int AS n FROM stock_movements sm JOIN lots l ON l.lot_id = sm.lot_id ${w.sql}`, w.params);
    total = c.rows[0].n;
  }
  return { rows: page.map(toRow), next: more && last ? encodeCursor(last.ts_key, Number(last.id)) : null, total };
}

/** These movements as ledger rows (after an edit), newest first. */
export async function ledgerRowsByIds(q: Q, ids: number[]): Promise<LedgerRow[]> {
  if (!ids.length) return [];
  const r = await q(
    `SELECT ${COLS} FROM stock_movements sm JOIN lots l ON l.lot_id = sm.lot_id WHERE sm.id = ANY($1::int[]) ORDER BY sm.ts DESC, sm.id DESC`,
    [ids],
  );
  return r.rows.map(toRow);
}

/** Every matching row, oldest first (Excel export). Capped. */
export async function ledgerAll(q: Q, f: LedgerFilters, cap = 100_000) {
  const w = whereFor(f);
  const r = await q(
    `SELECT ${COLS} FROM stock_movements sm JOIN lots l ON l.lot_id = sm.lot_id ${w.sql} ORDER BY sm.ts, sm.id LIMIT ${cap}`,
    w.params,
  );
  return r.rows.map(toRow);
}

/** Distinct qualities / designs for the filter dropdowns, and which designs each quality has. */
export async function ledgerFacets(q: Q) {
  const r = await q(`SELECT quality, design FROM lots GROUP BY quality, design ORDER BY quality, design`);
  const byQuality: Record<string, string[]> = {};
  const designs = new Set<string>();
  for (const x of r.rows) {
    (byQuality[x.quality] ??= []).push(x.design);
    designs.add(x.design);
  }
  return { qualities: Object.keys(byQuality), designs: [...designs].sort((a, b) => a.localeCompare(b)), byQuality };
}
