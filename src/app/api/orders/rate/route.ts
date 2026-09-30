import { NextRequest, NextResponse } from 'next/server';
import { errorResponseBody } from '@/lib/ledger';
import { requireCap } from '@/lib/apiAuth';

// GET (owner) → { rate: null }
// Selling rates are turned off: every party gets its own rate, typed on each order, so there is
// nothing to suggest. Kept so an old screen that still calls it gets an empty answer, not a 404.
export async function GET(req: NextRequest) {
  try {
    await requireCap(req, 'orders.manage');
    return NextResponse.json({ rate: null }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
