import { NextRequest, NextResponse } from 'next/server';
import { readObject } from '@/lib/apiAuth';
import { withTransaction } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { audit } from '@/lib/auth/audit';
import { hashPassword, passwordProblem, verifyPassword } from '@/lib/auth/password';
import { readSession, revokeUserSessions } from '@/lib/auth/session';

// Signed-in user (any kind, including pending and "must change password"). POST { current, next }
// → sets a new password and signs out every OTHER device of this user.
export async function POST(req: NextRequest) {
  try {
    const s = await readSession(req);
    if (!s) throw new LedgerError('Please sign in again.', 401);
    const b = await readObject(req);
    if (typeof b.current !== 'string' || !b.current) throw new LedgerError('Enter your current password.');
    const bad = passwordProblem(b.next);
    if (bad) throw new LedgerError(bad);
    if (b.next === b.current) throw new LedgerError('The new password must be different.');
    const hash = await hashPassword(b.next);
    await withTransaction(async (q) => {
      const r = await q(`SELECT password_hash FROM users WHERE id = $1 FOR UPDATE`, [s.user.id]);
      if (!(await verifyPassword(b.current, r.rows[0]?.password_hash))) throw new LedgerError('Current password is wrong.');
      await q(`UPDATE users SET password_hash = $2, password_changed_at = now(), must_change_password = false WHERE id = $1`, [s.user.id, hash]);
      const ended = await revokeUserSessions(q, s.user.id, 'password_changed', s.user.id, s.id);
      await audit(q, { event: 'password.changed', actorId: s.user.id, targetUserId: s.user.id, sessionId: s.id, req, detail: { other_sessions_ended: ended } });
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
