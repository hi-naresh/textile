import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { requireCap } from '@/lib/apiAuth';
import { rateFor } from '@/lib/pricing';
import { partyByName } from '@/lib/parties';

// GET ?quality=&party_id=|party= (owner) → { rate } (₹/m, null when no rate is set)
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    await requireCap(req, 'orders.manage');
    const quality = (sp.get('quality') ?? '').trim();
    if (!quality) throw new LedgerError('quality is required.');
    let partyId: number | null = Number(sp.get('party_id')) || null;
    if (!partyId && sp.get('party')) partyId = (await partyByName(query, sp.get('party'), false))?.id ?? null;
    const rate = await rateFor(query, quality, partyId);
    return NextResponse.json({ rate }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
