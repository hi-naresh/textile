import { NextRequest } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { requireCap } from '@/lib/apiAuth';
import { addRate, ratesOverview } from '@/lib/money/master';
import { jsonBody, respond } from '@/lib/money/http';

// GET (owner) → { qualities: QualityRate[], history: RateRow[] } — current general rate + party overrides per quality.
export async function GET(req: NextRequest) {
  return respond(async () => {
    await requireCap(req, 'finance.view');
    return ratesOverview(query);
  });
}

// POST { quality, party_id?, rate_per_m, valid_from? } → { rate }
export async function POST(req: NextRequest) {
  return respond(async () => {
    const a = await requireCap(req, 'master.manage');
    const b = await jsonBody(req);
    return { rate: await withTransaction((q) => addRate(q, b, a.by)) };
  });
}
