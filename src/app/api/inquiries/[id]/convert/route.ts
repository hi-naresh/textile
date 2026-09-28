import { NextRequest, NextResponse } from 'next/server';
import { withTransaction } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { requireCap, readObject } from '@/lib/apiAuth';
import { convertInquiry } from '@/lib/sales/inquiries';

// POST (owner) { party?, quality?, design?, meters?, rate_per_m?, promise_date?, notes? } → { order, warnings }
// Creates the order (party added if new), marks the inquiry won.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const a = await requireCap(req, 'orders.manage');
    const b = await readObject(req);
    const { id } = await params;
    const res = await withTransaction((q) => convertInquiry(q, id, b, a.by));
    return NextResponse.json(res);
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
