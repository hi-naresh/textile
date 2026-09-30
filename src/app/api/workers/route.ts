import { NextRequest, NextResponse } from 'next/server';
import { readObject, requireCap, requireUser } from '@/lib/apiAuth';
import { can } from '@/lib/access';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { cleanName, invalidateSettings } from '@/lib/settings';
import { removePerson } from '@/lib/auth/users';
import { audit } from '@/lib/auth/audit';

// GET: active workers + efficiency + CCTV. ?include_inactive=1 also returns deactivated workers (for Settings).
// A worker gets only their own worker record (no efficiency / CCTV).
export async function GET(request: NextRequest) {
  try {
    const a = await requireUser(request);
    if (!can(a.role, 'efficiency.view')) {
      const own = a.workerId ? await query(`SELECT * FROM workers WHERE id = $1 AND deleted_at IS NULL`, [a.workerId]) : { rows: [] };
      return NextResponse.json({ workers: own.rows, efficiency: [], cctv: [] });
    }
    const includeInactive = request.nextUrl.searchParams.get('include_inactive') === '1' && can(a.role, 'users.manage');
    // 1. Fetch workers
    const workersRes = await query(`SELECT * FROM workers WHERE deleted_at IS NULL ${includeInactive ? '' : 'AND active = true'} ORDER BY active DESC, name ASC`);
    
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
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

async function requireSection(q: (t: string, p?: unknown[]) => Promise<{ rowCount: number | null; rows: { name: string }[] }>, raw: unknown) {
  const name = cleanName(raw, 'Section', 60);
  const r = await q(`SELECT name FROM sections WHERE lower(name) = lower($1) AND active`, [name]);
  if (!r.rowCount) throw new LedgerError(`Section "${name}" does not exist. Add it under My firm → Team first.`);
  return r.rows[0].name;
}

// POST (owner): add a worker { name, section }
export async function POST(request: NextRequest) {
  try {
    await requireCap(request, 'users.manage');
    const b = await readObject(request);
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

// PATCH (owner): edit a worker { id, name?, section?, active? }
export async function PATCH(request: NextRequest) {
  try {
    await requireCap(request, 'users.manage');
    const b = await readObject(request);
    const worker = await withTransaction(async (q) => {
      const cur = await q(`SELECT id FROM workers WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [String(b.id ?? '')]);
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

// DELETE /api/workers?id=<id> (owner): remove a worker from the team. Their job cards and history keep the name;
// the worker disappears from every list, and their sign-in (if any) is removed and signed out.
export async function DELETE(request: NextRequest) {
  try {
    const a = await requireCap(request, 'users.manage');
    const id = request.nextUrl.searchParams.get('id') ?? '';
    const name = await withTransaction(async (q) => {
      const cur = await q(`SELECT id, name FROM workers WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id]);
      if (!cur.rowCount) throw new LedgerError('Worker not found.', 404);
      await q(`UPDATE workers SET deleted_at = now(), active = false WHERE id = $1`, [id]);
      const acc = await q(`SELECT id, worker_id, role FROM users WHERE worker_id = $1 AND deleted_at IS NULL FOR UPDATE`, [id]);
      for (const u of acc.rows) {
        if (u.id === a.by || u.role === 'owner') throw new LedgerError('This worker record belongs to the owner account.', 403);
        await removePerson(q, u, a.by);
        await audit(q, { event: 'user.deleted', actorId: a.by, targetUserId: u.id, sessionId: a.sessionId, req: request, detail: { with_worker: id } });
      }
      await audit(q, { event: 'worker.deleted', actorId: a.by, targetUserId: acc.rows[0]?.id ?? null, sessionId: a.sessionId, req: request, detail: { worker_id: id } });
      return cur.rows[0].name as string;
    });
    invalidateSettings();
    return NextResponse.json({ success: true, message: `${name} removed from the team` });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
