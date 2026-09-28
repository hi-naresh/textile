import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { getFirmConfig } from '@/lib/settings';
import { challanSheet, importTemplate, lotsSheet, newWorkbook, toBuffer } from '@/lib/excel';

// GET /api/stock/export?kind=challans[&direction=IN|OUT][&from=YYYY-MM-DD&to=YYYY-MM-DD]  → .xlsx of every challan (S.No first)
// GET /api/stock/export?kind=lots       → lot balances + locations
// GET /api/stock/export?kind=template   → blank import template for manual stock entry
// TODO(auth): owner only (₹-free, but the whole ledger).
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const isDate = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const kind = sp.get('kind') ?? 'challans';
    const cfg = await getFirmConfig();
    const wb = newWorkbook(cfg.firm.name);
    const day = new Date().toISOString().slice(0, 10);
    let name: string;

    if (kind === 'template') {
      const locs = cfg.locationPresets.some((l) => l.toLowerCase() === 'floor') ? cfg.locationPresets : [...cfg.locationPresets, 'Floor'];
      importTemplate(wb, locs);
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
      const dir = sp.get('direction');
      const r = await query(
        `SELECT sm.*, l.quality, l.design FROM stock_movements sm JOIN lots l ON l.lot_id = sm.lot_id
         WHERE ($1::text IS NULL OR sm.direction = $1)
           AND ($2::date IS NULL OR sm.ts >= $2::date) AND ($3::date IS NULL OR sm.ts < $3::date + 1)
         ORDER BY sm.ts, sm.id`,
        [dir === 'IN' || dir === 'OUT' ? dir : null, isDate(sp.get('from')), isDate(sp.get('to'))],
      );
      challanSheet(wb, r.rows);
      name = `challans-${dir ? `${dir.toLowerCase()}-` : ''}${day}.xlsx`;
    } else {
      return NextResponse.json({ error: 'kind must be challans, lots or template.' }, { status: 400 });
    }

    const buf = await toBuffer(wb);
    return new NextResponse(new Uint8Array(buf), {
      headers: { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[stock/export] failed', error);
    return NextResponse.json({ error: 'Could not create the Excel file.' }, { status: 500 });
  }
}
