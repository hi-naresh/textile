import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { requireCap } from '@/lib/apiAuth';
import { allocationCandidates } from '@/lib/sales/allocate';

// GET ?role=owner → { need_m, lots: [{ lot_id, quality, design, balance, reserved, free, location, last_move, design_match }] }
// Lots of the order's quality with free stock (same design first) — for manual allocation.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireCap(req.nextUrl.searchParams.get('role'), 'orders.allocate'); // meters only, no ₹
    const { id } = await params;
    const { need_m, lots } = await allocationCandidates(query, id);
    return NextResponse.json({ need_m, lots }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
