import { NextRequest, NextResponse } from 'next/server';
import { readObject, requireCap, requireUser } from '@/lib/apiAuth';
import { can, canAddShops } from '@/lib/access';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody, recordIncoming, recordOutgoing } from '@/lib/ledger';

// GET (owner / supervisor; workers get nothing): the small, fixed-size stock snapshot every screen shares.
//   stockSummary { on_hand_m, active_lots, packed_m / packed_lots, running_m / running_lots,
//                  on_hold_m / on_hold_lots, low_lots (20 lowest) },
//   today totals, 7-day flow, today's latest movements (≤ 100, for the live feed), known names (≤ 1000 each),
//   qualities (for order forms), rev (changes whenever stock changes; lets screens skip reloads).
// Lot lists are NOT here any more: GET /api/lots (paged) and GET /api/lots/search (type-ahead).
// Two queries, run in parallel, both index-only / bounded (per-lot balances live on the lot row, migration 010).
const SNAPSHOT_SQL = `
  WITH flow AS (
    SELECT ts::date AS day,
           SUM(meters) FILTER (WHERE direction = 'IN' AND kind = 'normal')  AS in_m, -- closing adjustments (016) are not receipts
           COUNT(*)    FILTER (WHERE direction = 'IN' AND kind = 'normal')  AS in_count,
           SUM(meters) FILTER (WHERE direction = 'OUT' AND kind = 'normal') AS out_m, -- opening / closing adjustments are not dispatches
           COUNT(*)    FILTER (WHERE direction = 'OUT' AND kind = 'normal') AS out_count
      FROM stock_movements
     WHERE ts >= CURRENT_DATE - 6 AND ts < CURRENT_DATE + 1
       AND ($2::text IS NULL OR EXISTS (
         SELECT 1 FROM job_cards scoped_jc
         JOIN supervisor_sections ss ON ss.user_id = $2
         JOIN sections scoped_s ON scoped_s.id = ss.section_id AND scoped_s.active
         WHERE scoped_jc.lot_id = stock_movements.lot_id
           AND lower(btrim(regexp_replace(scoped_jc.process, '\\s*section\\s*$', '', 'i')))
             = lower(btrim(regexp_replace(scoped_s.name, '\\s*section\\s*$', '', 'i')))
       ))
     GROUP BY 1
  )
  SELECT
    -- On-hand total scans every in-stock lot (index-only); skipped when stock has not changed since the cached one ($1).
    CASE WHEN (SELECT last_value::text FROM stock_rev) = $1 THEN NULL
         ELSE (SELECT json_build_object(
           'on_hand_m', COALESCE(SUM(bal_m), 0),
           'active_lots', COUNT(*),
           'packed_m', COALESCE(SUM(bal_m) FILTER (WHERE stock_status = 'packed'), 0),
           'packed_lots', COUNT(*) FILTER (WHERE stock_status = 'packed'),
           'running_m', COALESCE(SUM(bal_m) FILTER (WHERE stock_status = 'running'), 0),
           'running_lots', COUNT(*) FILTER (WHERE stock_status = 'running'),
           'on_hold_m', COALESCE(SUM(bal_m) FILTER (WHERE stock_status = 'hold'), 0),
           'on_hold_lots', COUNT(*) FILTER (WHERE stock_status = 'hold')
         ) FROM (
           SELECT l.bal_m,
                  CASE WHEN l.status = 'hold' THEN 'hold'
                       WHEN EXISTS (SELECT 1 FROM job_cards jc WHERE jc.lot_id = l.lot_id AND jc.status <> 'closed') THEN 'running'
                       ELSE 'packed' END AS stock_status
             FROM lots l
            WHERE l.closed_at IS NULL AND l.bal_m > 0
              AND ($2::text IS NULL OR EXISTS (
                SELECT 1 FROM job_cards scoped_jc
                JOIN supervisor_sections ss ON ss.user_id = $2
                JOIN sections scoped_s ON scoped_s.id = ss.section_id AND scoped_s.active
                WHERE scoped_jc.lot_id = l.lot_id
                  AND lower(btrim(regexp_replace(scoped_jc.process, '\\s*section\\s*$', '', 'i')))
                    = lower(btrim(regexp_replace(scoped_s.name, '\\s*section\\s*$', '', 'i')))
              ))
         ) current_stock) END AS summary,
    (SELECT COALESCE(json_agg(json_build_object('lot_id', x.lot_id, 'quality', x.quality, 'balance', x.bal_m) ORDER BY x.bal_m, x.lot_id), '[]')
       FROM (SELECT lot_id, quality, bal_m FROM lots
              WHERE closed_at IS NULL AND bal_m > 0 AND bal_m < COALESCE((SELECT low_stock_m FROM app_settings WHERE id = 1), 200)
                AND ($2::text IS NULL OR EXISTS (
                  SELECT 1 FROM job_cards scoped_jc
                  JOIN supervisor_sections ss ON ss.user_id = $2
                  JOIN sections scoped_s ON scoped_s.id = ss.section_id AND scoped_s.active
                  WHERE scoped_jc.lot_id = lots.lot_id
                    AND lower(btrim(regexp_replace(scoped_jc.process, '\\s*section\\s*$', '', 'i')))
                      = lower(btrim(regexp_replace(scoped_s.name, '\\s*section\\s*$', '', 'i')))
                ))
              ORDER BY bal_m, lot_id LIMIT 20) x) AS low_lots,
    (SELECT json_agg(json_build_object('day', to_char(d, 'YYYY-MM-DD'), 'in_m', COALESCE(f.in_m, 0), 'out_m', COALESCE(f.out_m, 0),
                                       'in_count', COALESCE(f.in_count, 0), 'out_count', COALESCE(f.out_count, 0)) ORDER BY d)
       FROM generate_series(CURRENT_DATE - 6, CURRENT_DATE, interval '1 day') d
       LEFT JOIN flow f ON f.day = d::date) AS flow,
    (SELECT json_build_object(
        'mills',   COALESCE((SELECT json_agg(name ORDER BY name) FROM (SELECT name FROM known_names WHERE kind = 'mill'   ORDER BY n DESC, name LIMIT 1000) x), '[]'),
        'weavers', COALESCE((SELECT json_agg(name ORDER BY name) FROM (SELECT name FROM known_names WHERE kind = 'weaver' ORDER BY n DESC, name LIMIT 1000) x), '[]'),
        'parties', COALESCE((SELECT json_agg(name ORDER BY name) FROM (SELECT name FROM known_names WHERE kind = 'party'  ORDER BY n DESC, name LIMIT 1000) x), '[]'))) AS names,
    (SELECT COALESCE(json_agg(DISTINCT quality ORDER BY quality), '[]') FROM lot_facets) AS qualities,
    (SELECT last_value FROM stock_rev)::text AS rev`;

// Today's movements, newest first (the live feed on Today). Plain rows so timestamps parse like everywhere else.
const TODAY_ROWS_SQL = `
  SELECT sm.id, sm.lot_id, sm.direction, sm.meters, sm.party, sm.source_doc_id, sm.capture_event_id, sm.ts,
         sm.grey_meters, sm.finished_meters, sm.mill_name, sm.weaver_name, l.quality, l.design, true AS is_today,
         (l.closed_at IS NOT NULL) AS lot_closed
    FROM stock_movements sm
    JOIN lots l ON sm.lot_id = l.lot_id
   WHERE sm.ts >= CURRENT_DATE AND sm.ts < CURRENT_DATE + 1 AND sm.kind <> 'closing' -- closing adjustments are owner-only records
     AND ($1::text IS NULL OR EXISTS (
       SELECT 1 FROM job_cards scoped_jc
       JOIN supervisor_sections ss ON ss.user_id = $1
       JOIN sections scoped_s ON scoped_s.id = ss.section_id AND scoped_s.active
       WHERE scoped_jc.lot_id = l.lot_id
         AND lower(btrim(regexp_replace(scoped_jc.process, '\\s*section\\s*$', '', 'i')))
           = lower(btrim(regexp_replace(scoped_s.name, '\\s*section\\s*$', '', 'i')))
     ))
   ORDER BY sm.ts DESC, sm.id DESC
   LIMIT 100`;

const num = (v: unknown) => (v == null ? null : Number(v));

// Last on-hand total per server instance, keyed by stock_rev. Short TTL: a writer bumps the rev before it commits,
// so a total read in that instant could miss its change; it is recomputed within SUMMARY_TTL_MS at the latest.
type CachedSummary = Pick<import('@/lib/types').StockSummary,
  'on_hand_m' | 'active_lots' | 'packed_m' | 'packed_lots' | 'running_m' | 'running_lots' | 'on_hold_m' | 'on_hold_lots'>;
let summaryCache: { rev: string; scope: string; at: number; value: CachedSummary } | null = null;
const SUMMARY_TTL_MS = 10_000;

async function snapshot(scopeUserId: string | null) {
  const scope = scopeUserId ?? '';
  const cached = summaryCache && summaryCache.scope === scope && Date.now() - summaryCache.at < SUMMARY_TTL_MS ? summaryCache : null;
  const [s, t] = await Promise.all([query(SNAPSHOT_SQL, [cached?.rev ?? '', scopeUserId]), query(TODAY_ROWS_SQL, [scopeUserId])]);
  const x = s.rows[0];
  const rev = String(x.rev ?? '0');
  let summary = cached?.value ?? { on_hand_m: 0, active_lots: 0, packed_m: 0, packed_lots: 0, running_m: 0, running_lots: 0, on_hold_m: 0, on_hold_lots: 0 };
  if (x.summary) {
    summary = {
      on_hand_m: Number(x.summary.on_hand_m ?? 0), active_lots: Number(x.summary.active_lots ?? 0),
      packed_m: Number(x.summary.packed_m ?? 0), packed_lots: Number(x.summary.packed_lots ?? 0),
      running_m: Number(x.summary.running_m ?? 0), running_lots: Number(x.summary.running_lots ?? 0),
      on_hold_m: Number(x.summary.on_hold_m ?? 0), on_hold_lots: Number(x.summary.on_hold_lots ?? 0),
    };
    summaryCache = { rev, scope, at: Date.now(), value: summary };
  }
  const flow = (x.flow ?? []) as { day: string; in_m: number; out_m: number; in_count: number; out_count: number }[];
  const last = flow[flow.length - 1] ?? { in_m: 0, in_count: 0, out_m: 0, out_count: 0 };
  return {
    stockSummary: {
      on_hand_m: summary.on_hand_m,
      active_lots: summary.active_lots,
      packed_m: summary.packed_m,
      packed_lots: summary.packed_lots,
      running_m: summary.running_m,
      running_lots: summary.running_lots,
      on_hold_m: summary.on_hold_m,
      on_hold_lots: summary.on_hold_lots,
      low_lots: ((x.low_lots ?? []) as { lot_id: string; quality: string; balance: number }[]).map((l) => ({ lot_id: l.lot_id, quality: l.quality, balance: Number(l.balance) })),
    },
    today: { in_m: Number(last.in_m), in_count: Number(last.in_count), out_m: Number(last.out_m), out_count: Number(last.out_count) },
    flow: flow.map((f) => ({ day: f.day, in_m: Number(f.in_m), out_m: Number(f.out_m) })),
    // No ₹ here: this feed is shared with supervisors (purchase rates live in Money / costing).
    ledger: t.rows.map((r) => ({ ...r, meters: Number(r.meters), grey_meters: num(r.grey_meters), finished_meters: num(r.finished_meters) })),
    // Names already used, to suggest while typing (keeps spellings consistent)
    names: x.names ?? { mills: [], weavers: [], parties: [] },
    qualities: (x.qualities ?? []) as string[],
    rev,
  };
}

export async function GET(request: NextRequest) {
  try {
    const a = await requireUser(request);
    if (!can(a.role, 'stock.quantity')) {
      return NextResponse.json({ stockSummary: null, ledger: [], names: { mills: [], weavers: [], parties: [] }, flow: [], qualities: [], rev: '0' });
    }
    const snap = await snapshot(a.role === 'supervisor' ? a.userId : null);
    // Entries of closed lots are the owner's records (stock.closed): left out of everyone else's live feed.
    const owner = can(a.role, 'stock.closed');
    const ledger = snap.ledger.filter((r) => owner || !r.lot_closed).map(({ lot_closed: _c, ...r }) => { void _c; return r; });
    return NextResponse.json({ ...snap, ledger }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// POST (owner): Add a manual stock movement.
// IN:  lot_id, grey_meters and/or finished_meters, mill_name, weaver_name, source_doc, location, quality + design (new lot)
// OUT: lot_id, meters, party (destination client, required), source_doc, entry_status (packed / running (default) / end — end needs stock.end)
// Both: sr_no (optional, whole number > 0, unique per direction → 409 when taken), pieces (optional taka, whole number ≥ 0)
// Optional register fields (migration 013): IN register_pct (0–100), loc_code ("212", "142+143"); OUT bill_pct (L), billed_meters (NQTY), lot_status_code (LOT S)
export async function POST(request: NextRequest) {
  try {
    const a = await requireCap(request, 'ledger.edit');
    const body = await readObject(request);
    const direction = body?.direction;
    if (direction !== 'IN' && direction !== 'OUT') {
      return NextResponse.json({ error: 'direction must be IN or OUT.' }, { status: 400 });
    }
    // import_ref is only set by the Excel import. date enables back-dated entries.
    const input = {
      ...body,
      date: body?.date ? String(body.date).trim() : null,
      import_ref: null,
      capture_event_id: null,
      moved_by: a.by,
      add_shops_by: (canAddShops(a.role) ? a.by : false) as string | false,
    };
    const movement = await withTransaction((q) =>
      direction === 'IN'
        ? recordIncoming(q, input, { requireLotDetails: true })
        : recordOutgoing(q, input, { endAllowed: can(a.role, 'stock.end') })
    );
    return NextResponse.json({ success: true, movement });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
