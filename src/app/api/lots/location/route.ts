import { NextRequest, NextResponse } from 'next/server';
import { readObject, requireCap } from '@/lib/apiAuth';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody, LedgerError, moveLotManually } from '@/lib/ledger';
import { lotsByIds } from '@/lib/lots-query';

// GET /api/lots/location?lot_id=LOT-5021 → { history: full location history (newest first), lot: the lot now (balance, location) | null }
export async function GET(request: NextRequest) {
  try {
    await requireCap(request, 'stock.quantity');
    const lotId = request.nextUrl.searchParams.get('lot_id');
    if (!lotId) throw new LedgerError('lot_id is required.');
    const [res, lot] = await Promise.all([query(
      `SELECT ll.id, ll.lot_id, ll.location, ll.stage, ll.note, ll.job_card_id, ll.stock_movement_id, ll.ts, u.name AS moved_by_name
       FROM lot_locations ll
       LEFT JOIN users u ON u.id = ll.moved_by
       WHERE ll.lot_id = $1
       ORDER BY ll.ts DESC, ll.id DESC
       LIMIT 200`,
      [lotId]
    ), lotsByIds((text, params) => query(text, params), [lotId])]);
    return NextResponse.json({ history: res.rows, lot: lot[0] ?? null }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// POST { lot_id, location, note? } → move a lot (e.g. godown → shop). moved_by = the signed-in user.
export async function POST(request: NextRequest) {
  try {
    const a = await requireCap(request, 'lots.move');
    const body = await readObject(request);
    const entry = await withTransaction((q) => moveLotManually(q, { lot_id: body.lot_id, location: body.location, note: body.note, moved_by: a.by }));
    return NextResponse.json({ success: true, entry });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
