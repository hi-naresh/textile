import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/apiAuth';
import { can } from '@/lib/access';
import { query } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { filtersFrom, ledgerSummary } from '@/lib/ledger-query';

// GET /api/stock/ledger/summary?<same filters as /api/stock/ledger>
// → { summary: entries, lots, qualities, in_m / in_pieces / grey_m / finished_m / shortage_m / shortage_pct,
//     out_m / out_pieces, adjust_m, net_m, on_hand_m } for exactly the rows the filters match (all rows when none).
// Owner / supervisor; closed lots are left out for everyone but the owner (as in the ledger).
export async function GET(req: NextRequest) {
  try {
    const a = await requireUser(req);
    if (!can(a.role, 'stock.quantity')) return NextResponse.json({ summary: null });
    const f = { ...filtersFrom(req.nextUrl.searchParams), hideClosed: !can(a.role, 'stock.closed') };
    const summary = await ledgerSummary((t, p) => query(t, p), f);
    return NextResponse.json({ summary }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
