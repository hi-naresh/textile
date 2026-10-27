import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/apiAuth';
import { query } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { checkShop } from '@/lib/location';

// GET /api/markets/pipes?market_id=1&shop=245 → { pipes: ["A25", "3", …] }
// Every pipe no. already used at that shop (most used first), so pipes are picked instead of retyped.
export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
    const sp = req.nextUrl.searchParams;
    const marketId = Number.parseInt(sp.get('market_id') ?? '', 10);
    const shop = checkShop(sp.get('shop'));
    if (!Number.isFinite(marketId) || !shop.ok) return NextResponse.json({ pipes: [] });
    const r = await query(
      `SELECT p, count(*) AS n FROM lot_locations ll, LATERAL unnest(regexp_split_to_array(ll.pipe_no, ',\\s*')) AS p
        WHERE ll.market_id = $1 AND ll.shop_no = $2 AND ll.pipe_no IS NOT NULL AND p <> ''
        GROUP BY p ORDER BY n DESC, p LIMIT 300`,
      [marketId, shop.value],
    );
    return NextResponse.json({ pipes: r.rows.map((x) => String(x.p)) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
