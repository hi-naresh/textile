import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction, type Q } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { cleanName, invalidateSettings } from '@/lib/settings';
import { readObject, requireDeveloper } from '@/lib/apiAuth';
import { audit } from '@/lib/auth/audit';
import { hashPassword, newTempPassword, passwordProblem } from '@/lib/auth/password';
import { normalizePhone } from '@/lib/auth/phone';
import { ACCOUNT_ACTIONS, accountAction, listAccounts, listSessions, type AccountAction } from '@/lib/auth/users';

const run: Q = (text, params) => query(text, params as never[]);

// Developer only.
// GET [?sessions=<user id>] → { users, developers } or { sessions } for one user.
export async function GET(req: NextRequest) {
  try {
    await requireDeveloper(req);
    const sid = req.nextUrl.searchParams.get('sessions');
    if (sid) return NextResponse.json({ sessions: await listSessions(run, sid) }, { headers: { 'Cache-Control': 'no-store' } });
    const [users, devs] = await Promise.all([
      listAccounts(run),
      run(`SELECT id, name, email, active, last_login_at, (SELECT count(*)::int FROM auth_sessions a WHERE a.user_id = u.id AND a.revoked_at IS NULL AND a.expires_at > now()) AS live_sessions
           FROM users u WHERE role = 'developer' ORDER BY name`),
    ]);
    return NextResponse.json({ users, developers: devs.rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// POST { action: 'setup_owner', name, phone, password? } → the owner account gets a name + phone and a one-time
//   starting password (random unless given; returned once as temp_password; changed at first login). Only the developer creates the owner.
// POST { action: <account action>, id, ... } → same actions as the owner's screen, plus the owner account.
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
        const cur = await q(`SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1 FOR UPDATE`);
        const ownerId: string = cur.rows[0]?.id ?? 'usr-owner';
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
