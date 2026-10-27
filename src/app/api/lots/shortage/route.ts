import { NextRequest, NextResponse } from 'next/server';
import { requireCap } from '@/lib/apiAuth';
import { query } from '@/lib/db';
import { lotCode } from '@/lib/normalize';
import { errorResponseBody, finalShortage, LedgerError } from '@/lib/ledger';

// GET /api/lots/shortage?lot_id=… → { grey_m, finished_m, dispatched_m, final_meters (saved, or = dispatched), shortage_m, shortage_pct, saved }
// Used when a lot ends (End entry, Close lot) to ask for the final meters with the numbers in front of the person.
export async function GET(req: NextRequest) {
  try {
    await requireCap(req, 'stock.quantity');
    const raw = (req.nextUrl.searchParams.get('lot_id') ?? '').trim();
    if (!raw || raw.length > 50) throw new LedgerError('Which lot? Send its lot number.');
    const lotId = lotCode(raw)!;
    const run = (t: string, p?: unknown[]) => query(t, p);
    const lot = (await run(`SELECT final_meters FROM lots WHERE lot_id = $1`, [lotId])).rows[0];
    if (!lot) throw new LedgerError(`Lot ${lotId} does not exist.`, 404);
    const saved = lot.final_meters == null ? null : Number(lot.final_meters);
    return NextResponse.json({ ...(await finalShortage(run, lotId, saved)), saved: saved != null }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
