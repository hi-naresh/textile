import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { requireCap, readObject } from '@/lib/apiAuth';
import { cancelInvoice, getInvoice } from '@/lib/dispatch/invoices';

// GET /api/invoices/<id> (owner) → { invoice }
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireCap(req, 'finance.view');
    const { id } = await params;
    return NextResponse.json({ invoice: await getInvoice(query, Number(id)) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// PATCH /api/invoices/<id> (owner) { status: 'cancelled' } → { invoice }
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireCap(req, 'finance.view');
    const b = await readObject(req);
    if (b.status !== 'cancelled') throw new LedgerError('Only cancelling is supported (status: "cancelled").');
    const { id } = await params;
    const invoice = await withTransaction((q) => cancelInvoice(q, Number(id)));
    return NextResponse.json({ success: true, invoice });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
