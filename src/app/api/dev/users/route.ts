import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction, type Q } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { cleanName, invalidateSettings } from '@/lib/settings';
import { readObject, requireDeveloper } from '@/lib/apiAuth';
import { audit } from '@/lib/auth/audit';
import { hashPassword, newTempPassword, passwordProblem } from '@/lib/auth/password';
import { normalizeEmail, normalizePhone } from '@/lib/auth/phone';
import { revokeUserSessions } from '@/lib/auth/session';
import { randomBytes } from 'crypto';
import { ACCOUNT_ACTIONS, accountAction, listAccounts, listSessions, type AccountAction } from '@/lib/auth/users';

const run: Q = (text, params) => query(text, params as never[]);

// Developer only.
// GET [?sessions=<user id>] → { users, developers, me } or { sessions } for one user.
export async function GET(req: NextRequest) {
  try {
    const s = await requireDeveloper(req);
    const sid = req.nextUrl.searchParams.get('sessions');
    if (sid) return NextResponse.json({ sessions: await listSessions(run, sid) }, { headers: { 'Cache-Control': 'no-store' } });
    const [users, devs] = await Promise.all([
      listAccounts(run),
      run(`SELECT id, name, email, active, last_login_at, (SELECT count(*)::int FROM auth_sessions a WHERE a.user_id = u.id AND a.revoked_at IS NULL AND a.expires_at > now()) AS live_sessions
           FROM users u WHERE role = 'developer' AND deleted_at IS NULL ORDER BY name`),
    ]);
    return NextResponse.json({ users, developers: devs.rows, me: s.user.id }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// POST { action: 'setup_owner', name, phone, password? } → the owner account gets a name + phone and a one-time
//   starting password (random unless given; returned once as temp_password; changed at first login). Only the developer creates the owner.
// POST { action: <account action>, id, ... } → same actions as the owner's screen, plus the owner account
//   (delete works on any client account, the owner included — never your own).
// POST { action: 'add_developer', name, email, password? } → a new developer (e.g. a teammate). Password: given (12+)
//   or a random one returned once as temp_password.
// POST { action: 'reset_developer_password', id } → a new random password for another developer (returned once).
// POST { action: 'delete_developer', id } → removes another developer: signed out, can't sign in, email free again.
//   Not yourself (so at least one developer always remains). History keeps the name.
export async function POST(req: NextRequest) {
  try {
    const s = await requireDeveloper(req);
    const b = await readObject(req);
    const by = s.user.id;
    if (b.action === 'setup_owner') {
      const name = cleanName(b.name, 'Owner name');
      const phone = normalizePhone(b.phone);
      if (!phone) throw new LedgerError('Enter a 10-digit mobile number.');
      const given = typeof b.password === 'string' && b.password ? b.password : null;
      if (given) { const p = passwordProblem(given); if (p) throw new LedgerError(p); }
      const temp = given ?? newTempPassword();
      const hash = await hashPassword(temp);
      const message = await withTransaction(async (q) => {
        const taken = await q(`SELECT id, role FROM users WHERE phone = $1`, [phone]);
        const cur = await q(`SELECT id FROM users WHERE role = 'owner' AND deleted_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE`);
        const old = cur.rowCount ? null : await q(`SELECT 1 FROM users WHERE id = 'usr-owner'`);
        // After the owner was deleted a fresh account is made (the old row stays for history).
        const ownerId: string = cur.rows[0]?.id ?? (old?.rowCount ? `usr-owner-${Date.now().toString(36)}` : 'usr-owner');
        if (taken.rowCount && taken.rows[0].id !== ownerId) throw new LedgerError('Another account already uses this number.', 409);
        await q(
          `INSERT INTO users (id, name, role, phone, password_hash, must_change_password, password_changed_at, status, active)
           VALUES ($1, $2, 'owner', $3, $4, true, now(), 'approved', true)
           ON CONFLICT (id) DO UPDATE SET name = $2, role = 'owner', phone = $3, password_hash = $4, must_change_password = true,
             password_changed_at = now(), status = 'approved', active = true`,
          [ownerId, name, phone, hash],
        );
        await q(`UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'password_reset', revoked_by = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [ownerId, by]);
        await audit(q, { event: 'user.created', actorId: by, targetUserId: ownerId, sessionId: s.id, req, detail: { role: 'owner', phone, by_developer: true } });
        return `${name} can sign in with ${phone}`;
      });
      invalidateSettings();
      return NextResponse.json({ success: true, message, temp_password: temp }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (b.action === 'add_developer' || b.action === 'reset_developer_password' || b.action === 'delete_developer') {
      const r = await developerAction(req, s.id, by, b);
      return NextResponse.json({ success: true, ...r }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (!ACCOUNT_ACTIONS.includes(b.action)) throw new LedgerError('Unknown action.');
    const id = typeof b.id === 'string' ? b.id : '';
    const r = await withTransaction((q) => accountAction({ q, by, sessionId: s.id, req, asDeveloper: true }, id, b.action as AccountAction, b));
    invalidateSettings();
    return NextResponse.json({ success: true, ...r }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

const devPassword = () => randomBytes(12).toString('base64url'); // 16 characters

async function developerAction(req: NextRequest, sessionId: string, by: string, b: Record<string, unknown>): Promise<{ message: string; temp_password?: string }> {
  if (b.action === 'add_developer') {
    const name = cleanName(b.name, 'Name');
    const email = normalizeEmail(b.email);
    if (!email) throw new LedgerError('Enter a valid email.');
    const given = typeof b.password === 'string' && b.password ? b.password : null;
    if (given && given.length < 12) throw new LedgerError('A developer password needs at least 12 characters.');
    const pw = given ?? devPassword();
    const hash = await hashPassword(pw);
    return withTransaction(async (q) => {
      const taken = await q(`SELECT 1 FROM users WHERE lower(email) = $1`, [email]);
      if (taken.rowCount) throw new LedgerError('An account already uses this email.', 409);
      const id = `dev-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
      await q(`INSERT INTO users (id, name, role, email, password_hash, password_changed_at, status, active) VALUES ($1, $2, 'developer', $3, $4, now(), 'approved', true)`, [id, name, email, hash]);
      await audit(q, { event: 'user.created', actorId: by, targetUserId: id, sessionId, req, detail: { role: 'developer', email } });
      return given ? { message: `${name} can sign in at /dev/login with ${email}` } : { message: `${name} can sign in at /dev/login with ${email} and this password`, temp_password: pw };
    });
  }
  const id = typeof b.id === 'string' ? b.id : '';
  if (id === by) throw new LedgerError(b.action === 'delete_developer' ? 'You can’t delete your own account.' : 'Use your own password from the environment / npm run dev:create.', 403);
  return withTransaction(async (q) => {
    const r = await q(`SELECT id, name, email FROM users WHERE id = $1 AND role = 'developer' AND deleted_at IS NULL FOR UPDATE`, [id]);
    const d = r.rows[0];
    if (!d) throw new LedgerError('Developer not found.', 404);
    if (b.action === 'reset_developer_password') {
      const pw = devPassword();
      await q(`UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1`, [id, await hashPassword(pw)]);
      const ended = await revokeUserSessions(q, id, 'password_reset', by);
      await audit(q, { event: 'password.reset', actorId: by, targetUserId: id, sessionId, req, detail: { role: 'developer', sessions_ended: ended } });
      return { message: `${d.name}’s new password (signed out everywhere)`, temp_password: pw };
    }
    const ended = await revokeUserSessions(q, id, 'deleted', by);
    // Email freed (kept unique and non-empty for the developer-email rule); no password; hidden everywhere.
    await q(`UPDATE users SET deleted_at = now(), active = false, password_hash = NULL, email = $2 WHERE id = $1`, [id, `deleted-${id}@removed.invalid`]);
    await audit(q, { event: 'user.deleted', actorId: by, targetUserId: id, sessionId, req, detail: { role: 'developer', email: d.email, sessions_ended: ended } });
    return { message: `${d.name} (developer) deleted` };
  });
}
