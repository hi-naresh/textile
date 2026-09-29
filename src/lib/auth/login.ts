// Password sign-in for client users (phone) and the developer (email).
import type { NextRequest } from 'next/server';
import { withTransaction, type Q } from '../db';
import { LedgerError } from '../ledger-error';
import { AUTH } from './config';
import { audit } from './audit';
import { burnPasswordCheck, verifyPassword } from './password';
import { createSession, type Tokens } from './session';


const WRONG = { client: 'Wrong phone number or password.', developer: 'Wrong email or password.' };

async function tooManyFailures(q: Q, login: string): Promise<boolean> {
  const r = await q(
    `SELECT count(*)::int AS n FROM auth_audit
     WHERE event = 'login.failed' AND login = $1 AND ts > now() - make_interval(mins => $2::int)
       AND ts > COALESCE((SELECT max(ts) FROM auth_audit WHERE event = 'login.ok' AND login = $1), '-infinity')`,
    [login, AUTH.failedLoginWindowMinutes],
  );
  return r.rows[0].n >= AUTH.maxFailedLogins;
}

export interface LoginResult { tokens: Tokens; userId: string; status: string; mustChangePassword: boolean }

export async function passwordLogin(req: NextRequest, kind: 'client' | 'developer', login: string, password: string): Promise<LoginResult> {
  // One attempt at a time per login (advisory lock held until commit): parallel guesses can't all slip
  // past the "too many wrong tries" check before any failure is recorded. The failure row is committed
  // first; the error is thrown after, so it is never rolled back.
  const verdict = await withTransaction(async (q): Promise<{ error: LedgerError } | { user: Record<string, unknown> }> => {
    await q(`SELECT pg_advisory_xact_lock(hashtext('login:' || $1))`, [login]);
    if (await tooManyFailures(q, login)) {
      await audit(q, { event: 'login.failed', login, req, detail: { kind, reason: 'rate_limited' } });
      return { error: new LedgerError(`Too many wrong tries. Wait ${AUTH.failedLoginWindowMinutes} minutes and try again.`, 429) };
    }
    const r = kind === 'developer'
      ? await q(`SELECT * FROM users WHERE lower(email) = $1 AND role = 'developer'`, [login])
      : await q(`SELECT * FROM users WHERE phone = $1 AND (role IS NULL OR role IN ('owner', 'supervisor', 'worker'))`, [login]);
    const u = r.rows[0];
    let ok = false;
    if (u) ok = await verifyPassword(password, u.password_hash);
    else await burnPasswordCheck(password);
    if (!u || !ok) {
      await audit(q, { event: 'login.failed', login, targetUserId: u?.id ?? null, req, detail: { kind, reason: u ? 'wrong_password' : 'unknown_login' } });
      return { error: new LedgerError(WRONG[kind], 401) };
    }
    // Right password: now it is safe to say why the account can't be used.
    const refuse = async (reason: string, message: string) => {
      await audit(q, { event: 'login.failed', login, targetUserId: u.id, req, detail: { kind, reason } });
      return { error: new LedgerError(message, 403) };
    };
    if (!u.active) return refuse('deactivated', 'This account is switched off. Ask the owner to turn it back on.');
    if (u.status === 'rejected') {
      return refuse('rejected', u.rejected_count <= AUTH.maxSignupRetries
        ? 'Your sign up was not approved. You can sign up again with this number.'
        : 'Your sign up was not approved. Talk to the owner.');
    }
    return { user: u };
  });
  if ('error' in verdict) throw verdict.error;
  const u = verdict.user as { id: string; status: string; must_change_password: boolean };

  return withTransaction(async (q) => {
    const s = await createSession(q, u.id, kind, req);
    await audit(q, { event: 'login.ok', actorId: u.id, targetUserId: u.id, login, sessionId: s.id, req, detail: { kind } });
    return { tokens: s.tokens, userId: u.id, status: u.status, mustChangePassword: !!u.must_change_password };
  });
}
