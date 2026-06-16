import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { extractDataFromPhoto } from '@/lib/ai';
import fs from 'fs';
import path from 'path';

const CONFIDENCE_THRESHOLD = 0.80; // 80% confidence required to auto-commit

export async function GET() {
  // GET: Fetch all capture events (e.g. for the confirm queue)
  try {
    const res = await query(
      `SELECT ce.*, u.name as confirmed_by_name
       FROM capture_events ce
       LEFT JOIN users u ON ce.confirmed_by = u.id
       ORDER BY ce.ts DESC`
    );
    return NextResponse.json({
      events: res.rows.map(row => ({
        ...row,
        confidence: parseFloat(row.confidence)
      }))
    });
  } catch (error) {
    console.error('Failed to fetch capture events:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    const type = formData.get('type') as 'incoming_stock' | 'outgoing_stock' | 'job_card_folding';

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded.' }, { status: 400 });
    }

    if (!type || !['incoming_stock', 'outgoing_stock', 'job_card_folding'].includes(type)) {
      return NextResponse.json(
        { error: 'Invalid or missing capture type. Must be incoming_stock, outgoing_stock, or job_card_folding.' },
        { status: 400 }
      );
    }

    // 1. Create upload directory if it doesn't exist
    const uploadDir = path.join(process.cwd(), 'public', 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // 2. Write file to public/uploads
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    
    // Create unique filename
    const fileExt = path.extname(file.name) || '.jpg';
    const timestamp = Date.now();
    const safeName = `${type}_${timestamp}${fileExt}`;
    const filePath = path.join(uploadDir, safeName);
    
    fs.writeFileSync(filePath, buffer);
    const photoUrl = `/uploads/${safeName}`;

    // 3. Trigger AI vision extraction
    console.log(`[Capture API] Initiating vision extraction for type: ${type}, file: ${safeName}`);
    const extraction = await extractDataFromPhoto(filePath, type);

    if (!extraction.success) {
      return NextResponse.json(
        { error: 'AI vision extraction failed.', details: extraction.rawResponse },
        { status: 500 }
      );
    }

    const { data: aiData, confidence } = extraction;

    // 4. Save capture event to DB in a pending state
    const insertEventRes = await query(
      `INSERT INTO capture_events (photo_url, type, ai_json, confidence, status)
       VALUES ($1, $2, $3, $4, 'pending') RETURNING *`,
      [photoUrl, type, JSON.stringify(aiData), confidence]
    );
    const event = insertEventRes.rows[0];

    // 5. If confidence >= threshold, attempt auto-commit
    let autoCommitted = false;
    let commitError = null;

    if (confidence >= CONFIDENCE_THRESHOLD) {
      await query('BEGIN');
      try {
        if (type === 'incoming_stock') {
          const { lot_id, quality, design, meters, party, source_doc } = aiData;
          if (lot_id && meters) {
            // Check if lot exists, else create it
            const lotCheck = await query('SELECT 1 FROM lots WHERE lot_id = $1', [lot_id]);
            if (lotCheck.rowCount === 0) {
              await query(
                `INSERT INTO lots (lot_id, quality, design, grade, status)
                 VALUES ($1, $2, $3, 'A', 'active')`,
                [lot_id, quality || 'Unknown Quality', design || 'Unknown Design']
              );
            }
            // Record stock movement
            await query(
              `INSERT INTO stock_movements (lot_id, direction, meters, party, source_doc_id, capture_event_id)
               VALUES ($1, 'IN', $2, $3, $4, $5)`,
              [lot_id, meters, party || null, source_doc || null, event.id]
            );
            
            // Mark event as confirmed
            await query(
              `UPDATE capture_events SET status = 'confirmed', confirmed_by = 'usr-owner' WHERE id = $1`,
              [event.id]
            );
            autoCommitted = true;
          }
        } else if (type === 'outgoing_stock') {
          const { lot_id, meters, party, source_doc } = aiData;
          if (lot_id && meters) {
            // Verify sufficient balance before auto-commit
            const balanceCheck = await query(
              `SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN meters ELSE -meters END), 0) as balance 
               FROM stock_movements WHERE lot_id = $1`,
              [lot_id]
            );
            const currentBalance = parseFloat(balanceCheck.rows[0].balance || 0);

            if (currentBalance >= parseFloat(String(meters))) {
              await query(
                `INSERT INTO stock_movements (lot_id, direction, meters, party, source_doc_id, capture_event_id)
                 VALUES ($1, 'OUT', $2, $3, $4, $5)`,
                [lot_id, meters, party || null, source_doc || null, event.id]
              );
              // Mark event as confirmed
              await query(
                `UPDATE capture_events SET status = 'confirmed', confirmed_by = 'usr-owner' WHERE id = $1`,
                [event.id]
              );
              autoCommitted = true;
            } else {
              commitError = `Sufficient stock balance not available for auto-commit. Lot has ${currentBalance} meters, dispatch requested ${meters} meters. Leaving in review queue.`;
            }
          }
        } else if (type === 'job_card_folding') {
          const { job_card_id, meters_out } = aiData;
          if (job_card_id && meters_out !== undefined) {
            // Update job card
            const updateRes = await query(
              `UPDATE job_cards 
               SET meters_out = $1, status = 'closed', ts_closed = NOW()
               WHERE id = $2 
               RETURNING *`,
              [meters_out, job_card_id]
            );
            
            if (updateRes.rowCount !== null && updateRes.rowCount > 0) {
              const updatedJobCard = updateRes.rows[0];
              // Update daily efficiency
              const totalAllotted = parseFloat(updatedJobCard.meters_in);
              const totalDone = parseFloat(String(meters_out));
              const efficiencyPct = totalAllotted > 0 ? (totalDone / totalAllotted) * 100 : 0;
              
              await query(
                `INSERT INTO efficiency_daily (worker_id, date, allotted, done, efficiency_pct, flagged)
                 VALUES ($1, CURRENT_DATE, $2, $3, $4, $5)
                 ON CONFLICT (worker_id, date) DO UPDATE 
                 SET allotted = $2, done = $3, efficiency_pct = $4, flagged = $5`,
                [updatedJobCard.worker_id, totalAllotted, totalDone, efficiencyPct, efficiencyPct < 85.0]
              );
              
              // Mark event as confirmed
              await query(
                `UPDATE capture_events SET status = 'confirmed', confirmed_by = 'usr-owner' WHERE id = $1`,
                [event.id]
              );
              autoCommitted = true;
            } else {
              commitError = `Job card ID ${job_card_id} not found. Leaving in review queue.`;
            }
          }
        }
        await query('COMMIT');
      } catch (txErr) {
        await query('ROLLBACK');
        commitError = String(txErr);
        console.error('[Capture API] Transaction error during auto-commit:', txErr);
      }
    }

    return NextResponse.json({
      success: true,
      event: {
        ...event,
        status: autoCommitted ? 'confirmed' : 'pending',
        confidence: parseFloat(event.confidence)
      },
      extracted: aiData,
      autoCommitted,
      commitError
    });

  } catch (error) {
    console.error('Failed to handle photo capture:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
