import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { readObject, requireDeveloper } from '@/lib/apiAuth';
import { ACCESS_LOCKED, MATRIX, canByDefault, type Capability } from '@/lib/access';
import { cleanAccessOff, invalidateSettings } from '@/lib/settings';
import { audit } from '@/lib/auth/audit';

// Developer console → Access & roles.
// GET → { matrix, off: { supervisor: [...], worker: [...] }, locked }
// PUT { role: 'supervisor'|'worker', cap, on: boolean } → switch one capability off / back on for that role.
// Only capabilities the role has by default can be switched; the owner is always full access.
export async function GET(req: NextRequest) {
  try {
    await requireDeveloper(req);
    const r = await query(`SELECT access_overrides FROM app_settings WHERE id = 1`);
    return NextResponse.json({ matrix: MATRIX, off: cleanAccessOff(r.rows[0]?.access_overrides), locked: ACCESS_LOCKED }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const s = await requireDeveloper(req);
    const b = await readObject(req);
    const role: 'supervisor' | 'worker' = b.role;
    if (role !== 'supervisor' && role !== 'worker') throw new LedgerError('Only supervisor and worker access can be changed. The owner always has full access.');
    const cap = b.cap as Capability;
    if (!MATRIX.some((m) => m.cap === cap)) throw new LedgerError('Unknown capability.');
    if (typeof b.on !== 'boolean') throw new LedgerError('Send on: true or false.');
    if (!canByDefault(role, cap)) throw new LedgerError(`${role === 'supervisor' ? 'Supervisors' : 'Workers'} don’t have this in the first place.`);
    if (!b.on && (ACCESS_LOCKED[role] ?? []).includes(cap)) throw new LedgerError('This one can’t be switched off: the app would stop working for this role.');
    const off = await withTransaction(async (q) => {
      const r = await q(`SELECT access_overrides FROM app_settings WHERE id = 1 FOR UPDATE`);
      const cur = cleanAccessOff(r.rows[0]?.access_overrides);
      const list = new Set(cur[role] ?? []);
      if (b.on) list.delete(cap); else list.add(cap);
      const next = { ...cur, [role]: [...list] };
      await q(`UPDATE app_settings SET access_overrides = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = 1`, [JSON.stringify(next)]);
      await audit(q, { event: 'access.changed', actorId: s.user.id, sessionId: s.id, req, detail: { role, cap, on: b.on } });
      return next;
    });
    invalidateSettings();
    const label = MATRIX.find((m) => m.cap === cap)?.label ?? cap;
    return NextResponse.json({ success: true, off, message: `${label}: ${b.on ? 'on' : 'off'} for ${role}s` });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
