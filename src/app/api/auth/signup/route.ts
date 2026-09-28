import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { readObject } from '@/lib/apiAuth';
import { query, withTransaction, type Q } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { cleanName } from '@/lib/settings';
import { AUTH } from '@/lib/auth/config';
import { audit, requestMeta } from '@/lib/auth/audit';
import { hashPassword, passwordProblem } from '@/lib/auth/password';
import { normalizePhone } from '@/lib/auth/phone';
import { createSession, setAuthCookies } from '@/lib/auth/session';

const run: Q = (text, params) => query(text, params as never[]);

// PUBLIC. POST { name, phone, password, requested_role?: 'supervisor' | 'worker' }
// → a PENDING account (no role, no data) until the owner approves it and assigns the role.
// A rejected number may sign up again up to AUTH.maxSignupRetries times.
export async function POST(req: NextRequest) {
  try {
    const b = await readObject(req);
    const name = cleanName(b.name, 'Name');
    const phone = normalizePhone(b.phone);
    if (!phone) throw new LedgerError('Enter a 10-digit mobile number.');
    const bad = passwordProblem(b.password);
    if (bad) throw new LedgerError(bad);
    const requested = b.requested_role === 'supervisor' || b.requested_role === 'worker' ? b.requested_role : null;

    const { ip } = requestMeta(req);
    if (ip) {
      const recent = await run(`SELECT count(*)::int AS n FROM auth_audit WHERE event = 'signup' AND ip = $1 AND ts > now() - interval '1 hour'`, [ip]);
      if (recent.rows[0].n >= 10) throw new LedgerError('Too many sign ups from this network. Try again in an hour.', 429);
    }

    const hash = await hashPassword(b.password);
    const s = await withTransaction(async (q) => {
      const cur = await q(`SELECT id, status, rejected_count FROM users WHERE phone = $1 FOR UPDATE`, [phone]);
      const u = cur.rows[0];
      let id: string;
      if (u) {
        if (u.status !== 'rejected') throw new LedgerError('This phone number already has an account. Sign in instead.', 409);
        if (u.rejected_count > AUTH.maxSignupRetries) throw new LedgerError('This number can’t sign up again. Talk to the owner.', 409);
        id = u.id;
        await q(
          `UPDATE users SET name = $2, password_hash = $3, password_changed_at = now(), must_change_password = false,
             status = 'pending', role = NULL, requested_role = $4, decided_by = NULL, decided_at = NULL, active = true
           WHERE id = $1`,
          [id, name, hash, requested],
        );
      } else {
        id = `usr-${randomBytes(6).toString('hex')}`;
        await q(
          `INSERT INTO users (id, name, role, phone, password_hash, password_changed_at, status, requested_role, active)
           VALUES ($1, $2, NULL, $3, $4, now(), 'pending', $5, true)`,
          [id, name, phone, hash, requested],
        );
      }
      const sess = await createSession(q, id, 'client', req);
      await audit(q, { event: 'signup', actorId: id, targetUserId: id, login: phone, sessionId: sess.id, req, detail: { requested_role: requested, retry: u ? u.rejected_count : 0 } });
      return sess;
    });
    const res = NextResponse.json({ success: true, status: 'pending' });
    setAuthCookies(res, s.tokens);
    return res;
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
