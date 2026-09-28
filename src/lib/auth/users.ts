// Account management shared by the owner (Users & sign ups) and the developer console.
// Rules: only supervisor / worker can be given by the owner; nobody can be made a developer here;
// the owner account itself is set up by the developer.
import type { NextRequest } from 'next/server';
import type { Q } from '../db';
import { LedgerError } from '../ledger-error';
import { cleanName } from '../settings';
import { audit } from './audit';
import { hashPassword, TEMP_PASSWORD } from './password';
import { normalizePhone } from './phone';
import { revokeUserSessions } from './session';

export type AssignableRole = 'supervisor' | 'worker';

export interface AccountRow {
  id: string; name: string; phone: string | null; role: string | null; status: string; requested_role: string | null;
  active: boolean; worker_id: string | null; worker_name: string | null; worker_section: string | null;
  sections: string[]; must_change_password: boolean; rejected_count: number;
  last_login_at: string | null; created_at: string; live_sessions: number;
}

/** Everyone except developers, newest sign ups first. */
export async function listAccounts(q: Q): Promise<AccountRow[]> {
  const r = await q(
    `SELECT u.id, u.name, u.phone, u.role, u.status, u.requested_role, u.active, u.worker_id, w.name AS worker_name, w.section AS worker_section,
            COALESCE((SELECT array_agg(s.name ORDER BY s.sort_order, s.name) FROM supervisor_sections ss JOIN sections s ON s.id = ss.section_id WHERE ss.user_id = u.id AND s.active), '{}') AS sections,
            u.must_change_password, u.rejected_count, u.last_login_at, u.created_at,
            (SELECT count(*)::int FROM auth_sessions a WHERE a.user_id = u.id AND a.revoked_at IS NULL AND a.expires_at > now()) AS live_sessions
     FROM users u LEFT JOIN workers w ON w.id = u.worker_id
     WHERE u.role IS DISTINCT FROM 'developer' AND u.role IS DISTINCT FROM 'admin'
     ORDER BY (u.status = 'pending') DESC, u.active DESC, CASE u.role WHEN 'owner' THEN 0 WHEN 'supervisor' THEN 1 WHEN 'worker' THEN 2 ELSE 3 END, u.name`,
  );
  return r.rows;
}

export async function listSessions(q: Q, userId: string) {
  const r = await q(
    `SELECT id, kind, created_at, last_seen_at, expires_at, ip, user_agent FROM auth_sessions
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`,
    [userId],
  );
  return r.rows;
}

interface Ctx { q: Q; by: string; sessionId: string; req: NextRequest; asDeveloper: boolean }

async function loadForUpdate(q: Q, id: string) {
  const r = await q(`SELECT * FROM users WHERE id = $1 FOR UPDATE`, [id]);
  const u = r.rows[0];
  if (!u || u.role === 'developer' || u.role === 'admin') throw new LedgerError('User not found.', 404);
  return u;
}

function assignable(v: unknown): AssignableRole {
  if (v === 'developer' || v === 'owner') throw new LedgerError('That role can’t be given here.', 403);
  if (v !== 'supervisor' && v !== 'worker') throw new LedgerError('Choose Supervisor or Worker.');
  return v;
}

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

/** A worker account needs a worker record: link an existing unlinked one, or create one in a section. */
async function workerRecordFor(q: Q, userId: string, name: string, b: Record<string, unknown>): Promise<string> {
  if (typeof b.worker_id === 'string' && b.worker_id) {
    const w = await q(`SELECT id FROM workers WHERE id = $1 AND active`, [b.worker_id]);
    if (!w.rowCount) throw new LedgerError('That worker record does not exist.');
    const taken = await q(`SELECT 1 FROM users WHERE worker_id = $1 AND id <> $2`, [b.worker_id, userId]);
    if (taken.rowCount) throw new LedgerError('That worker record already belongs to another account.');
    return b.worker_id;
  }
  const sec = await q(`SELECT name FROM sections WHERE lower(name) = lower($1) AND active`, [cleanName(b.section, 'Section', 60)]);
  if (!sec.rowCount) throw new LedgerError('Choose the worker’s section.');
  const id = `wrk-${Date.now().toString(36)}`;
  await q(`INSERT INTO workers (id, name, section, role, active) VALUES ($1, $2, $3, 'operator', true)`, [id, name, sec.rows[0].name]);
  return id;
}

/** Gives an account its role (approval or role change) and the section / worker record that goes with it. */
async function applyRole(q: Q, u: { id: string; name: string }, role: AssignableRole, b: Record<string, unknown>) {
  if (role === 'supervisor') {
    await q(`UPDATE users SET role = 'supervisor', worker_id = NULL WHERE id = $1`, [u.id]);
    await setSections(q, u.id, b.sections ?? []);
  } else {
    const wid = await workerRecordFor(q, u.id, u.name, b);
    await q(`DELETE FROM supervisor_sections WHERE user_id = $1`, [u.id]);
    await q(`UPDATE users SET role = 'worker', worker_id = $2 WHERE id = $1`, [u.id, wid]);
  }
}

export type AccountAction = 'approve' | 'reject' | 'deactivate' | 'reactivate' | 'set_role' | 'set_sections' | 'set_phone' | 'reset_password' | 'revoke_sessions';

/** Runs one account action inside the caller's transaction. Returns a short message for the toast. */
export async function accountAction(c: Ctx, id: string, action: AccountAction, b: Record<string, unknown>): Promise<string> {
  const { q, by } = c;
  const u = await loadForUpdate(q, id);
  const log = (event: Parameters<typeof audit>[1]['event'], detail?: Record<string, unknown>) =>
    audit(q, { event, actorId: by, targetUserId: id, sessionId: c.sessionId, req: c.req, detail: { ...detail, by_developer: c.asDeveloper || undefined } });
  const isSelf = id === by;
  const ownerAccount = u.role === 'owner';
  // Only the developer manages the owner account (phone, password, sessions).
  if (ownerAccount && !c.asDeveloper && !['revoke_sessions'].includes(action)) throw new LedgerError('The owner account is managed by the developer.', 403);

  switch (action) {
    case 'approve': {
      if (u.status !== 'pending') throw new LedgerError('This sign up was already decided.');
      const role = assignable(b.role);
      await applyRole(q, u, role, b);
      await q(`UPDATE users SET status = 'approved', active = true, decided_by = $2, decided_at = now() WHERE id = $1`, [id, by]);
      await log('signup.approved', { role });
      return `${u.name} approved as ${role}`;
    }
    case 'reject': {
      if (u.status !== 'pending') throw new LedgerError('This sign up was already decided.');
      await q(`UPDATE users SET status = 'rejected', rejected_count = rejected_count + 1, decided_by = $2, decided_at = now() WHERE id = $1`, [id, by]);
      await revokeUserSessions(q, id, 'rejected', by);
      await log('signup.rejected', { rejected_count: u.rejected_count + 1 });
      return `${u.name}’s sign up rejected`;
    }
    case 'deactivate': {
      if (isSelf || ownerAccount) throw new LedgerError('The owner account can’t be switched off.');
      await q(`UPDATE users SET active = false WHERE id = $1`, [id]);
      const ended = await revokeUserSessions(q, id, 'deactivated', by);
      await log('user.deactivated', { sessions_ended: ended });
      return `${u.name} switched off and signed out`;
    }
    case 'reactivate': {
      await q(`UPDATE users SET active = true WHERE id = $1`, [id]);
      await log('user.reactivated');
      return `${u.name} switched on`;
    }
    case 'set_role': {
      if (u.status !== 'approved' || ownerAccount) throw new LedgerError('Only approved supervisors and workers can change role.');
      const role = assignable(b.role);
      if (role === u.role) throw new LedgerError(`${u.name} is already a ${role}.`);
      await applyRole(q, u, role, b);
      const ended = await revokeUserSessions(q, id, 'role_changed', by);
      await log('user.role_changed', { from: u.role, to: role, sessions_ended: ended });
      return `${u.name} is now a ${role}`;
    }
    case 'set_sections': {
      if (u.role !== 'supervisor') throw new LedgerError('Only supervisors have sections.');
      await setSections(q, id, b.sections);
      await log('user.sections_changed', { sections: b.sections });
      return 'Sections saved';
    }
    case 'set_phone': {
      const phone = normalizePhone(b.phone);
      if (!phone) throw new LedgerError('Enter a 10-digit mobile number.');
      const taken = await q(`SELECT 1 FROM users WHERE phone = $1 AND id <> $2`, [phone, id]);
      if (taken.rowCount) throw new LedgerError('Another account already uses this number.', 409);
      // A number with no password yet gets the starting password, to be changed at first login.
      const first = !u.password_hash;
      await q(
        `UPDATE users SET phone = $2 ${first ? ', password_hash = $3, must_change_password = true, password_changed_at = now()' : ''} WHERE id = $1`,
        first ? [id, phone, await hashPassword(TEMP_PASSWORD)] : [id, phone],
      );
      await log('user.updated', { phone, starting_password: first || undefined });
      return first ? `${u.name} can sign in with ${phone} and the starting password` : 'Phone number saved';
    }
    case 'reset_password': {
      if (isSelf) throw new LedgerError('Change your own password under Settings → Account.');
      if (!u.phone) throw new LedgerError('Add a phone number first.');
      await q(`UPDATE users SET password_hash = $2, must_change_password = true, password_changed_at = now() WHERE id = $1`, [id, await hashPassword(TEMP_PASSWORD)]);
      const ended = await revokeUserSessions(q, id, 'password_reset', by);
      await log('password.reset', { sessions_ended: ended });
      return `${u.name}’s password reset to the starting password`;
    }
    case 'revoke_sessions': {
      if (typeof b.session_id === 'string' && b.session_id) {
        const r = await q(`UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'revoked', revoked_by = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [b.session_id, id, by]);
        if (!r.rowCount) throw new LedgerError('That session has already ended.');
        await log('session.revoked', { session_id: b.session_id });
        return 'Device signed out';
      }
      const ended = await revokeUserSessions(q, id, 'revoked', by, isSelf ? c.sessionId : undefined);
      await log('session.revoked', { all: true, sessions_ended: ended });
      return `${ended} device${ended === 1 ? '' : 's'} signed out`;
    }
    default:
      throw new LedgerError('Unknown action.');
  }
}

export const ACCOUNT_ACTIONS: AccountAction[] = ['approve', 'reject', 'deactivate', 'reactivate', 'set_role', 'set_sections', 'set_phone', 'reset_password', 'revoke_sessions'];
