import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { requireCap, readObject } from '@/lib/apiAuth';
import { getInquiry, updateInquiry } from '@/lib/sales/inquiries';

type Ctx = { params: Promise<{ id: string }> };

// GET → { inquiry, stock, rate, promise_date }
export async function GET(req: NextRequest, { params }: Ctx) {
  try {
    const { role } = await requireCap(req, 'inquiry.handle');
    const { id } = await params;
    return NextResponse.json(await getInquiry(query, id, role), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// PATCH { status?, quoted_rate? (owner), reply_draft?, meters?, quality?, design?, needed_by?, party_name?, source? }
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const { role } = await requireCap(req, 'inquiry.handle');
    const b = await readObject(req);
    const { id } = await params;
    const res = await withTransaction((q) => updateInquiry(q, id, b, role));
    return NextResponse.json(res);
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
