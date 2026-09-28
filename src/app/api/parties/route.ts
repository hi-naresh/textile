import { NextRequest } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { can } from '@/lib/access';
import { requireCap } from '@/lib/apiAuth';
import { createParty, listParties } from '@/lib/money/master';
import { jsonBody, respond } from '@/lib/money/http';

// GET ?q=&all=1 → { parties: Party[] }
// Owner: every field (all=1 includes inactive). Supervisor: active parties, name / phone / city only (no credit fields).
export async function GET(req: NextRequest) {
  return respond(async () => {
    const sp = req.nextUrl.searchParams;
    const { role } = await requireCap(req, 'orders.view');
    const owner = can(role, 'finance.view');
    const parties = await listParties(query, { search: sp.get('q'), includeInactive: owner && sp.get('all') === '1' });
    return { parties: owner ? parties : parties.map((p) => ({ id: p.id, name: p.name, phone: p.phone, city: p.city, active: p.active })) };
  });
}

// POST { name, phone?, gstin?, address?, city?, state_code?, credit_limit?, credit_days?, active? } → { party }
export async function POST(req: NextRequest) {
  return respond(async () => {
    await requireCap(req, 'master.manage');
    const b = await jsonBody(req);
    return { party: await withTransaction((q) => createParty(q, b)) };
  });
}
