import { NextRequest, NextResponse } from 'next/server';
import { requireCap } from '@/lib/apiAuth';
import { can } from '@/lib/access';
import { query } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { filtersFrom, ledgerSummary } from '@/lib/ledger-query';

// GET /api/stock/ledger/summary?<same filters as /api/stock/ledger>
// → { summary: entries, lots, qualities, in_m / in_pieces / grey_m / finished_m / shortage_m / shortage_pct,
//     out_m / out_pieces, adjust_m, net_m, on_hand_m } for exactly the rows the filters match (all rows when none).
// Owner only; supervisors cannot request aggregate stock figures.
export async function GET(req: NextRequest) {
  try {
    const a = await requireCap(req, 'stock.summary');
    const f = { ...filtersFrom(req.nextUrl.searchParams), hideClosed: !can(a.role, 'stock.closed') };
    const summary = await ledgerSummary((t, p) => query(t, p), f);
    return NextResponse.json({ summary }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
