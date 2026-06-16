import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

const SHORTAGE_THRESHOLD_PCT = 3.0; // 3% shortage is flagged

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
      SELECT a.*, w.name as worker_name, jc.process, jc.lot_id
      FROM allotments a
      JOIN workers w ON a.worker_id = w.id
      JOIN job_cards jc ON a.job_card_id = jc.id
      ORDER BY a.date DESC, a.id DESC
    `;
    const allotmentsRes = await query(allotmentsQuery);

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

// POST: Create a new job card
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { lot_id, process, worker_id, meters_in, shift } = body;

    if (!lot_id || !process || !worker_id || !meters_in) {
      return NextResponse.json(
        { error: 'lot_id, process, worker_id, and meters_in are required.' },
        { status: 400 }
      );
    }

    const metersInNum = parseFloat(meters_in);
    if (isNaN(metersInNum) || metersInNum <= 0) {
      return NextResponse.json(
        { error: 'meters_in must be a valid positive number.' },
        { status: 400 }
      );
    }

    await query('BEGIN');

    try {
      // 1. Verify worker exists
      const workerCheck = await query('SELECT 1 FROM workers WHERE id = $1', [worker_id]);
      if (workerCheck.rowCount === 0) {
        await query('ROLLBACK');
        return NextResponse.json({ error: `Worker ${worker_id} does not exist.` }, { status: 400 });
      }

      // 2. Verify lot exists
      const lotCheck = await query('SELECT 1 FROM lots WHERE lot_id = $1', [lot_id]);
      if (lotCheck.rowCount === 0) {
        await query('ROLLBACK');
        return NextResponse.json({ error: `Lot ${lot_id} does not exist.` }, { status: 400 });
      }

      // 3. Create job card
      const jobCardRes = await query(
        `INSERT INTO job_cards (lot_id, process, worker_id, meters_in, status)
         VALUES ($1, $2, $3, $4, 'in-process') RETURNING *`,
        [lot_id, process, worker_id, metersInNum]
      );
      const newJobCard = jobCardRes.rows[0];

      // 4. Create allotment automatically
      await query(
        `INSERT INTO allotments (worker_id, job_card_id, meters_allotted, shift, date)
         VALUES ($1, $2, $3, $4, CURRENT_DATE)`,
        [worker_id, newJobCard.id, metersInNum, shift || 'Morning']
      );

      await query('COMMIT');

      return NextResponse.json({
        success: true,
        jobCard: newJobCard
      });
    } catch (txErr) {
      await query('ROLLBACK');
      throw txErr;
    }
  } catch (error) {
    console.error('Failed to create job card:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH: Record meters_out (folding completion) on a job card
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, meters_out } = body;

    if (!id || meters_out === undefined) {
      return NextResponse.json(
        { error: 'id and meters_out are required.' },
        { status: 400 }
      );
    }

    const metersOutNum = parseFloat(meters_out);
    if (isNaN(metersOutNum) || metersOutNum < 0) {
      return NextResponse.json(
        { error: 'meters_out must be a valid non-negative number.' },
        { status: 400 }
      );
    }

    // Update job card and set status to 'folded' or 'closed'
    const updateRes = await query(
      `UPDATE job_cards 
       SET meters_out = $1, status = 'closed', ts_closed = NOW()
       WHERE id = $2 
       RETURNING *`,
      [metersOutNum, id]
    );

    if (updateRes.rowCount === 0) {
      return NextResponse.json({ error: `Job card ${id} not found.` }, { status: 404 });
    }

    const updatedJobCard = updateRes.rows[0];
    const shortage = parseFloat(updatedJobCard.meters_in) - metersOutNum;
    const shortagePct = (shortage / parseFloat(updatedJobCard.meters_in)) * 100;
    const isFlagged = shortagePct > SHORTAGE_THRESHOLD_PCT;

    // Check if worker has an efficiency_daily entry for today, if so update it, else insert
    try {
      const workerId = updatedJobCard.worker_id;
      // Get all allotments for this worker today
      const workerSummaryRes = await query(
        `SELECT 
          COALESCE(SUM(meters_allotted), 0) as total_allotted,
          COALESCE(SUM(CASE WHEN status = 'closed' THEN meters_out ELSE 0 END), 0) as total_done
         FROM job_cards jc
         JOIN allotments a ON a.job_card_id = jc.id
         WHERE jc.worker_id = $1 AND a.date = CURRENT_DATE`,
        [workerId]
      );
      
      const totalAllotted = parseFloat(workerSummaryRes.rows[0].total_allotted);
      const totalDone = parseFloat(workerSummaryRes.rows[0].total_done);
      const efficiencyPct = totalAllotted > 0 ? (totalDone / totalAllotted) * 100 : 0;
      
      await query(
        `INSERT INTO efficiency_daily (worker_id, date, allotted, done, efficiency_pct, flagged)
         VALUES ($1, CURRENT_DATE, $2, $3, $4, $5)
         ON CONFLICT (worker_id, date) DO UPDATE 
         SET allotted = $2, done = $3, efficiency_pct = $4, flagged = $5`,
        [workerId, totalAllotted, totalDone, efficiencyPct, efficiencyPct < 85.0] // Flag if under 85%
      );
    } catch (effErr) {
      console.error('Error updating worker efficiency:', effErr);
      // Don't crash job card completion if efficiency roll-up fails
    }

    return NextResponse.json({
      success: true,
      jobCard: {
        ...updatedJobCard,
        meters_in: parseFloat(updatedJobCard.meters_in),
        meters_out: parseFloat(updatedJobCard.meters_out),
        shortage,
        shortage_pct: shortagePct,
        flagged: isFlagged
      }
    });
  } catch (error) {
    console.error('Failed to complete job card:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
