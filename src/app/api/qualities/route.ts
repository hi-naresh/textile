import { NextRequest, NextResponse } from 'next/server';
import { readObject, requireCap, requireRole, requireUser } from '@/lib/apiAuth';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { addQuality, listQualities, updateQuality } from '@/lib/qualities';

// Quality catalog (migration 017).
// GET            (anyone signed in) → { qualities: [{ id, name, active, lots, in_stock_lots }] }
// POST  { name } (owner / supervisor) → add (or switch back on)
// PATCH { id, active?, name? } (owner) → switch off / on, or rename (lots with that quality are renamed too)
export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
    return NextResponse.json({ qualities: await listQualities((t, p) => query(t, p)) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

export async function POST(req: NextRequest) {
  try {
    const a = await requireRole(req, 'owner', 'supervisor');
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
