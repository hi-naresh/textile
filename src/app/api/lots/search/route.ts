import { NextRequest, NextResponse } from 'next/server';
import { requireCap } from '@/lib/apiAuth';
import { can } from '@/lib/access';
import { query } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { lotFiltersFrom, lotSearch, lotsByIds, startEarly } from '@/lib/lots-query';

// GET /api/lots/search?q=&limit=20&in_stock=1&quality=   → { lots: [{ lot_id, quality, design, balance, location, status, … }] }
//   Lot numbers starting with q first (lot-number order), then lots whose number / quality / design / location contains it.
//   Empty q → newest lots. All index-backed (migration 010).
// GET /api/lots/search?ids=A,B,C  → exactly those lots (≤ 50), e.g. the lines of a dispatch.
// Owner / supervisor. Closed lots never come back from the type-ahead; from ?ids= only for the owner (stock.closed).
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const limit = Math.min(100, Math.max(1, Number.parseInt(sp.get('limit') ?? '20', 10) || 20));
    const idsRaw = sp.get('ids');
    const ids = idsRaw == null ? null : [...new Set(idsRaw.split(',').map((s) => s.trim()).filter((s) => s && s.length <= 50))].slice(0, 50);
    const run = () => {
      const q = (text: string, params?: unknown[]) => query(text, params);
      return ids ? lotsByIds(q, ids) : lotSearch(q, lotFiltersFrom(sp), limit);
    };
    const early = startEarly(req, run);
    const a = await requireCap(req, 'stock.quantity');
    const lots = await (early ?? run());
    return NextResponse.json({ lots: can(a.role, 'stock.closed') ? lots : lots.filter((l) => !l.closed_at) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
