import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

// GET: Fetch lots, running stock balances, and ledger history
export async function GET() {
  try {
    // 1. Fetch all lots with their derived running stock balances
    const balanceQuery = `
      SELECT 
        l.lot_id, 
        l.quality, 
        l.design, 
        l.grade, 
        l.status,
        COALESCE(SUM(CASE WHEN sm.direction = 'IN' THEN sm.meters ELSE -sm.meters END), 0) as balance
      FROM lots l
      LEFT JOIN stock_movements sm ON l.lot_id = sm.lot_id
      GROUP BY l.lot_id, l.quality, l.design, l.grade, l.status
      ORDER BY l.lot_id DESC
    `;
    const balanceRes = await query(balanceQuery);

    // 2. Fetch full ledger history
    const ledgerQuery = `
      SELECT sm.*, l.quality, l.design
      FROM stock_movements sm
      JOIN lots l ON sm.lot_id = l.lot_id
      ORDER BY sm.ts DESC, sm.id DESC
      LIMIT 100
    `;
    const ledgerRes = await query(ledgerQuery);

    return NextResponse.json({
      lots: balanceRes.rows.map(row => ({
        ...row,
        balance: parseFloat(row.balance)
      })),
      ledger: ledgerRes.rows.map(row => ({
        ...row,
        meters: parseFloat(row.meters)
      }))
    });
  } catch (error) {
    console.error('Failed to fetch stock data:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST: Add a new manual stock movement (or called by confirm flow)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { lot_id, direction, meters, party, source_doc, quality, design } = body;

    if (!lot_id || !direction || !meters) {
      return NextResponse.json(
        { error: 'lot_id, direction, and meters are required.' },
        { status: 400 }
      );
    }

    const metersNum = parseFloat(meters);
    if (isNaN(metersNum) || metersNum <= 0) {
      return NextResponse.json(
        { error: 'meters must be a valid positive number.' },
        { status: 400 }
      );
    }

    // Begin database transaction
    await query('BEGIN');

    try {
      // 1. If incoming, create the lot if it doesn't exist
      if (direction === 'IN') {
        const lotCheck = await query('SELECT 1 FROM lots WHERE lot_id = $1', [lot_id]);
        if (lotCheck.rowCount === 0) {
          if (!quality || !design) {
            await query('ROLLBACK');
            return NextResponse.json(
              { error: 'quality and design are required to create a new lot.' },
              { status: 400 }
            );
          }
          await query(
            `INSERT INTO lots (lot_id, quality, design, grade, status) 
             VALUES ($1, $2, $3, 'A', 'active')`,
            [lot_id, quality, design]
          );
        }
      } else {
        // For OUT, make sure lot exists
        const lotCheck = await query('SELECT 1 FROM lots WHERE lot_id = $1', [lot_id]);
        if (lotCheck.rowCount === 0) {
          await query('ROLLBACK');
          return NextResponse.json(
            { error: `Lot ${lot_id} does not exist.` },
            { status: 400 }
          );
        }

        // FR-1.6: Prevent or flag if outgoing exceeds available balance
        const balanceCheck = await query(
          `SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN meters ELSE -meters END), 0) as balance 
           FROM stock_movements WHERE lot_id = $1`,
          [lot_id]
        );
        const currentBalance = parseFloat(balanceCheck.rows[0].balance);
        if (currentBalance < metersNum) {
          await query('ROLLBACK');
          return NextResponse.json(
            { error: `Insufficient stock. Lot ${lot_id} only has ${currentBalance} meters available (requested ${metersNum} meters).` },
            { status: 400 }
          );
        }
      }

      // 2. Insert movement
      const insertRes = await query(
        `INSERT INTO stock_movements (lot_id, direction, meters, party, source_doc_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [lot_id, direction, metersNum, party || null, source_doc || null]
      );

      await query('COMMIT');

      return NextResponse.json({
        success: true,
        movement: insertRes.rows[0]
      });
    } catch (txErr) {
      await query('ROLLBACK');
      throw txErr;
    }
  } catch (error) {
    console.error('Failed to post stock movement:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
