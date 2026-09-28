import { NextRequest } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { requireCap } from '@/lib/apiAuth';
import { listPayments, recordPayment } from '@/lib/money/payments';
import { jsonBody, respond } from '@/lib/money/http';

// GET ?party_id=&from=&to=&limit= (owner) → { payments: (Payment & { invoice_no })[] }
export async function GET(req: NextRequest) {
  return respond(async () => {
    const sp = req.nextUrl.searchParams;
    await requireCap(req, 'finance.view');
    return { payments: await listPayments(query, { partyId: sp.get('party_id'), from: sp.get('from'), to: sp.get('to'), limit: Number(sp.get('limit')) || 200 }) };
  });
}

// POST { party (name or id) | party_id, amount, paid_on?, mode?, reference?, invoice_id? }
//   → { payment, outstanding, overdue, paid_invoices }. Settles invoices FIFO and marks fully paid ones 'paid'.
export async function POST(req: NextRequest) {
  return respond(async () => {
    const a = await requireCap(req, 'finance.view');
    const b = await jsonBody(req);
    const r = await withTransaction((q) => recordPayment(q, b, a.by));
    return { payment: r.payment, outstanding: r.outstanding, overdue: r.overdue, paid_invoices: r.paid_invoices };
  });
}
