import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

// GET /api/stock/flow?range=day|week|month|year|all[&quality=Georgette]
//   day   → today, by hour        week  → last 7 days, by day
//   month → last 30 days, by day  year  → last 12 months, by month
//   all   → every year on record, by year
// Returns IN/OUT meters per bucket + IN/OUT per quality for the same period (demand by quality).
const RANGES = {
  day: { from: `date_trunc('day', now())`, to: `date_trunc('day', now()) + interval '23 hours'`, step: '1 hour', unit: 'hour' },
  week: { from: `current_date - 6`, to: `current_date`, step: '1 day', unit: 'day' },
  month: { from: `current_date - 29`, to: `current_date`, step: '1 day', unit: 'day' },
  year: { from: `date_trunc('month', now()) - interval '11 months'`, to: `date_trunc('month', now())`, step: '1 month', unit: 'month' },
  all: {
    from: `date_trunc('year', COALESCE((SELECT MIN(ts) FROM stock_movements), now()))`,
    to: `date_trunc('year', now())`,
    step: '1 year',
    unit: 'year',
  },
} as const;
type Range = keyof typeof RANGES;

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const range = (sp.get('range') ?? 'week') as Range;
    if (!(range in RANGES)) return NextResponse.json({ error: 'range must be day, week, month, year or all.' }, { status: 400 });
    const quality = sp.get('quality')?.trim().slice(0, 100) || null;
    const r = RANGES[range];
    // Only fixed SQL fragments from RANGES are interpolated; user input goes in $1.
    const buckets = await query(
      `WITH b AS (SELECT generate_series(${r.from}, ${r.to}, interval '${r.step}') AS t)
       SELECT to_char(b.t, 'YYYY-MM-DD"T"HH24:MI') AS key,
              COALESCE(SUM(CASE WHEN sm.direction = 'IN' THEN sm.meters END), 0) AS in_m,
              COALESCE(SUM(CASE WHEN sm.direction = 'OUT' THEN sm.meters END), 0) AS out_m
       FROM b
       LEFT JOIN stock_movements sm ON date_trunc('${r.unit}', sm.ts) = b.t
         AND ($1::text IS NULL OR sm.lot_id IN (SELECT lot_id FROM lots WHERE quality = $1))
       GROUP BY b.t ORDER BY b.t`,
      [quality],
    );
    const qualities = await query(
      `SELECT l.quality,
              COALESCE(SUM(CASE WHEN sm.direction = 'IN' THEN sm.meters END), 0) AS in_m,
              COALESCE(SUM(CASE WHEN sm.direction = 'OUT' THEN sm.meters END), 0) AS out_m,
              COUNT(DISTINCT sm.lot_id) AS lots,
              COUNT(DISTINCT sm.party) FILTER (WHERE sm.direction = 'OUT') AS parties
       FROM stock_movements sm JOIN lots l ON l.lot_id = sm.lot_id
       WHERE sm.ts >= ${r.from}
       GROUP BY l.quality ORDER BY out_m DESC, in_m DESC LIMIT 25`,
    );
    const allQualities = await query(`SELECT DISTINCT quality FROM lots ORDER BY quality`);
    const num = (v: unknown) => parseFloat(String(v ?? 0));
    return NextResponse.json(
      {
        range,
        unit: r.unit,
        quality,
        buckets: buckets.rows.map((x) => ({ key: x.key, in_m: num(x.in_m), out_m: num(x.out_m) })),
        qualities: qualities.rows.map((x) => ({ quality: x.quality, in_m: num(x.in_m), out_m: num(x.out_m), lots: Number(x.lots), parties: Number(x.parties) })),
        allQualities: allQualities.rows.map((x) => x.quality as string),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[stock/flow] failed', error);
    return NextResponse.json({ error: 'Could not load stock flow.' }, { status: 500 });
  }
}
