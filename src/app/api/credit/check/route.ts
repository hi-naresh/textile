import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { can } from '@/lib/access';
import { requireCap } from '@/lib/apiAuth';
import { creditCheck } from '@/lib/money/payments';
import { respond } from '@/lib/money/http';

// GET ?party=<name>|party_id=<id>&amount=<₹>&role= → { ok, warn, outstanding?, limit? }
// Owner: amounts in the warning + outstanding / limit / overdue / available. Supervisor: neutral warning, no ₹.
export async function GET(req: NextRequest) {
  return respond(async () => {
    const sp = req.nextUrl.searchParams;
    const role = requireCap(sp.get('role'), 'dispatch.manage');
    return creditCheck(query, { party: sp.get('party'), party_id: sp.get('party_id'), amount: sp.get('amount') }, can(role, 'finance.view'));
  });
}
