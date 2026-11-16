import { NextRequest, NextResponse } from 'next/server';
import { readObject, requireCap, requireUser } from '@/lib/apiAuth';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { addQuality, listQualities, updateQuality } from '@/lib/qualities';

// Quality catalog (migration 017).
// GET            (anyone signed in) → { qualities: [{ id, name, active, lots, in_stock_lots }] }
// POST  { name } (owner) → add (or switch back on)
// PATCH { id, active?, name? } (owner) → switch off / on, or rename (lots with that quality are renamed too)
export async function GET(req: NextRequest) {
  try {
    const a = await requireUser(req);
    const qualities = await listQualities((t, p) => query(t, p));
    const visible = a.role === 'owner' ? qualities : qualities.map(({ id, name, active }) => ({ id, name, active }));
    return NextResponse.json({ qualities: visible }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

export async function POST(req: NextRequest) {
  try {
    const a = await requireCap(req, 'master.manage');
    const b = await readObject(req);
    const quality = await withTransaction((q) => addQuality(q, b.name, a.by));
    return NextResponse.json({ success: true, quality });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await requireCap(req, 'ledger.edit');
    const b = await readObject(req);
    const quality = await withTransaction((q) => updateQuality(q, { id: b.id, active: b.active, name: b.name }));
    return NextResponse.json({ success: true, quality });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
