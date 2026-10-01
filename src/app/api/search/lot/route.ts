import { NextRequest, NextResponse } from 'next/server';
import { requireCap } from '@/lib/apiAuth';
import { query } from '@/lib/db';
import { LedgerError } from '@/lib/ledger-error';
import { errorResponseBody } from '@/lib/ledger';
import { lotDetails, supervisorSections } from '@/lib/search';

// GET ?id=<lot no.> → { lot, moves, jobs }  Meters only (no ₹), for the search box's lot card.
export async function GET(req: NextRequest) {
  try {
    const a = await requireCap(req, 'stock.quantity');
    const id = (req.nextUrl.searchParams.get('id') ?? '').trim().slice(0, 64);
    if (!id) throw new LedgerError('Which lot?');
    const sections = a.role === 'owner' ? null : await supervisorSections(query, a.userId);
    const res = await lotDetails(query, id, sections);
    if (!res) throw new LedgerError('Lot not found.', 404);
    return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
