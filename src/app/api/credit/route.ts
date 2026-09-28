import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { requireCap } from '@/lib/apiAuth';
import { creditSummary, creditTotals } from '@/lib/money/credit';
import { respond } from '@/lib/money/http';

// GET ?role=owner[&party_id=] → { parties: [{ party_id, name, outstanding, overdue, buckets, limit, available, oldest_due_days, last_payment, invoices, … }], totals }
export async function GET(req: NextRequest) {
  return respond(async () => {
    const sp = req.nextUrl.searchParams;
    requireCap(sp.get('role'), 'finance.view');
    const pid = Number(sp.get('party_id'));
    const rows = await creditSummary(query, Number.isInteger(pid) && pid > 0 ? [pid] : undefined);
    rows.sort((a, b) => b.overdue - a.overdue || b.outstanding - a.outstanding || a.name.localeCompare(b.name));
    return { parties: rows, totals: await creditTotals(query, rows) };
  });
}
