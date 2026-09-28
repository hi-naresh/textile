import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { actorOf, requireCap, readObject } from '@/lib/apiAuth';
import { can } from '@/lib/access';
import { createDispatch, getDispatch, listDispatches } from '@/lib/dispatch/dispatches';
import { createInvoiceForDispatch } from '@/lib/dispatch/invoices';

// GET ?days=30&party_id=&role= → { dispatches: Dispatch[] } (invoice_no only for the owner)
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const role = requireCap(sp.get('role'), 'dispatch.manage');
    const days = Number(sp.get('days') ?? 30);
    const pid = sp.get('party_id') ? Number(sp.get('party_id')) : null;
    const dispatches = await listDispatches(query, { days: Number.isFinite(days) ? days : 30, party_id: pid && Number.isInteger(pid) ? pid : null, owner: can(role, 'finance.view') });
    return NextResponse.json({ dispatches }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// POST { party, order_id?, lines: [{ lot_id, meters }], challan_no?, transporter?, lr_no?, vehicle_no?, packages?,
//        create_invoice? (owner), rates? (owner, ₹/m by lot_id or quality when no saved rate), invoice_date?, role, actor }
//   → { dispatch, lines, invoice?, note? } — one transaction: dispatch + OUT movements (+ invoice).
export async function POST(req: NextRequest) {
  try {
    const b = await readObject(req);
    if (!b || typeof b !== 'object') throw new LedgerError('Send the dispatch as JSON.');
    const role = requireCap(b.role, 'dispatch.manage');
    const owner = can(role, 'finance.view');
    if (b.create_invoice && !owner) throw new LedgerError('Only the owner can create invoices.', 403);
    const actor = actorOf(b.actor);
    const out = await withTransaction(async (q) => {
      const { id } = await createDispatch(q, b, actor);
      const inv = b.create_invoice ? await createInvoiceForDispatch(q, id, { rates: b.rates, invoice_date: b.invoice_date, actor }) : null;
      const full = await getDispatch(q, id, owner);
      return { ...full, ...(inv ? { invoice: inv.invoice, note: inv.note } : {}) };
    });
    return NextResponse.json({ success: true, ...out }, { status: 201 });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
