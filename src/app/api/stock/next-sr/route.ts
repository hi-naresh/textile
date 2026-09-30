import { NextRequest, NextResponse } from 'next/server';
import { requireCap } from '@/lib/apiAuth';
import { query } from '@/lib/db';
import { errorResponseBody, nextSr, srTaken, srValue } from '@/lib/ledger';

// GET /api/stock/next-sr?direction=IN|OUT[&sr=45]  (owner, like manual entry)
// → { direction, last, next, taken? } — `taken` (lot + date) when the given SR no. is already used in that direction.
export async function GET(req: NextRequest) {
  try {
    await requireCap(req, 'ledger.edit');
    const sp = req.nextUrl.searchParams;
    const direction = sp.get('direction');
    if (direction !== 'IN' && direction !== 'OUT') return NextResponse.json({ error: 'direction must be IN or OUT.' }, { status: 400 });
    const run = (text: string, params?: unknown[]) => query(text, params);
    const { last, next } = await nextSr(run, direction);
    const sr = srValue(sp.get('sr'));
    const taken = sr == null ? null : await srTaken(run, direction, sr);
    return NextResponse.json({ direction, last, next, ...(sr != null ? { sr, taken } : {}) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
