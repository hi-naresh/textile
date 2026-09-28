import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { requireCap } from '@/lib/apiAuth';
import { can } from '@/lib/access';
import { getDispatch } from '@/lib/dispatch/dispatches';

// GET /api/dispatches/<id>?role= → { dispatch, lines: [{ movement_id, lot_id, quality, design, meters, order_id }] }
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const role = requireCap(req.nextUrl.searchParams.get('role'), 'dispatch.manage');
    const { id } = await params;
    const out = await getDispatch(query, Number(id), can(role, 'finance.view'));
    return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
