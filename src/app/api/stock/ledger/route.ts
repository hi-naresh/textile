import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/apiAuth';
import { can } from '@/lib/access';
import { query } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { decodeCursor, filtersFrom, ledgerFacets, ledgerPage } from '@/lib/ledger-query';

// GET /api/stock/ledger?q=&direction=IN|OUT&quality=&design=&lot=&party=&from=YYYY-MM-DD&to=&limit=100&cursor=&facets=1
// Newest first, keyset-paged on (ts, id). → { rows, next (cursor or null), total (first page only), facets? }
// Owner / supervisor (no ₹ in these rows); workers get nothing.
export async function GET(req: NextRequest) {
  try {
    const a = await requireUser(req);
    const sp = req.nextUrl.searchParams;
    if (!can(a.role, 'stock.quantity')) return NextResponse.json({ rows: [], next: null, total: 0 });
    const cursorText = sp.get('cursor');
    const cursor = decodeCursor(cursorText);
    if (cursorText && !cursor) return NextResponse.json({ error: 'The page link is not valid. Reload the ledger.' }, { status: 400 });
    const limit = Math.min(500, Math.max(1, Number.parseInt(sp.get('limit') ?? '100', 10) || 100));
    const run = (text: string, params?: unknown[]) => query(text, params);
    const [page, facets] = await Promise.all([
      ledgerPage(run, filtersFrom(sp), { limit, cursor }),
      sp.get('facets') === '1' ? ledgerFacets(run) : Promise.resolve(undefined),
    ]);
    return NextResponse.json({ ...page, ...(facets ? { facets } : {}) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
