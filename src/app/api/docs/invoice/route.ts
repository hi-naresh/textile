import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { requireCap } from '@/lib/apiAuth';
import { readBilling } from '@/lib/billing';
import { getDispatch } from '@/lib/dispatch/dispatches';
import { getInvoice } from '@/lib/dispatch/invoices';
import { logDoc } from '@/lib/dispatch/common';
import { invoicePdf } from '@/lib/pdf/docs';
import { pdfResponse } from '@/lib/pdf/response';

// GET ?id=<invoice id> (owner) → GST tax invoice PDF (app-made invoices only).
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const a = await requireCap(req, 'finance.view');
    const invoice = await getInvoice(query, Number(sp.get('id')));
    if (invoice.source !== 'app') throw new LedgerError(`${invoice.invoice_no} was made in Tally — print it from Tally.`);
    const p = await query(`SELECT name, address, city, gstin, state_code, phone FROM parties WHERE id = $1`, [invoice.party_id]);
    const dispatch = invoice.dispatch_id ? (await getDispatch(query, invoice.dispatch_id, true).catch(() => null))?.dispatch ?? null : null;
    const bytes = await invoicePdf(await readBilling(query), { invoice, party: p.rows[0], dispatch });
    await logDoc(query, 'invoice', invoice.invoice_no, a.by);
    return pdfResponse(bytes, `invoice-${invoice.invoice_no}`);
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
