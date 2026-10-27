import { PassThrough, Readable } from 'node:stream';
import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { getFirmConfig } from '@/lib/settings';
import { streamLotsWorkbook, toBuffer } from '@/lib/excel';
import { enforceRateLimit, rateLimitResponse } from '@/lib/apiRateLimit';
import { requireCap } from '@/lib/apiAuth';
import { errorResponseBody, nextSr } from '@/lib/ledger';
import { filtersFrom, ledgerExportRows } from '@/lib/ledger-query';
import { lotExportRows, lotFiltersFrom } from '@/lib/lots-query';
import { importTemplate, newBook, registerTemplate, streamChallanWorkbook } from '@/lib/stock-import';

// Owner only (₹-free, but the whole ledger).
// GET /api/stock/export?kind=challans[&q=&direction=IN|OUT&quality=&design=&lot=&party=&from=YYYY-MM-DD&to=YYYY-MM-DD]
//     → .xlsx of every challan matching the same filters as the ledger screen (S.No first, SR no., pieces, location)
// GET /api/stock/export?kind=lots[&q=&in_stock=1&status=] → lot balances + locations (same filters as Lots & balance)
// GET /api/stock/export?kind=template   → blank import template for manual stock entry (the app's own columns)
// GET /api/stock/export?kind=incoming_template | outgoing_template → the firm's Incoming / Outgoing register columns,
//     an example row on its own sheet and short notes
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function GET(req: NextRequest) {
  try {
    const actor = await requireCap(req, 'ledger.edit');
    await enforceRateLimit(query, actor.userId, 'stock-export', 60);
    const sp = req.nextUrl.searchParams;
    const kind = sp.get('kind') ?? 'challans';
    const cfg = await getFirmConfig();
    const day = new Date().toISOString().slice(0, 10);
    let name: string;

    if (kind === 'challans') {
      const f = filtersFrom(sp);
      const tag = [f.direction?.toLowerCase(), f.lot, f.quality, f.from && `from-${f.from}`, f.to && `to-${f.to}`].filter(Boolean).join('-').replace(/[^A-Za-z0-9-]/g, '');
      name = `challans-${tag ? `${tag.slice(0, 60)}-` : ''}${day}.xlsx`;
      const exportRows = ledgerExportRows((text, params) => query(text, params), f);
      const firstRow = await exportRows.next();
      async function* rows() {
        if (!firstRow.done) yield firstRow.value;
        yield* exportRows;
      }
      const output = new PassThrough();
      const body = Readable.toWeb(output) as ReadableStream<Uint8Array>;
      void streamChallanWorkbook(cfg.firm.name, output, rows())
        .catch((error: unknown) => output.destroy(error instanceof Error ? error : new Error('Stock export failed.')));
      return new NextResponse(body, {
        headers: { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' },
      });
    }

    if (kind === 'lots') {
      const exportRows = lotExportRows((text, params) => query(text, params), lotFiltersFrom(sp));
      const firstRow = await exportRows.next();
      async function* rows() {
        if (!firstRow.done) yield firstRow.value;
        yield* exportRows;
      }
      const output = new PassThrough();
      const body = Readable.toWeb(output) as ReadableStream<Uint8Array>;
      void streamLotsWorkbook(cfg.firm.name, output, rows())
        .catch((error: unknown) => output.destroy(error instanceof Error ? error : new Error('Lot export failed.')));
      name = `lots-${day}.xlsx`;
      return new NextResponse(body, {
        headers: { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' },
      });
    }

    const wb = newBook(cfg.firm.name);
    if (kind === 'template') {
      const run = (text: string, params?: unknown[]) => query(text, params);
      const [i, o] = await Promise.all([nextSr(run, 'IN'), nextSr(run, 'OUT')]);
      importTemplate(wb, cfg.markets, { IN: i.next, OUT: o.next }); // Location dropdown: the market codes
      name = 'stock-import-template.xlsx';
    } else if (kind === 'incoming_template' || kind === 'outgoing_template') {
      const i = await nextSr((text: string, params?: unknown[]) => query(text, params), 'IN');
      registerTemplate(wb, kind === 'incoming_template' ? 'incoming' : 'outgoing', i.next);
      name = kind === 'incoming_template' ? 'incoming-register-template.xlsx' : 'outgoing-register-template.xlsx';
    } else {
      return NextResponse.json({ error: 'kind must be challans, lots, template, incoming_template or outgoing_template.' }, { status: 400 });
    }

    const buf = await toBuffer(wb);
    return new NextResponse(new Uint8Array(buf), {
      headers: { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const limited = rateLimitResponse(error);
    if (limited) return limited;
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
