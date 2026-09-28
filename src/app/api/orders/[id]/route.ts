import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { requireCap, readObject } from '@/lib/apiAuth';
import { getOrder, orderAllocations, updateOrder } from '@/lib/sales/orders';

type Ctx = { params: Promise<{ id: string }> };

// GET ?role= → { order, allocations }
export async function GET(req: NextRequest, { params }: Ctx) {
  try {
    const role = requireCap(req.nextUrl.searchParams.get('role'), 'orders.view');
    const { id } = await params;
    const order = await getOrder(query, id, role);
    const allocations = await orderAllocations(query, order.id);
    return NextResponse.json({ order, allocations }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// PATCH (owner) { party?|party_id?, quality?, design?, meters?, rate_per_m?, promise_date?, notes?, status?: 'cancelled', role, actor }
// → { order, message, warnings }. Cancelling releases the order's reserved lots.
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const b = await readObject(req);
    requireCap(b.role, 'orders.manage');
    const { id } = await params;
    const { role: _r, actor: _a, ...fields } = b;
    void _r; void _a;
    const res = await withTransaction((q) => updateOrder(q, id, fields));
    return NextResponse.json(res);
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
