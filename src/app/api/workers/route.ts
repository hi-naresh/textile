import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { cleanName } from '@/lib/settings';

// GET: active workers + efficiency + CCTV. ?include_inactive=1 also returns deactivated workers (for Settings).
export async function GET(request: NextRequest) {
  const includeInactive = request.nextUrl.searchParams.get('include_inactive') === '1';
  try {
    // 1. Fetch workers
    const workersRes = await query(`SELECT * FROM workers ${includeInactive ? '' : 'WHERE active = true'} ORDER BY active DESC, name ASC`);
    
    // 2. Fetch daily efficiency for the last 7 days
    const efficiencyRes = await query(`
      SELECT ed.*, to_char(ed.date, 'YYYY-MM-DD') as date_str, w.name, w.section
      FROM efficiency_daily ed
      JOIN workers w ON ed.worker_id = w.id
      ORDER BY ed.date DESC, ed.efficiency_pct ASC
    `);

    // 3. Fetch recent CCTV tracking activity
    const cctvRes = await query(`
      SELECT c.*, w.name
      FROM cctv_activity c
      JOIN workers w ON c.worker_id = w.id
      ORDER BY c.ts DESC
      LIMIT 50
    `);

    return NextResponse.json({
      workers: workersRes.rows,
      efficiency: efficiencyRes.rows.map(row => ({
        ...row,
        allotted: parseFloat(row.allotted),
        done: parseFloat(row.done),
        efficiency_pct: parseFloat(row.efficiency_pct)
      })),
      cctv: cctvRes.rows.map(row => ({
        ...row,
        active_pct: parseFloat(row.active_pct),
        idle_min: parseFloat(row.idle_min)
      }))
    });
  } catch (error) {
    console.error('Failed to fetch workers data:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

async function requireSection(q: (t: string, p?: unknown[]) => Promise<{ rowCount: number | null; rows: { name: string }[] }>, raw: unknown) {
  const name = cleanName(raw, 'Section', 60);
  const r = await q(`SELECT name FROM sections WHERE lower(name) = lower($1) AND active`, [name]);
  if (!r.rowCount) throw new LedgerError(`Section "${name}" does not exist. Add it under Settings → Sections first.`);
  return r.rows[0].name;
}

// POST: add a worker { name, section }
export async function POST(request: NextRequest) {
  try {
    const b = await request.json();
    const name = cleanName(b.name, 'Worker name');
    const worker = await withTransaction(async (q) => {
      const section = await requireSection(q, b.section);
      const id = `wrk-${Date.now().toString(36)}`;
      const r = await q(`INSERT INTO workers (id, name, section, role, active) VALUES ($1, $2, $3, 'operator', true) RETURNING *`, [id, name, section]);
      return r.rows[0];
    });
    return NextResponse.json({ success: true, worker });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// PATCH: edit a worker { id, name?, section?, active? }
export async function PATCH(request: NextRequest) {
  try {
    const b = await request.json();
    const worker = await withTransaction(async (q) => {
      const cur = await q(`SELECT id FROM workers WHERE id = $1 FOR UPDATE`, [String(b.id ?? '')]);
      if (!cur.rowCount) throw new LedgerError('Worker not found.', 404);
      if ('name' in b) await q(`UPDATE workers SET name = $1 WHERE id = $2`, [cleanName(b.name, 'Worker name'), b.id]);
      if ('section' in b) await q(`UPDATE workers SET section = $1 WHERE id = $2`, [await requireSection(q, b.section), b.id]);
      if ('active' in b) await q(`UPDATE workers SET active = $1 WHERE id = $2`, [!!b.active, b.id]);
      return (await q(`SELECT * FROM workers WHERE id = $1`, [b.id])).rows[0];
    });
    return NextResponse.json({ success: true, worker });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
