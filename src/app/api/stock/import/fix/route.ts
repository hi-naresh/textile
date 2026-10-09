import { NextRequest, NextResponse } from 'next/server';
import { readObject, requireCap } from '@/lib/apiAuth';
import { errorResponseBody } from '@/lib/ledger';
import { fixSheet, newBook } from '@/lib/stock-import';
import { toBuffer } from '@/lib/excel';

// "Rows to fix" (owner, ledger.edit). POST { name, headers: string[], rows: [{ row, values: unknown[], reason }] }
// → .xlsx with the uploaded file's own columns + "Excel row" + "Why skipped", for the rows the import left out.
// The browser sends back what POST /api/stock/import returned in `fix`; nothing is read from the database.
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_ROWS = 5000;

export async function POST(req: NextRequest) {
  try {
    await requireCap(req, 'ledger.edit');
    const body = await readObject(req);
    const headers = Array.isArray(body.headers) ? body.headers.slice(0, 60).map((h: unknown) => String(h ?? '').slice(0, 60)) : null;
    const rows = Array.isArray(body.rows) ? body.rows : null;
    if (!headers || !headers.length || !rows) return NextResponse.json({ error: 'Nothing to put in the file.' }, { status: 400 });
    if (rows.length > MAX_ROWS) return NextResponse.json({ error: `At most ${MAX_ROWS} rows.` }, { status: 400 });
    const clean = rows.map((r: unknown) => {
      const o = r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
      const values = Array.isArray(o.values) ? o.values.slice(0, headers.length).map((v) => (typeof v === 'number' || typeof v === 'boolean' || v == null ? v ?? null : String(v).slice(0, 200))) : [];
      return { row: Number.isSafeInteger(o.row) ? Number(o.row) : 0, values, reason: String(o.reason ?? '').slice(0, 300) };
    });
    const wb = newBook('Rows to fix');
    fixSheet(wb, headers, clean);
    const name = String(body.name ?? 'import').replace(/\.xlsx$/i, '').replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 60) || 'import';
    return new NextResponse(new Uint8Array(await toBuffer(wb)), {
      headers: { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="rows-to-fix-${name}.xlsx"`, 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
