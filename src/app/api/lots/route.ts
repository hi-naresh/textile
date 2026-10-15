import { NextRequest, NextResponse } from 'next/server';
import { requireCap } from '@/lib/apiAuth';
import { can } from '@/lib/access';
import { query } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { lotFiltersFrom, lotsPage, startEarly } from '@/lib/lots-query';

// GET /api/lots?q=&status=active|completed|dispatched|hold&in_stock=1&limit=100&cursor=<last lot_id>
// "Lots & balance" on the Stock screen: lot no. newest first, keyset-paged, filtered on the server.
// → { rows: Lot[], next (cursor or null), total (first page only; capped), total_capped (true → "10,000+") }
// Owner / supervisor (meters only, no ₹). Closed lots are left out; &closed=1 lists only them, with how / when / who
// closed each and what was written off — owner only (stock.closed).
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const limit = Math.min(500, Math.max(1, Number.parseInt(sp.get('limit') ?? '100', 10) || 100));
    const cursor = (sp.get('cursor') ?? '').slice(0, 50) || null;
    const f = lotFiltersFrom(sp);
    const run = () => lotsPage((text, params) => query(text, params), f, { limit, cursor });
    const early = startEarly(req, run);
    const a = await requireCap(req, 'stock.quantity');
    if (f.closed && !can(a.role, 'stock.closed')) throw new LedgerError('Closed lots are only for the owner.', 403);
    return NextResponse.json(await (early ?? run()), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
