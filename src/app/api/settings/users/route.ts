import { NextRequest, NextResponse } from 'next/server';
import { readObject, requireCap } from '@/lib/apiAuth';
import { withTransaction, type Q } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { cleanName, getFirmConfig, invalidateSettings } from '@/lib/settings';
import { audit } from '@/lib/auth/audit';
import { revokeUserSessions } from '@/lib/auth/session';

async function setSections(q: Q, userId: string, sections: unknown) {
  if (!Array.isArray(sections)) throw new LedgerError('sections must be a list of section ids.');
  const ids = [...new Set(sections.map((x) => Number(x)))];
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new LedgerError('Invalid section id.');
  if (ids.length) {
    const found = await q(`SELECT count(*)::int AS n FROM sections WHERE id = ANY($1::int[])`, [ids]);
    if (found.rows[0].n !== ids.length) throw new LedgerError('One of the sections does not exist.');
  }
  await q(`DELETE FROM supervisor_sections WHERE user_id = $1`, [userId]);
  if (ids.length) await q(`INSERT INTO supervisor_sections (user_id, section_id) SELECT $1, unnest($2::int[])`, [userId, ids]);
}

// POST (owner): add a supervisor { name, sections: number[] }. They can sign in once the owner
// adds their phone number (Users & sign ups), or they sign up themselves.
export async function POST(request: NextRequest) {
  try {
    const a = await requireCap(request, 'users.manage');
    const b = await readObject(request);
    const name = cleanName(b.name, 'Name');
    await withTransaction(async (q) => {
      const id = `usr-sup-${Date.now().toString(36)}`;
      await q(`INSERT INTO users (id, name, role, locale, active, status) VALUES ($1, $2, 'supervisor', 'en', true, 'approved')`, [id, name]);
      await setSections(q, id, b.sections ?? []);
      await audit(q, { event: 'user.created', actorId: a.by, targetUserId: id, sessionId: a.sessionId, req: request, detail: { role: 'supervisor' } });
    });
    invalidateSettings();
    return NextResponse.json({ success: true, config: await getFirmConfig(true) });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// PATCH (owner): update the owner or a supervisor { id, name?, active?, sections? }
// Switching someone off signs them out on every device straight away.
export async function PATCH(request: NextRequest) {
  try {
    const a = await requireCap(request, 'users.manage');
    const b = await readObject(request);
    const id = typeof b.id === 'string' ? b.id : '';
    await withTransaction(async (q) => {
      const u = await q(`SELECT role, active FROM users WHERE id = $1 FOR UPDATE`, [id]);
      if (!u.rowCount) throw new LedgerError('User not found.', 404);
      const role = u.rows[0].role;
      if (role !== 'owner' && role !== 'supervisor') throw new LedgerError('Only the owner and supervisors are managed here.');
      const log = (event: Parameters<typeof audit>[1]['event'], detail?: Record<string, unknown>) =>
        audit(q, { event, actorId: a.by, targetUserId: id, sessionId: a.sessionId, req: request, detail });
      if ('name' in b) {
        await q(`UPDATE users SET name = $1 WHERE id = $2`, [cleanName(b.name, 'Name'), id]);
        await log('user.updated', { name: b.name });
      }
      if ('active' in b && !!b.active !== u.rows[0].active) {
        if (role === 'owner') throw new LedgerError('The owner cannot be deactivated.');
        await q(`UPDATE users SET active = $1 WHERE id = $2`, [!!b.active, id]);
        if (b.active) await log('user.reactivated');
        else await log('user.deactivated', { sessions_ended: await revokeUserSessions(q, id, 'deactivated', a.by) });
      }
      if ('sections' in b) {
        if (role !== 'supervisor') throw new LedgerError('Only supervisors have sections.');
        await setSections(q, id, b.sections);
        await log('user.sections_changed', { sections: b.sections });
      }
    });
    invalidateSettings();
    return NextResponse.json({ success: true, config: await getFirmConfig(true) });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
