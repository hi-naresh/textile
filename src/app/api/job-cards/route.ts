import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { closeJobCard, createJobCard, errorResponseBody } from '@/lib/ledger';
import { readRules } from '@/lib/settings';


// GET: Fetch all job cards and allotments
export async function GET() {
  try {
    const jobCardsQuery = `
      SELECT 
        jc.*, 
        w.name as worker_name, 
        w.section as worker_section,
        l.quality,
        l.design,
        -- Calculate shortage pct
        CASE 
          WHEN jc.meters_out IS NOT NULL AND jc.meters_in > 0 
          THEN ROUND((jc.shortage / jc.meters_in * 100)::numeric, 2)
          ELSE 0.00
        END as shortage_pct
      FROM job_cards jc
      JOIN workers w ON jc.worker_id = w.id
      JOIN lots l ON jc.lot_id = l.lot_id
      ORDER BY jc.id DESC
    `;
    const jobCardsRes = await query(jobCardsQuery);

    const allotmentsQuery = `
      SELECT a.*, to_char(a.date, 'YYYY-MM-DD') as date_str, (a.date = CURRENT_DATE) as is_today,
             w.name as worker_name, jc.process, jc.lot_id
      FROM allotments a
      JOIN workers w ON a.worker_id = w.id
      JOIN job_cards jc ON a.job_card_id = jc.id
      ORDER BY a.date DESC, a.id DESC
    `;
    const allotmentsRes = await query(allotmentsQuery);

    const { shortageLimitPct: SHORTAGE_THRESHOLD_PCT } = await readRules();
    const formattedJobCards = jobCardsRes.rows.map(row => {
      const shortagePct = parseFloat(row.shortage_pct);
      const isFlagged = row.meters_out !== null && shortagePct > SHORTAGE_THRESHOLD_PCT;
      return {
        ...row,
        meters_in: parseFloat(row.meters_in),
        meters_out: row.meters_out !== null ? parseFloat(row.meters_out) : null,
        shortage: row.shortage !== null ? parseFloat(row.shortage) : null,
        shortage_pct: shortagePct,
        flagged: isFlagged
      };
    });

    return NextResponse.json({
      jobCards: formattedJobCards,
      allotments: allotmentsRes.rows.map(row => ({
        ...row,
        meters_allotted: parseFloat(row.meters_allotted)
      }))
    });
  } catch (error) {
    console.error('Failed to fetch job cards:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST: Create a job card, allot it to the worker, and move the lot to the floor.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const jobCard = await withTransaction((q) => createJobCard(q, { ...body, moved_by: body.moved_by ?? null }));
    return NextResponse.json({ success: true, jobCard });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// PATCH: Close a job card with meters_out (updates worker efficiency; lot returns to godown when its last card closes).
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const jobCard = await withTransaction((q) => closeJobCard(q, { id: body.id, meters_out: body.meters_out, moved_by: body.moved_by ?? null }));
    const { shortageLimitPct } = await readRules();
    return NextResponse.json({ success: true, jobCard: { ...jobCard, flagged: jobCard.shortage_pct > shortageLimitPct } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
