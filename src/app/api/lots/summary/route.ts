import { NextRequest, NextResponse } from 'next/server';
import { requireCap } from '@/lib/apiAuth';
import { can } from '@/lib/access';
import { query } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { lotFiltersFrom, lotsSummary } from '@/lib/lots-query';

// GET /api/lots/summary?<same filters as /api/lots> → { summary: lots, in_stock_lots, on_hand_m, in_m, out_m, qualities, packed_lots, running_lots, final_m }
export async function GET(req: NextRequest) {
  try {
    const a = await requireCap(req, 'stock.quantity');
    const f = lotFiltersFrom(req.nextUrl.searchParams);
    if (f.closed && !can(a.role, 'stock.closed')) throw new LedgerError('Closed lots are only for the owner.', 403);
    return NextResponse.json({ summary: await lotsSummary((t, p) => query(t, p), f) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
