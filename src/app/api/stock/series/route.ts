import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { readObject, requireCap } from '@/lib/apiAuth';
import { LedgerError, errorResponseBody } from '@/lib/ledger';
import { seriesValue } from '@/lib/sr-series';
export async function GET(req: NextRequest) {
  try {
    await requireCap(req, 'ledger.edit');
    return NextResponse.json({ series: (await query('SELECT prefix, name, active FROM sr_series ORDER BY prefix')).rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { const { status, body } = errorResponseBody(error); return NextResponse.json(body, { status }); }
}
export async function POST(req: NextRequest) {
  try {
    const actor = await requireCap(req, 'ledger.edit');
    const body = await readObject(req);
    const prefix = seriesValue(body.prefix);
    const name = String(body.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name || name.length > 100) throw new LedgerError('Enter a godown name up to 100 characters.');
    if (body.active != null && typeof body.active !== 'boolean') throw new LedgerError('Active must be true or false.');
    if (!prefix && body.active === false) throw new LedgerError('The main series must stay active.');
    const out = await query(`INSERT INTO sr_series (prefix, name, active, created_by) VALUES ($1, $2, $3, $4)
      ON CONFLICT (prefix) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active RETURNING prefix, name, active`, [prefix, name, body.active ?? true, actor.by]);
    return NextResponse.json({ series: out.rows[0] });
  } catch (error) { const { status, body } = errorResponseBody(error); return NextResponse.json(body, { status }); }
}
