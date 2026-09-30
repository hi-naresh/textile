import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { requireCap } from '@/lib/apiAuth';
import { LedgerError } from '@/lib/ledger';
import { costsOverview } from '@/lib/money/master';
import { respond } from '@/lib/money/http';

// Process costs are turned off for now (owner's request): lot cost = purchase + grey→finished shortage.
// The table and its old rows stay; nothing in the app reads them any more.

// GET (owner) → { sections: SectionCost[], history: CostRow[] } — the old list, read-only.
export async function GET(req: NextRequest) {
  return respond(async () => {
    await requireCap(req, 'finance.view');
    return costsOverview(query);
  });
}

// POST → 410 while process costs are off.
export async function POST(req: NextRequest) {
  return respond(async () => {
    await requireCap(req, 'master.manage');
    throw new LedgerError('Process costs are turned off for now.', 410);
  });
}
