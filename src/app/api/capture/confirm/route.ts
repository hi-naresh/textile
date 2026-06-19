import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { event_id, confirmed_by, status, corrected_data } = body;

    if (!event_id || !confirmed_by || !status) {
      return NextResponse.json(
        { error: 'event_id, confirmed_by, and status are required.' },
        { status: 400 }
      );
    }

    if (!['confirmed', 'corrected', 'rejected'].includes(status)) {
      return NextResponse.json(
        { error: 'status must be either confirmed, corrected, or rejected.' },
        { status: 400 }
      );
    }

    // Begin database transaction
    await query('BEGIN');

    try {
      // 1. Fetch event
      const eventRes = await query('SELECT * FROM capture_events WHERE id = $1 FOR UPDATE', [event_id]);
      if (eventRes.rowCount === 0) {
        await query('ROLLBACK');
        return NextResponse.json({ error: `Capture event ${event_id} not found.` }, { status: 404 });
      }

      const event = eventRes.rows[0];
      if (event.status !== 'pending') {
        await query('ROLLBACK');
        return NextResponse.json({ error: `Capture event ${event_id} is already processed.` }, { status: 400 });
      }

      if (status === 'rejected') {
        // Just reject the event
        await query(
          `UPDATE capture_events SET status = 'rejected', confirmed_by = $1 WHERE id = $2`,
          [confirmed_by, event_id]
        );
        await query('COMMIT');
        return NextResponse.json({ success: true, message: 'Event rejected.' });
      }

      const finalData = status === 'corrected' ? corrected_data : event.ai_json;
      if (!finalData) {
        await query('ROLLBACK');
        return NextResponse.json({ error: 'Missing data to confirm.' }, { status: 400 });
      }

      // 2. Process based on event type
      if (event.type === 'incoming_stock') {
        const { lot_id, quality, design, meters, party, source_doc } = finalData;

        if (!lot_id || !meters) {
          await query('ROLLBACK');
          return NextResponse.json({ error: 'lot_id and meters are required to confirm stock.' }, { status: 400 });
        }

        const metersNum = parseFloat(String(meters));

        // Create lot if not exists
        const lotCheck = await query('SELECT 1 FROM lots WHERE lot_id = $1', [lot_id]);
        if (lotCheck.rowCount === 0) {
          await query(
            `INSERT INTO lots (lot_id, quality, design, grade, status)
             VALUES ($1, $2, $3, 'A', 'active')`,
            [lot_id, quality || 'Unknown Quality', design || 'Unknown Design']
          );
        }

        // Insert stock movement
        await query(
          `INSERT INTO stock_movements (lot_id, direction, meters, party, source_doc_id, capture_event_id)
           VALUES ($1, 'IN', $2, $3, $4, $5)`,
          [lot_id, metersNum, party || null, source_doc || null, event_id]
        );

      } else if (event.type === 'outgoing_stock') {
        const { lot_id, meters, party, source_doc } = finalData;

        if (!lot_id || !meters) {
          await query('ROLLBACK');
          return NextResponse.json({ error: 'lot_id and meters are required to confirm dispatch.' }, { status: 400 });
        }

        const metersNum = parseFloat(String(meters));

        // Verify balance
        const balanceCheck = await query(
          `SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN meters ELSE -meters END), 0) as balance 
           FROM stock_movements WHERE lot_id = $1`,
          [lot_id]
        );
        const currentBalance = parseFloat(balanceCheck.rows[0].balance || 0);

        if (currentBalance < metersNum) {
          await query('ROLLBACK');
          return NextResponse.json(
            { error: `Insufficient stock. Lot ${lot_id} has ${currentBalance} meters, dispatch requested ${metersNum} meters.` },
            { status: 400 }
          );
        }

        // Insert stock movement
        await query(
          `INSERT INTO stock_movements (lot_id, direction, meters, party, source_doc_id, capture_event_id)
           VALUES ($1, 'OUT', $2, $3, $4, $5)`,
          [lot_id, metersNum, party || null, source_doc || null, event_id]
        );

      } else if (event.type === 'job_card_folding') {
        const { job_card_id, meters_out, lot_id } = finalData;
        const fallbackLotId = lot_id || event.ai_json?.lot_id;

        if (meters_out === undefined) {
          await query('ROLLBACK');
          return NextResponse.json({ error: 'meters_out is required to confirm folding.' }, { status: 400 });
        }

        let resolvedJobCardId = job_card_id;
        if (!resolvedJobCardId && fallbackLotId) {
          const jcLookup = await query(
            `SELECT id FROM job_cards 
             WHERE lot_id = $1 AND status IN ('open', 'in-process') 
             ORDER BY ts_created DESC LIMIT 1`,
            [fallbackLotId]
          );
          if (jcLookup.rowCount !== null && jcLookup.rowCount > 0) {
            resolvedJobCardId = jcLookup.rows[0].id;
            console.log(`[Confirm API] Fallback resolved Job Card ID ${resolvedJobCardId} for Lot ${fallbackLotId}`);
          }
        }

        if (!resolvedJobCardId) {
          await query('ROLLBACK');
          return NextResponse.json({ error: 'job_card_id is required or must be resolvable from lot_id.' }, { status: 400 });
        }

        // Keep final data in sync with resolved id
        finalData.job_card_id = resolvedJobCardId;
        const metersOutNum = parseFloat(String(meters_out));

        // Update job card
        const updateRes = await query(
          `UPDATE job_cards 
           SET meters_out = $1, status = 'closed', ts_closed = NOW()
           WHERE id = $2 
           RETURNING *`,
          [metersOutNum, resolvedJobCardId]
        );

        if (updateRes.rowCount === 0) {
          await query('ROLLBACK');
          return NextResponse.json({ error: `Job card ${resolvedJobCardId} not found.` }, { status: 404 });
        }

        const updatedJobCard = updateRes.rows[0];

        // Update daily efficiency
        const totalAllotted = parseFloat(updatedJobCard.meters_in);
        const totalDone = metersOutNum;
        const efficiencyPct = totalAllotted > 0 ? (totalDone / totalAllotted) * 100 : 0;

        await query(
          `INSERT INTO efficiency_daily (worker_id, date, allotted, done, efficiency_pct, flagged)
           VALUES ($1, CURRENT_DATE, $2, $3, $4, $5)
           ON CONFLICT (worker_id, date) DO UPDATE 
           SET allotted = $2, done = $3, efficiency_pct = $4, flagged = $5`,
          [updatedJobCard.worker_id, totalAllotted, totalDone, efficiencyPct, efficiencyPct < 85.0]
        );
      }

      // 3. Update capture event status to confirmed/corrected
      await query(
        `UPDATE capture_events 
         SET status = $1, confirmed_by = $2, ai_json = $3 
         WHERE id = $4`,
        [status, confirmed_by, JSON.stringify(finalData), event_id]
      );

      await query('COMMIT');
      return NextResponse.json({ success: true });

    } catch (txErr) {
      await query('ROLLBACK');
      throw txErr;
    }
  } catch (error) {
    console.error('Failed to confirm capture event:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
