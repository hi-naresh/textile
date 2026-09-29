import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction, type Q } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { invalidateSettings } from '@/lib/settings';
import { readObject, requireCap } from '@/lib/apiAuth';
import { ACCOUNT_ACTIONS, accountAction, listSessions, type AccountAction } from '@/lib/auth/users';

const run: Q = (text, params) => query(text, params as never[]);

// GET /api/users/<id> (owner) → { sessions } — the devices this person is signed in on.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireCap(req, 'users.manage');
    const { id } = await params;
    const u = await run(`SELECT 1 FROM users WHERE id = $1 AND role IS DISTINCT FROM 'developer'`, [id]);
    if (!u.rowCount) throw new LedgerError('User not found.', 404);
    return NextResponse.json({ sessions: await listSessions(run, id) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// POST /api/users/<id> (owner) { action, ... }
//   approve { role: 'supervisor'|'worker', sections?: number[], worker_id? | section? } · reject
//   deactivate · reactivate · set_role { role, ... } · set_sections { sections } · set_phone { phone }
//   reset_password · revoke_sessions { session_id? }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const a = await requireCap(req, 'users.manage');
    const { id } = await params;
    const b = await readObject(req);
    if (!ACCOUNT_ACTIONS.includes(b.action)) throw new LedgerError('Unknown action.');
    const r = await withTransaction((q) =>
      accountAction({ q, by: a.by, sessionId: a.sessionId, req, asDeveloper: false }, id, b.action as AccountAction, b));
    invalidateSettings();
    return NextResponse.json({ success: true, ...r }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
