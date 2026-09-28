import { NextRequest } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { actorOf, requireCap } from '@/lib/apiAuth';
import { addCost, costsOverview } from '@/lib/money/master';
import { jsonBody, respond } from '@/lib/money/http';

// GET ?role=owner → { sections: SectionCost[], history: CostRow[] } — current process cost ₹/m per section.
export async function GET(req: NextRequest) {
  return respond(async () => {
    requireCap(req.nextUrl.searchParams.get('role'), 'finance.view');
    return costsOverview(query);
  });
}

// POST { section, cost_per_m, valid_from?, role, actor } → { cost }
export async function POST(req: NextRequest) {
  return respond(async () => {
    const b = await jsonBody(req);
    requireCap(b.role, 'master.manage');
    return { cost: await withTransaction((q) => addCost(q, b, actorOf(b.actor))) };
  });
}
