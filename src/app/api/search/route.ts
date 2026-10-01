import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/apiAuth';
import { query } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { search } from '@/lib/search';

// GET ?q=&limit= → { q, groups: [{ type, label, hits: [{ type, id, title, subtitle, href, score }] }], ms }
// Only what the caller may see (src/lib/access.ts can()); supervisors never get ₹; workers get nothing.
export async function GET(req: NextRequest) {
  try {
    const a = await requireUser(req);
    const sp = req.nextUrl.searchParams;
    const res = await search(query, { role: a.role, userId: a.userId }, sp.get('q') ?? '', Number(sp.get('limit')) || 5);
    return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
