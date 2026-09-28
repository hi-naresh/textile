import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { requireCap } from '@/lib/apiAuth';
import { LedgerError } from '@/lib/ledger';
import { MARGIN_BY, marginReport, type MarginBy } from '@/lib/money/costing';
import { respond } from '@/lib/money/http';

// GET ?by=order|party|quality|lot&days=30 (owner) → { by, days, rows: [{ key, label, meters, revenue, cost, margin, margin_pct, complete, missing, unpriced_m }], totals }
export async function GET(req: NextRequest) {
  return respond(async () => {
    const sp = req.nextUrl.searchParams;
    await requireCap(req, 'finance.view');
    const by = (sp.get('by') ?? 'party') as MarginBy;
    if (!MARGIN_BY.includes(by)) throw new LedgerError(`by must be one of: ${MARGIN_BY.join(', ')}.`);
    const days = Number(sp.get('days') ?? 30);
    if (!Number.isInteger(days) || days < 1 || days > 730) throw new LedgerError('days must be 1 to 730.');
    return { by, days, ...(await marginReport(query, by, days)) };
  });
}
