import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody, moveLotManually } from '@/lib/ledger';

// GET /api/lots/location?lot_id=LOT-5021 → full location history for one lot (newest first)
export async function GET(request: NextRequest) {
  const lotId = request.nextUrl.searchParams.get('lot_id');
  if (!lotId) return NextResponse.json({ error: 'lot_id is required.' }, { status: 400 });
  try {
    const res = await query(
      `SELECT ll.id, ll.lot_id, ll.location, ll.stage, ll.note, ll.job_card_id, ll.stock_movement_id, ll.ts, u.name AS moved_by_name
       FROM lot_locations ll
       LEFT JOIN users u ON u.id = ll.moved_by
       WHERE ll.lot_id = $1
       ORDER BY ll.ts DESC, ll.id DESC
       LIMIT 200`,
      [lotId]
    );
    return NextResponse.json({ history: res.rows });
  } catch (error) {
    console.error('Failed to fetch lot location history:', error);
    return NextResponse.json({ error: 'Could not load location history.' }, { status: 500 });
  }
}

// POST { lot_id, location, note?, moved_by? } → move a lot (e.g. godown → shop)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const entry = await withTransaction((q) => moveLotManually(q, body));
    return NextResponse.json({ success: true, entry });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
