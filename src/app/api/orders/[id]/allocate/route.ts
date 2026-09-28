import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { requireCap, readObject } from '@/lib/apiAuth';
import { autoAllocate, manualAllocate } from '@/lib/sales/allocate';
import { getOrder } from '@/lib/sales/orders';
import { idValue } from '@/lib/sales/util';

// POST (owner / supervisor) { auto: true } → reserve free lots for what the order still needs;
//              { lot_id, meters } → reserve one lot (≤ its free stock, same quality).
// → { allocations: [{ id, lot_id, meters }], allocated_m, short_m, order }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { role, by: actor } = await requireCap(req, 'orders.allocate');
    const b = await readObject(req);
    const orderId = idValue((await params).id, 'order');
    const res = await withTransaction((q) => (b.auto ? autoAllocate(q, orderId, actor) : manualAllocate(q, orderId, b.lot_id, b.meters, actor)));
    // Re-read the order for the caller's role (supervisors never get the ₹ rate).
    return NextResponse.json({ ...res, order: await getOrder(query, orderId, role) });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
