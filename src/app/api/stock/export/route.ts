import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { getFirmConfig } from '@/lib/settings';
import { lotsSheet, toBuffer } from '@/lib/excel';
import { requireCap } from '@/lib/apiAuth';
import { errorResponseBody, nextSr } from '@/lib/ledger';
import { filtersFrom, ledgerAll } from '@/lib/ledger-query';
import { challanSheet, importTemplate, newBook } from '@/lib/stock-import';

// Owner only (₹-free, but the whole ledger).
// GET /api/stock/export?kind=challans[&q=&direction=IN|OUT&quality=&design=&lot=&party=&from=YYYY-MM-DD&to=YYYY-MM-DD]
//     → .xlsx of every challan matching the same filters as the ledger screen (S.No first, SR no., pieces, location)
// GET /api/stock/export?kind=lots       → lot balances + locations
// GET /api/stock/export?kind=template   → blank import template for manual stock entry
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
      const locs = cfg.locationPresets.some((l) => l.toLowerCase() === 'floor') ? cfg.locationPresets : [...cfg.locationPresets, 'Floor'];
      const run = (text: string, params?: unknown[]) => query(text, params);
      const [i, o] = await Promise.all([nextSr(run, 'IN'), nextSr(run, 'OUT')]);
      importTemplate(wb, locs, cfg.markets ?? [], { IN: i.next, OUT: o.next });
      name = 'stock-import-template.xlsx';
    } else if (kind === 'lots') {
      const r = await query(
        `SELECT l.lot_id, l.quality, l.design,
                COALESCE((SELECT SUM(CASE WHEN direction = 'IN' THEN meters ELSE -meters END) FROM stock_movements WHERE lot_id = l.lot_id), 0) AS balance,
                (SELECT location FROM lot_locations WHERE lot_id = l.lot_id ORDER BY ts DESC, id DESC LIMIT 1) AS location
         FROM lots l ORDER BY l.lot_id`,
      );
      lotsSheet(wb, r.rows);
      name = `lots-${day}.xlsx`;
    } else if (kind === 'challans') {
      const f = filtersFrom(sp);
      const rows = await ledgerAll((text, params) => query(text, params), f);
      challanSheet(wb, rows);
      const tag = [f.direction?.toLowerCase(), f.lot, f.quality, f.from && `from-${f.from}`, f.to && `to-${f.to}`].filter(Boolean).join('-').replace(/[^A-Za-z0-9-]/g, '');
      name = `challans-${tag ? `${tag.slice(0, 60)}-` : ''}${day}.xlsx`;
    } else {
      return NextResponse.json({ error: 'kind must be challans, lots or template.' }, { status: 400 });
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
