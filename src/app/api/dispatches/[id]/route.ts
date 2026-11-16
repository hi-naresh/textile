import { editDispatch, dispatchEditHistory } from '@/lib/dispatch/edit';
import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { requireCap, readObject } from '@/lib/apiAuth';
import { can } from '@/lib/access';
import { getDispatch } from '@/lib/dispatch/dispatches';

// GET /api/dispatches/<id> → { dispatch, lines: [{ movement_id, lot_id, quality, design, meters, order_id }] }
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { role } = await requireCap(req, 'dispatch.manage');
    const { id } = await params;
    const out = await getDispatch(query, Number(id), can(role, 'finance.view'));
    return NextResponse.json({ ...out, edits: await dispatchEditHistory(query, Number(id)) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const a = await requireCap(req, 'ledger.edit');
    const { id } = await params;
    const body = await readObject(req);
    const out = await withTransaction((q) => editDispatch(q, Number(id), body, a.by));
    return NextResponse.json(out);
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
