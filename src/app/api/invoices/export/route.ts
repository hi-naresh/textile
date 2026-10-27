import { NextRequest, NextResponse } from 'next/server';
import { finished } from 'node:stream/promises';
import { PassThrough, Readable } from 'node:stream';
import { query } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { requireCap } from '@/lib/apiAuth';
import { readBilling } from '@/lib/billing';
import { isIsoDate } from '@/lib/gst';
import { tallyExportRows, streamTallyXlsx, writeTallyXml } from '@/lib/dispatch/tally';
import { dbToday, logDoc } from '@/lib/dispatch/common';
import { enforceRateLimit, rateLimitResponse } from '@/lib/apiRateLimit';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// GET ?format=xlsx|xml&from=YYYY-MM-DD&to=YYYY-MM-DD (owner)
//   → app-made invoices (not cancelled) in the date range, for Tally. Marks them exported.
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const a = await requireCap(req, 'finance.view');
    await enforceRateLimit(query, a.userId, 'invoice-export', 60);
    const format = sp.get('format') ?? 'xlsx';
    if (format !== 'xlsx' && format !== 'xml') throw new LedgerError('format must be xlsx or xml.');
    for (const k of ['from', 'to']) if (sp.get(k) && !isIsoDate(sp.get(k))) throw new LedgerError(`"${k}" must be a date like 2026-09-28.`);
    const from = isIsoDate(sp.get('from')) ? sp.get('from')! : null;
    const to = isIsoDate(sp.get('to')) ? sp.get('to')! : await dbToday(query);
    if (from && from > to) throw new LedgerError('"From" date is after "to" date.');

    const highWaterId = Number((await query(`SELECT COALESCE(MAX(id), 0)::bigint AS id FROM invoices`)).rows[0].id);
    const countResult = await query(
      `SELECT COUNT(*)::text AS count FROM invoices
       WHERE id <= $1 AND source = 'app' AND status <> 'cancelled'
         AND ($2::date IS NULL OR invoice_date >= $2::date) AND invoice_date <= $3::date`,
      [highWaterId, from, to],
    );
    const count = String(countResult.rows[0].count);
    const billing = await readBilling(query);
    const invoiceRows = tallyExportRows((text, params) => query(text, params), from, to, highWaterId);
    const firstRow = await invoiceRows.next();
    async function* rows() {
      if (!firstRow.done) yield firstRow.value;
      yield* invoiceRows;
    }

    const output = new PassThrough();
    const body = Readable.toWeb(output) as ReadableStream<Uint8Array>;
    void (async () => {
      try {
        if (format === 'xml') {
          await writeTallyXml(billing, rows(), output);
        } else {
          const workbookOutput = new PassThrough();
          const workbookFinished = finished(workbookOutput);
          workbookOutput.on('error', (error: Error) => output.destroy(error));
          workbookOutput.pipe(output, { end: false });
          await streamTallyXlsx(billing, rows(), workbookOutput);
          await workbookFinished;
        }
        await query(
          `UPDATE invoices SET exported_at = NOW()
           WHERE id <= $1 AND source = 'app' AND status <> 'cancelled'
             AND ($2::date IS NULL OR invoice_date >= $2::date) AND invoice_date <= $3::date`,
          [highWaterId, from, to],
        );
        await logDoc(query, 'tally_export', `${format} ${from ?? 'start'}..${to} (${count})`, a.by);
        output.end();
      } catch (error) {
        output.destroy(error instanceof Error ? error : new Error('Invoice export failed.'));
      }
    })();

    const name = `tally-sales-${from ?? 'all'}-to-${to}.${format}`;
    return new NextResponse(body, {
      headers: {
        'Content-Type': format === 'xml' ? 'application/xml; charset=utf-8' : XLSX,
        'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', 'X-Invoice-Count': count,
      },
    });
  } catch (error) {
    const limited = rateLimitResponse(error);
    if (limited) return limited;
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
