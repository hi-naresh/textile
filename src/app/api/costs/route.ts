import { NextRequest } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { requireCap } from '@/lib/apiAuth';
import { addCost, costsOverview } from '@/lib/money/master';
import { jsonBody, respond } from '@/lib/money/http';

// GET (owner) → { sections: SectionCost[], history: CostRow[] } — current process cost ₹/m per section.
export async function GET(req: NextRequest) {
  return respond(async () => {
    await requireCap(req, 'finance.view');
    return costsOverview(query);
  });
}

// POST { section, cost_per_m, valid_from? } → { cost }
export async function POST(req: NextRequest) {
  return respond(async () => {
    const a = await requireCap(req, 'master.manage');
    const b = await jsonBody(req);
    return { cost: await withTransaction((q) => addCost(q, b, a.by)) };
  });
}
