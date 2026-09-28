import { NextRequest } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { actorOf, requireCap } from '@/lib/apiAuth';
import { addRate, ratesOverview } from '@/lib/money/master';
import { jsonBody, respond } from '@/lib/money/http';

// GET ?role=owner → { qualities: QualityRate[], history: RateRow[] } — current general rate + party overrides per quality.
export async function GET(req: NextRequest) {
  return respond(async () => {
    requireCap(req.nextUrl.searchParams.get('role'), 'finance.view');
    return ratesOverview(query);
  });
}

// POST { quality, party_id?, rate_per_m, valid_from?, role, actor } → { rate }
export async function POST(req: NextRequest) {
  return respond(async () => {
    const b = await jsonBody(req);
    requireCap(b.role, 'master.manage');
    return { rate: await withTransaction((q) => addRate(q, b, actorOf(b.actor))) };
  });
}
