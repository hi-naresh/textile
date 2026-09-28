import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { actorOf, requireCap, readObject } from '@/lib/apiAuth';
import { createInquiry, listInquiries } from '@/lib/sales/inquiries';

// GET ?status=new|quoted|won|lost|all&role= → { inquiries }  (supervisor: no rates)
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const role = requireCap(sp.get('role'), 'inquiry.handle');
    const inquiries = await listInquiries(query, { status: sp.get('status'), role, limit: Number(sp.get('limit')) || 100 });
    return NextResponse.json({ inquiries }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// POST { raw_text, source?, party_name?, role, actor } → { inquiry, stock: { free, lots }, rate, promise_date }
export async function POST(req: NextRequest) {
  try {
    const b = await readObject(req);
    const role = requireCap(b.role, 'inquiry.handle');
    const res = await withTransaction((q) => createInquiry(q, b, role, actorOf(b.actor)));
    return NextResponse.json(res);
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
