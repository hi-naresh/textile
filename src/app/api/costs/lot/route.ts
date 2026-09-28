import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { requireCap } from '@/lib/apiAuth';
import { LedgerError } from '@/lib/ledger';
import { lotCost } from '@/lib/money/costing';
import { respond } from '@/lib/money/http';

// GET ?lot_id=&role=owner → { cost: LotCost } — cost ₹/m of one lot with its parts.
export async function GET(req: NextRequest) {
  return respond(async () => {
    const sp = req.nextUrl.searchParams;
    requireCap(sp.get('role'), 'finance.view');
    const id = (sp.get('lot_id') ?? '').trim();
    if (!id) throw new LedgerError('lot_id is required.');
    const cost = await lotCost(query, id);
    if (!cost) throw new LedgerError('Lot not found.', 404);
    return { cost };
  });
}
