import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { getFirmConfig } from '@/lib/settings';
import { lotsSheet, toBuffer } from '@/lib/excel';
import { requireCap } from '@/lib/apiAuth';
import { errorResponseBody, nextSr } from '@/lib/ledger';
import { filtersFrom, ledgerAll } from '@/lib/ledger-query';
import { lotFiltersFrom, lotsAll } from '@/lib/lots-query';
import { challanSheet, importTemplate, newBook, registerTemplate } from '@/lib/stock-import';

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
    await requireCap(req, 'ledger.edit');
    const sp = req.nextUrl.searchParams;
    const kind = sp.get('kind') ?? 'challans';
    const cfg = await getFirmConfig();
    const wb = newBook(cfg.firm.name);
    const day = new Date().toISOString().slice(0, 10);
    let name: string;

    if (kind === 'template') {
      const run = (text: string, params?: unknown[]) => query(text, params);
      const [i, o] = await Promise.all([nextSr(run, 'IN'), nextSr(run, 'OUT')]);
      importTemplate(wb, cfg.markets, { IN: i.next, OUT: o.next }); // Location dropdown: the market codes
      name = 'stock-import-template.xlsx';
    } else if (kind === 'incoming_template' || kind === 'outgoing_template') {
      const i = await nextSr((text: string, params?: unknown[]) => query(text, params), 'IN');
      registerTemplate(wb, kind === 'incoming_template' ? 'incoming' : 'outgoing', i.next);
      name = kind === 'incoming_template' ? 'incoming-register-template.xlsx' : 'outgoing-register-template.xlsx';
    } else if (kind === 'lots') {
      // Same filters as the Lots & balance view (q, in_stock, status); balance + location live on the lot row.
      lotsSheet(wb, await lotsAll((text, params) => query(text, params), lotFiltersFrom(sp)));
      name = `lots-${day}.xlsx`;
    } else if (kind === 'challans') {
      const f = filtersFrom(sp);
      const rows = await ledgerAll((text, params) => query(text, params), f);
      challanSheet(wb, rows);
      const tag = [f.direction?.toLowerCase(), f.lot, f.quality, f.from && `from-${f.from}`, f.to && `to-${f.to}`].filter(Boolean).join('-').replace(/[^A-Za-z0-9-]/g, '');
      name = `challans-${tag ? `${tag.slice(0, 60)}-` : ''}${day}.xlsx`;
    } else {
      return NextResponse.json({ error: 'kind must be challans, lots, template, incoming_template or outgoing_template.' }, { status: 400 });
    }

    const buf = await toBuffer(wb);
    return new NextResponse(new Uint8Array(buf), {
      headers: { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
