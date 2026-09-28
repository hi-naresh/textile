import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction, type Q } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { readObject, requireDeveloper } from '@/lib/apiAuth';
import { audit } from '@/lib/auth/audit';
import { AUTH } from '@/lib/auth/config';

const run: Q = (text, params) => query(text, params as never[]);

// Developer only. POST { user_id } → this developer session sees the app as that user (read-only by default).
// Every start and stop is in the audit trail; every API call made while viewing is logged too (dev.client_data).
export async function POST(req: NextRequest) {
  try {
    const s = await requireDeveloper(req);
    const b = await readObject(req);
    const id = typeof b.user_id === 'string' ? b.user_id : '';
    await withTransaction(async (q) => {
      const u = await q(`SELECT id, role FROM users WHERE id = $1 AND status = 'approved' AND active AND role IN ('owner', 'supervisor', 'worker')`, [id]);
      if (!u.rowCount) throw new LedgerError('Pick an approved, active owner, supervisor or worker.');
      if (s.viewAs) await audit(q, { event: 'view_as.stop', actorId: s.user.id, targetUserId: s.viewAs.id, sessionId: s.id, req });
      await q(`UPDATE auth_sessions SET view_as_user_id = $2, view_as_since = now() WHERE id = $1`, [s.id, id]);
      await audit(q, { event: 'view_as.start', actorId: s.user.id, targetUserId: id, sessionId: s.id, req, detail: { role: u.rows[0].role, write: AUTH.viewAsWrite } });
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// DELETE → stop viewing as.
export async function DELETE(req: NextRequest) {
  try {
    const s = await requireDeveloper(req);
    if (s.viewAs) {
      await run(`UPDATE auth_sessions SET view_as_user_id = NULL, view_as_since = NULL WHERE id = $1`, [s.id]);
      await audit(run, { event: 'view_as.stop', actorId: s.user.id, targetUserId: s.viewAs.id, sessionId: s.id, req });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
