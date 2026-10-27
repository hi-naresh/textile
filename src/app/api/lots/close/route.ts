import { NextRequest, NextResponse } from 'next/server';
import { readObject, requireCap } from '@/lib/apiAuth';
import { withTransaction } from '@/lib/db';
import { closeLot, errorResponseBody, LedgerError, reopenLot } from '@/lib/ledger';

// POST { lot_id, action: 'close' | 'reopen', note?, final_meters? (close: meters the lot really gave; default = dispatched) } (owner, stock.closed)
//   close  → close the lot by hand: whatever its entries leave is written off with a closing adjustment so the balance
//            is 0; the lot leaves current stock (reason 'manual').  → { success, lot_id, adjustment_m, movement_id }
//   reopen → remove the closing adjustment, the End entry that closed it becomes Running, the lot is back in stock.
//            → { success, lot_id, balance }
// Every close / reopen is kept in lot_closures (who, when, note, meters written off).
export async function POST(req: NextRequest) {
  try {
    const a = await requireCap(req, 'stock.closed');
    const b = await readObject(req);
    const lotId = typeof b.lot_id === 'string' ? b.lot_id.trim() : '';
    if (!lotId || lotId.length > 50) throw new LedgerError('Which lot? Send its lot number.');
    if (b.action !== 'close' && b.action !== 'reopen') throw new LedgerError('action must be "close" or "reopen".');
    const out = await withTransaction<Record<string, unknown>>(async (q) => (b.action === 'close'
      ? { ...(await closeLot(q, lotId, { reason: 'manual', by: a.by, note: b.note, finalMeters: b.final_meters })) }
      : { ...(await reopenLot(q, lotId, { by: a.by, note: b.note })) }));
    return NextResponse.json({ success: true, ...out });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
