import { NextRequest, NextResponse } from 'next/server';
import { withTransaction } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { requireCap } from '@/lib/apiAuth';
import { releaseAllocation } from '@/lib/sales/allocate';

// POST (owner / supervisor) → { id, order_id, lot_id, released_m }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireCap(req, 'orders.allocate');
    const { id } = await params;
    const res = await withTransaction((q) => releaseAllocation(q, id));
    return NextResponse.json(res);
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
