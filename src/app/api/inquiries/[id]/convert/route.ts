import { NextRequest, NextResponse } from 'next/server';
import { withTransaction } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { actorOf, requireCap, readObject } from '@/lib/apiAuth';
import { convertInquiry } from '@/lib/sales/inquiries';

// POST { role: 'owner', actor, party?, quality?, design?, meters?, rate_per_m?, promise_date?, notes? } → { order, warnings }
// Creates the order (party added if new), marks the inquiry won.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const b = await readObject(req);
    requireCap(b.role, 'orders.manage');
    const { id } = await params;
    const res = await withTransaction((q) => convertInquiry(q, id, b, actorOf(b.actor)));
    return NextResponse.json(res);
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
