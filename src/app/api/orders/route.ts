import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { actorOf, requireCap, readObject } from '@/lib/apiAuth';
import { createOrder, listOrders } from '@/lib/sales/orders';

// GET ?status=open|partly_dispatched|dispatched|cancelled|all (comma list; "open" = open + partly dispatched)&party_id=&role=
// → { orders: Order[] }  (supervisor: rate_per_m is null)
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const role = requireCap(sp.get('role'), 'orders.view');
    const orders = await listOrders(query, { status: sp.get('status'), party_id: sp.get('party_id'), role, limit: Number(sp.get('limit')) || 300 });
    return NextResponse.json({ orders }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// POST (owner) { party | party_id, quality, design?, meters, rate_per_m?, promise_date?, notes?, role, actor } → { order, warnings }
export async function POST(req: NextRequest) {
  try {
    const b = await readObject(req);
    requireCap(b.role, 'orders.manage');
    const res = await withTransaction((q) => createOrder(q, { ...b, inquiry_id: null }, actorOf(b.actor)));
    return NextResponse.json(res);
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
