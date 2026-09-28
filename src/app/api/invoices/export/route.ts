import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { requireCap } from '@/lib/apiAuth';
import { readBilling } from '@/lib/billing';
import { isIsoDate } from '@/lib/gst';
import { listInvoices } from '@/lib/dispatch/invoices';
import { tallyXlsx, tallyXml, type ExportInvoice } from '@/lib/dispatch/tally';
import { dbToday, logDoc } from '@/lib/dispatch/common';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// GET ?format=xlsx|xml&from=YYYY-MM-DD&to=YYYY-MM-DD (owner)
//   → app-made invoices (not cancelled) in the date range, for Tally. Marks them exported.
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const a = await requireCap(req, 'finance.view');
    const format = sp.get('format') ?? 'xlsx';
    if (format !== 'xlsx' && format !== 'xml') throw new LedgerError('format must be xlsx or xml.');
    for (const k of ['from', 'to']) if (sp.get(k) && !isIsoDate(sp.get(k))) throw new LedgerError(`"${k}" must be a date like 2026-09-28.`);
    const from = isIsoDate(sp.get('from')) ? sp.get('from')! : null;
    const to = isIsoDate(sp.get('to')) ? sp.get('to')! : await dbToday(query);
    if (from && from > to) throw new LedgerError('"From" date is after "to" date.');

    const { body, count } = await withTransaction(async (q) => {
      const list = (await listInvoices(q, { from, to, source: 'app' })).filter((i) => i.status !== 'cancelled').reverse();
      const ids = list.map((i) => i.id);
      const extra = ids.length
        ? await q(
          `SELECT i.id, p.gstin, p.state_code, d.challan_no FROM invoices i JOIN parties p ON p.id = i.party_id
           LEFT JOIN dispatches d ON d.id = i.dispatch_id WHERE i.id = ANY($1::int[])`, [ids])
        : { rows: [] };
      const byId = new Map(extra.rows.map((x) => [Number(x.id), x]));
      const rows: ExportInvoice[] = list.map((i) => {
        const x = byId.get(i.id);
        return { ...i, party_gstin: x?.gstin ?? null, party_state: x?.state_code ?? null, challan_no: x?.challan_no ?? null };
      });
      const billing = await readBilling(q);
      const body = format === 'xml' ? Buffer.from(tallyXml(billing, rows), 'utf8') : await tallyXlsx(billing, rows);
      if (ids.length) await q(`UPDATE invoices SET exported_at = NOW() WHERE id = ANY($1::int[])`, [ids]);
      return { body, count: ids.length };
    });
    await logDoc(query, 'tally_export', `${format} ${from ?? 'start'}..${to} (${count})`, a.by);
    const name = `tally-sales-${from ?? 'all'}-to-${to}.${format}`;
    return new NextResponse(new Uint8Array(body), {
      headers: {
        'Content-Type': format === 'xml' ? 'application/xml; charset=utf-8' : XLSX,
        'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', 'X-Invoice-Count': String(count),
      },
    });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
