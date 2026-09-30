import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { requireCap } from '@/lib/apiAuth';
import { LedgerError } from '@/lib/ledger';
import { ratesOverview } from '@/lib/money/master';
import { respond } from '@/lib/money/http';

// Selling rates are turned off (owner: every party gets a different rate, so there is no list to keep).
// The table and its old rows stay; nothing in the app reads them any more.

// GET (owner) → { qualities: QualityRate[], history: RateRow[] } — the old rate list, read-only.
export async function GET(req: NextRequest) {
  return respond(async () => {
    await requireCap(req, 'finance.view');
    return ratesOverview(query);
  });
}

// POST → 410: rates are typed on each order (or on the invoice) instead.
export async function POST(req: NextRequest) {
  return respond(async () => {
    await requireCap(req, 'master.manage');
    throw new LedgerError('Selling rates are turned off. Type the rate on the order or the invoice.', 410);
  });
}
