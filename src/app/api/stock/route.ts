import { NextRequest, NextResponse } from 'next/server';
import { readObject, requireCap, requireUser } from '@/lib/apiAuth';
import { can, canAddShops } from '@/lib/access';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody, recordIncoming, recordOutgoing } from '@/lib/ledger';
import { startEarly } from '@/lib/lots-query';

// GET (owner / supervisor; workers get nothing): the small, fixed-size stock snapshot every screen shares.
//   stockSummary { on_hand_m, active_lots, low_lots (0 < balance < firm's low-stock level, 20 lowest) },
//   today totals, 7-day flow, today's latest movements (≤ 100, for the live feed), known names (≤ 1000 each),
//   qualities (for order forms), rev (changes whenever stock changes; lets screens skip reloads).
// Lot lists are NOT here any more: GET /api/lots (paged) and GET /api/lots/search (type-ahead).
// Two queries, run in parallel, both index-only / bounded (per-lot balances live on the lot row, migration 010).
const SNAPSHOT_SQL = `
  WITH flow AS (
    SELECT ts::date AS day,
           SUM(meters) FILTER (WHERE direction = 'IN')  AS in_m,
           COUNT(*)    FILTER (WHERE direction = 'IN')  AS in_count,
           SUM(meters) FILTER (WHERE direction = 'OUT' AND kind = 'normal') AS out_m, -- opening adjustments are not dispatches
           COUNT(*)    FILTER (WHERE direction = 'OUT' AND kind = 'normal') AS out_count
      FROM stock_movements
     WHERE ts >= CURRENT_DATE - 6 AND ts < CURRENT_DATE + 1
     GROUP BY 1
  )
  SELECT
    -- On-hand total scans every in-stock lot (index-only); skipped when stock has not changed since the cached one ($1).
    CASE WHEN (SELECT last_value::text FROM stock_rev) = $1 THEN NULL
         ELSE (SELECT json_build_object('on_hand_m', COALESCE(SUM(bal_m), 0), 'active_lots', COUNT(*)) FROM lots WHERE bal_m > 0) END AS summary,
    (SELECT COALESCE(json_agg(json_build_object('lot_id', x.lot_id, 'quality', x.quality, 'balance', x.bal_m) ORDER BY x.bal_m, x.lot_id), '[]')
       FROM (SELECT lot_id, quality, bal_m FROM lots
              WHERE bal_m > 0 AND bal_m < COALESCE((SELECT low_stock_m FROM app_settings WHERE id = 1), 200)
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
         sm.grey_meters, sm.finished_meters, sm.mill_name, sm.weaver_name, l.quality, l.design, true AS is_today
    FROM stock_movements sm
    JOIN lots l ON sm.lot_id = l.lot_id
   WHERE sm.ts >= CURRENT_DATE AND sm.ts < CURRENT_DATE + 1
   ORDER BY sm.ts DESC, sm.id DESC
   LIMIT 100`;

const num = (v: unknown) => (v == null ? null : Number(v));

// Last on-hand total per server instance, keyed by stock_rev. Short TTL: a writer bumps the rev before it commits,
// so a total read in that instant could miss its change; it is recomputed within SUMMARY_TTL_MS at the latest.
let summaryCache: { rev: string; at: number; value: { on_hand_m: number; active_lots: number } } | null = null;
const SUMMARY_TTL_MS = 10_000;

async function snapshot() {
  const cached = summaryCache && Date.now() - summaryCache.at < SUMMARY_TTL_MS ? summaryCache : null;
  const [s, t] = await Promise.all([query(SNAPSHOT_SQL, [cached?.rev ?? '']), query(TODAY_ROWS_SQL)]);
  const x = s.rows[0];
  const rev = String(x.rev ?? '0');
  let summary = cached?.value ?? { on_hand_m: 0, active_lots: 0 };
  if (x.summary) {
    summary = { on_hand_m: Number(x.summary.on_hand_m ?? 0), active_lots: Number(x.summary.active_lots ?? 0) };
    summaryCache = { rev, at: Date.now(), value: summary };
  }
  const flow = (x.flow ?? []) as { day: string; in_m: number; out_m: number; in_count: number; out_count: number }[];
  const last = flow[flow.length - 1] ?? { in_m: 0, in_count: 0, out_m: 0, out_count: 0 };
  return {
    stockSummary: {
      on_hand_m: summary.on_hand_m,
      active_lots: summary.active_lots,
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
    const early = startEarly(request, snapshot); // overlaps the session check (one round trip instead of two)
    const a = await requireUser(request);
    if (!can(a.role, 'stock.quantity')) {
      return NextResponse.json({ stockSummary: null, ledger: [], names: { mills: [], weavers: [], parties: [] }, flow: [], qualities: [], rev: '0' });
    }
    return NextResponse.json(await (early ?? snapshot()), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// POST (owner): Add a manual stock movement.
// IN:  lot_id, grey_meters and/or finished_meters, mill_name, weaver_name, source_doc, location, quality + design (new lot)
// OUT: lot_id, meters, party (destination client, required), source_doc
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
    // import_ref is only set by the Excel import.
    const input = { ...body, import_ref: null, capture_event_id: null, moved_by: a.by, add_shops_by: (canAddShops(a.role) ? a.by : false) as string | false };
    const movement = await withTransaction((q) =>
      direction === 'IN'
        ? recordIncoming(q, input, { requireLotDetails: true })
        : recordOutgoing(q, input)
    );
    return NextResponse.json({ success: true, movement });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
