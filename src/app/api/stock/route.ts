import { NextRequest, NextResponse } from 'next/server';
import { readObject, requireCap, requireUser } from '@/lib/apiAuth';
import { can } from '@/lib/access';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody, recordIncoming, recordOutgoing } from '@/lib/ledger';

// GET: Fetch lots, running stock balances, and ledger history (owner / supervisor; workers get nothing)
export async function GET(request: NextRequest) {
  try {
    const a = await requireUser(request);
    if (!can(a.role, 'stock.quantity')) {
      return NextResponse.json({ lots: [], ledger: [], names: { mills: [], weavers: [], parties: [] }, flow: [] });
    }
    // 1. Fetch all lots with their derived running stock balances
    const balanceQuery = `
      SELECT 
        l.lot_id, 
        l.quality, 
        l.design, 
        l.grade, 
        l.status,
        COALESCE(b.balance, 0) as balance,
        loc.location,
        loc.stage as location_stage,
        loc.ts as location_ts
      FROM lots l
      LEFT JOIN (
        SELECT lot_id, SUM(CASE WHEN direction = 'IN' THEN meters ELSE -meters END) as balance
        FROM stock_movements GROUP BY lot_id
      ) b ON b.lot_id = l.lot_id
      LEFT JOIN LATERAL (
        SELECT location, stage, ts FROM lot_locations ll
        WHERE ll.lot_id = l.lot_id
        ORDER BY ll.ts DESC, ll.id DESC LIMIT 1
      ) loc ON true
      ORDER BY l.lot_id DESC
    `;
    const balanceRes = await query(balanceQuery);

    // 2. Fetch full ledger history
    const ledgerQuery = `
      SELECT sm.*, l.quality, l.design, (sm.ts::date = CURRENT_DATE) AS is_today
      FROM stock_movements sm
      JOIN lots l ON sm.lot_id = l.lot_id
      ORDER BY sm.ts DESC, sm.id DESC
      LIMIT 100
    `;
    const ledgerRes = await query(ledgerQuery);

    const namesRes = await query(`
      SELECT DISTINCT 'mill' as kind, mill_name as name FROM stock_movements WHERE mill_name IS NOT NULL
      UNION SELECT DISTINCT 'weaver', weaver_name FROM stock_movements WHERE weaver_name IS NOT NULL
      UNION SELECT DISTINCT 'party', party FROM stock_movements WHERE direction = 'OUT' AND party IS NOT NULL
      ORDER BY 2
    `);

    // 3. Daily IN/OUT totals for the last 7 days (for the stock-flow chart)
    const flowRes = await query(`
      SELECT to_char(d::date, 'YYYY-MM-DD') as day,
        COALESCE(SUM(CASE WHEN sm.direction = 'IN' THEN sm.meters END), 0) as in_m,
        COALESCE(SUM(CASE WHEN sm.direction = 'OUT' THEN sm.meters END), 0) as out_m
      FROM generate_series(CURRENT_DATE - 6, CURRENT_DATE, interval '1 day') d
      LEFT JOIN stock_movements sm ON sm.ts::date = d::date
      GROUP BY d
      ORDER BY d
    `);

    // 4. Today's totals over ALL of today's movements (the ledger above is only the latest 100 rows)
    const todayRes = await query(`
      SELECT
        COALESCE(SUM(meters) FILTER (WHERE direction = 'IN'), 0) AS in_m,
        COUNT(*) FILTER (WHERE direction = 'IN') AS in_count,
        COALESCE(SUM(meters) FILTER (WHERE direction = 'OUT'), 0) AS out_m,
        COUNT(*) FILTER (WHERE direction = 'OUT') AS out_count
      FROM stock_movements
      WHERE ts >= CURRENT_DATE AND ts < CURRENT_DATE + 1
    `);
    const t = todayRes.rows[0];

    return NextResponse.json({
      today: { in_m: parseFloat(t.in_m), in_count: Number(t.in_count), out_m: parseFloat(t.out_m), out_count: Number(t.out_count) },
      lots: balanceRes.rows.map(row => ({
        ...row,
        balance: parseFloat(row.balance)
      })),
      // No ₹ here: this feed is shared with supervisors (purchase rates live in Money / costing).
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      ledger: ledgerRes.rows.map(({ purchase_rate: _pr, ...row }) => ({
        ...row,
        meters: parseFloat(row.meters),
        grey_meters: row.grey_meters !== null ? parseFloat(row.grey_meters) : null,
        finished_meters: row.finished_meters !== null ? parseFloat(row.finished_meters) : null
      })),
      // Names already used, to suggest while typing (keeps spellings consistent)
      names: {
        mills: namesRes.rows.filter(r => r.kind === 'mill').map(r => r.name),
        weavers: namesRes.rows.filter(r => r.kind === 'weaver').map(r => r.name),
        parties: namesRes.rows.filter(r => r.kind === 'party').map(r => r.name)
      },
      flow: flowRes.rows.map(row => ({
        day: row.day,
        in_m: parseFloat(row.in_m),
        out_m: parseFloat(row.out_m)
      }))
    });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// POST (owner): Add a manual stock movement.
// IN:  lot_id, grey_meters and/or finished_meters, mill_name, weaver_name, source_doc, location, quality + design (new lot)
// OUT: lot_id, meters, party (destination client, required), source_doc
// Both: sr_no (optional, whole number > 0, unique per direction → 409 when taken), pieces (optional taka, whole number ≥ 0)
export async function POST(request: NextRequest) {
  try {
    const a = await requireCap(request, 'ledger.edit');
    const body = await readObject(request);
    const direction = body?.direction;
    if (direction !== 'IN' && direction !== 'OUT') {
      return NextResponse.json({ error: 'direction must be IN or OUT.' }, { status: 400 });
    }
    // import_ref is only set by the Excel import.
    const input = { ...body, import_ref: null, capture_event_id: null, moved_by: a.by };
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
