import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { actorOf, requireCap, readObject } from '@/lib/apiAuth';
import { isIsoDate } from '@/lib/gst';
import { createInvoiceForDispatch, listInvoices, recordTallyInvoice } from '@/lib/dispatch/invoices';

// Owner only (₹).
// GET ?party_id=&status=open|paid|cancelled|overdue&source=app|tally&from=&to=&role=owner
//   → { invoices: Invoice[] } newest first; paid/balance = payments applied FIFO per party (oldest invoice first).
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    requireCap(sp.get('role'), 'finance.view');
    const pid = sp.get('party_id') ? Number(sp.get('party_id')) : null;
    if (pid != null && (!Number.isInteger(pid) || pid <= 0)) throw new LedgerError('party_id is not valid.');
    const status = sp.get('status');
    if (status && !['open', 'part_paid', 'paid', 'cancelled', 'overdue'].includes(status)) throw new LedgerError('status must be open, part_paid, paid, cancelled or overdue.');
    for (const k of ['from', 'to']) if (sp.get(k) && !isIsoDate(sp.get(k))) throw new LedgerError(`"${k}" must be a date like 2026-09-28.`);
    const invoices = await listInvoices(query, {
      party_id: pid, status, source: sp.get('source'),
      from: isIsoDate(sp.get('from')) ? sp.get('from') : null, to: isIsoDate(sp.get('to')) ? sp.get('to') : null,
    });
    return NextResponse.json({ invoices }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// POST (owner)
//   { dispatch_id, rates?: { [lot_id | quality]: ₹/m }, invoice_date?, role, actor } → GST invoice from a dispatch
//   { source: 'tally', invoice_no, party (name or id), invoice_date, taxable_amount?, total, due_date?, dispatch_id?, role, actor }
//     → records an invoice made in Tally (amounts only)
//   → { invoice, note? }
export async function POST(req: NextRequest) {
  try {
    const b = await readObject(req);
    if (!b || typeof b !== 'object') throw new LedgerError('Send the invoice as JSON.');
    requireCap(b.role, 'finance.view');
    const actor = actorOf(b.actor);
    const out = await withTransaction(async (q) => {
      if (b.source === 'tally') return { invoice: await recordTallyInvoice(q, b, actor), note: null };
      const { invoice, note } = await createInvoiceForDispatch(q, Number(b.dispatch_id), { rates: b.rates, invoice_date: b.invoice_date, actor });
      return { invoice, note };
    });
    return NextResponse.json({ success: true, ...out }, { status: 201 });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
