import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/apiAuth';
import { can } from '@/lib/access';
import { query } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { decodeCursor, filtersFrom, ledgerFacets, ledgerPage } from '@/lib/ledger-query';
import { startEarly } from '@/lib/lots-query';

// GET /api/stock/ledger?q=&direction=IN|OUT&quality=&design=&lot=&party=&from=YYYY-MM-DD&to=&today=1&limit=100&cursor=&facets=1
// Newest first, keyset-paged on (ts, id).
// → { rows, next (cursor or null), total (first page only), total_capped (true → show "10,000+"), facets? }
// Owner / supervisor (no ₹ in these rows); workers get nothing.
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const cursorText = sp.get('cursor');
    const cursor = decodeCursor(cursorText);
    if (cursorText && !cursor) return NextResponse.json({ error: 'The page link is not valid. Reload the ledger.' }, { status: 400 });
    const limit = Math.min(500, Math.max(1, Number.parseInt(sp.get('limit') ?? '100', 10) || 100));
    const run = (text: string, params?: unknown[]) => query(text, params);
    const load = () => Promise.all([
      ledgerPage(run, filtersFrom(sp), { limit, cursor }),
      sp.get('facets') === '1' ? ledgerFacets(run) : Promise.resolve(undefined),
    ]);
    const early = startEarly(req, load); // overlaps the session check
    const a = await requireUser(req);
    if (!can(a.role, 'stock.quantity')) return NextResponse.json({ rows: [], next: null, total: 0, total_capped: false });
    const [page, facets] = await (early ?? load());
    return NextResponse.json({ ...page, ...(facets ? { facets } : {}) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
