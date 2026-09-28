// Server-side sessions (auth_sessions). Only SHA-256 hashes of tokens are stored.
// Cookies are httpOnly + SameSite=Lax (+ Secure in production) and set only by the server.
import { createHash, randomBytes } from 'crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { query, type Q } from '../db';
import { AUTH, COOKIE, sessionMs } from './config';
import { audit, requestMeta } from './audit';

const run: Q = (text, params) => query(text, params as never[]);

export type AccountRole = 'owner' | 'supervisor' | 'worker' | 'developer';
export type AccountStatus = 'pending' | 'approved' | 'rejected';

export interface SessionUser {
  id: string;
  name: string;
  role: AccountRole | null;
  status: AccountStatus;
  active: boolean;
  workerId: string | null;
  phone: string | null;
  email: string | null;
  mustChangePassword: boolean;
}

export interface Session {
  id: string;
  kind: 'client' | 'developer';
  user: SessionUser;
  /** Developer "View as": the client user being viewed. */
  viewAs: SessionUser | null;
  viewAsSince: string | null;
}

export interface Tokens { access: string; refresh: string; kind: 'client' | 'developer' }

const token = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function userFrom(r: Record<string, unknown>, p = ''): SessionUser {
  return {
    id: r[`${p}id`] as string,
    name: r[`${p}name`] as string,
    role: (r[`${p}role`] as AccountRole | null) ?? null,
    status: r[`${p}status`] as AccountStatus,
    active: r[`${p}active`] !== false,
    workerId: (r[`${p}worker_id`] as string | null) ?? null,
    phone: (r[`${p}phone`] as string | null) ?? null,
    email: (r[`${p}email`] as string | null) ?? null,
    mustChangePassword: !!r[`${p}must_change_password`],
  };
}

const USER_COLS = (a: string, p = '') =>
  ['id', 'name', 'role', 'status', 'active', 'worker_id', 'phone', 'email', 'must_change_password'].map((c) => `${a}.${c} AS ${p}${c}`).join(', ');

/** Starts a session for a user who just proved who they are. */
export async function createSession(q: Q, userId: string, kind: 'client' | 'developer', req: NextRequest): Promise<{ id: string; tokens: Tokens }> {
  const id = randomBytes(16).toString('hex');
  const access = token();
  const refresh = token();
  const { ip, userAgent } = requestMeta(req);
  await q(
    `INSERT INTO auth_sessions (id, user_id, kind, access_hash, access_expires_at, refresh_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5::int), $6, now() + make_interval(secs => $7::float8), $8, $9)`,
    [id, userId, kind, sha256(access), AUTH.accessMinutes, sha256(refresh), sessionMs(kind) / 1000, ip, userAgent],
  );
  await q(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);
  return { id, tokens: { access, refresh, kind } };
}

/** The session behind the request's access cookie, or null (missing, expired, revoked, user removed). */
export async function readSession(req: NextRequest): Promise<Session | null> {
  const at = req.cookies.get(COOKIE.access)?.value;
  if (!at) return null;
  const r = await run(
    `SELECT s.id AS sid, s.kind, s.view_as_since, ${USER_COLS('u')}, ${USER_COLS('v', 'va_')}, (s.last_seen_at < now() - interval '5 minutes') AS stale
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN users v ON v.id = s.view_as_user_id
     WHERE s.access_hash = $1 AND s.revoked_at IS NULL AND s.access_expires_at > now() AND s.expires_at > now()`,
    [sha256(at)],
  );
  const row = r.rows[0];
  if (!row) return null;
  const user = userFrom(row);
  if (!user.active || user.status === 'rejected') return null;
  if (row.stale) run(`UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1`, [row.sid]).catch(() => {});
  return {
    id: row.sid,
    kind: row.kind,
    user,
    viewAs: row.va_id ? userFrom(row, 'va_') : null,
    viewAsSince: row.view_as_since ? new Date(row.view_as_since).toISOString() : null,
  };
}

export type RefreshResult =
  | { ok: true; tokens: Tokens | null } // tokens null: another tab just refreshed; the browser already holds the new cookies
  | { ok: false };

/** Swaps a refresh token for a new access + refresh token and pushes the session's expiry forward (sliding). */
export async function refreshSession(req: NextRequest): Promise<RefreshResult> {
  const rt = req.cookies.get(COOKIE.refresh)?.value;
  if (!rt) return { ok: false };
  const h = sha256(rt);
  const access = token();
  const refresh = token();
  // Atomic: of two requests with the same token only one rotates it.
  const r = await run(
    `UPDATE auth_sessions s SET
       access_hash = $2, access_expires_at = now() + make_interval(mins => $4::int),
       prev_refresh_hash = s.refresh_hash, refresh_hash = $3, rotated_at = now(),
       expires_at = now() + CASE WHEN s.kind = 'developer' THEN make_interval(secs => $5::float8) ELSE make_interval(secs => $6::float8) END,
       last_seen_at = now()
     FROM users u
     WHERE s.refresh_hash = $1 AND u.id = s.user_id AND s.revoked_at IS NULL AND s.expires_at > now()
       AND u.active AND u.status <> 'rejected'
     RETURNING s.kind`,
    [h, sha256(access), sha256(refresh), AUTH.accessMinutes, sessionMs('developer') / 1000, sessionMs('client') / 1000],
  );
  if (r.rowCount) return { ok: true, tokens: { access, refresh, kind: r.rows[0].kind } };

  // The previous token: fine within the grace window, otherwise it was copied → revoke the session.
  const prev = await run(
    `SELECT id, user_id, (rotated_at > now() - make_interval(secs => $2::float8)) AS in_grace FROM auth_sessions
     WHERE prev_refresh_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [h, AUTH.refreshGraceSeconds],
  );
  const p = prev.rows[0];
  if (!p) return { ok: false };
  if (p.in_grace) return { ok: true, tokens: null };
  await revokeSession(run, p.id, 'refresh_reuse', null);
  await audit(run, { event: 'session.reuse_detected', targetUserId: p.user_id, sessionId: p.id, req });
  return { ok: false };
}

export async function revokeSession(q: Q, sessionId: string, reason: string, by: string | null) {
  await q(`UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2, revoked_by = $3 WHERE id = $1 AND revoked_at IS NULL`, [sessionId, reason, by]);
}

/** Signs a user out everywhere (deactivation, role change, password change). Returns how many sessions ended. */
export async function revokeUserSessions(q: Q, userId: string, reason: string, by: string | null, exceptSessionId?: string): Promise<number> {
  const r = await q(
    `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2, revoked_by = $3
     WHERE user_id = $1 AND revoked_at IS NULL AND ($4::varchar IS NULL OR id <> $4)`,
    [userId, reason, by, exceptSessionId ?? null],
  );
  // Developers viewing as this user stop seeing them.
  await q(`UPDATE auth_sessions SET view_as_user_id = NULL, view_as_since = NULL WHERE view_as_user_id = $1`, [userId]);
  return r.rowCount ?? 0;
}

// ---------- cookies ----------
export function setAuthCookies(res: NextResponse, t: Tokens) {
  const base = { httpOnly: true, secure: COOKIE.secure, sameSite: 'lax' as const };
  res.cookies.set(COOKIE.access, t.access, { ...base, path: '/', maxAge: AUTH.accessMinutes * 60 });
  res.cookies.set(COOKIE.refresh, t.refresh, { ...base, path: COOKIE.refreshPath, maxAge: Math.floor(sessionMs(t.kind) / 1000) });
}

export function clearAuthCookies(res: NextResponse) {
  const base = { httpOnly: true, secure: COOKIE.secure, sameSite: 'lax' as const, maxAge: 0 };
  res.cookies.set(COOKIE.access, '', { ...base, path: '/' });
  res.cookies.set(COOKIE.refresh, '', { ...base, path: COOKIE.refreshPath });
}
