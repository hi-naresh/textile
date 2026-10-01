// Audit trail for login, sign up, approval, role and session events, and developer actions (auth_audit).
// Writing an audit row never breaks the action it records.
import type { NextRequest } from 'next/server';
import type { Q } from '../db';

export type AuditEvent =
  | 'login.ok' | 'login.failed' | 'logout'
  | 'signup' | 'signup.approved' | 'signup.rejected'
  | 'user.deactivated' | 'user.reactivated' | 'user.role_changed' | 'user.sections_changed'
  | 'user.created' | 'user.updated' | 'user.deleted' | 'worker.deleted'
  | 'access.changed' | 'agent.settings'
  | 'password.changed' | 'password.reset'
  | 'session.revoked' | 'session.reuse_detected'
  | 'view_as.start' | 'view_as.stop' | 'dev.client_data';

export function requestMeta(req: NextRequest | null | undefined): { ip: string | null; userAgent: string | null } {
  if (!req) return { ip: null, userAgent: null };
  // On Vercel, x-vercel-forwarded-for / x-real-ip are set by the platform (a client can't forge them);
  // x-forwarded-for is only the fallback for other hosts.
  const h = req.headers;
  const raw = h.get('x-vercel-forwarded-for') ?? h.get('x-real-ip') ?? h.get('x-forwarded-for');
  const ip = raw?.split(',')[0]?.trim().slice(0, 64) || null;
  return { ip, userAgent: req.headers.get('user-agent')?.slice(0, 300) || null };
}

export async function audit(
  q: Q,
  e: { event: AuditEvent; actorId?: string | null; targetUserId?: string | null; login?: string | null; sessionId?: string | null; req?: NextRequest | null; detail?: Record<string, unknown> },
): Promise<void> {
  const { ip, userAgent } = requestMeta(e.req);
  try {
    await q(
      `INSERT INTO auth_audit (event, actor_id, target_user_id, login, session_id, ip, user_agent, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [e.event, e.actorId ?? null, e.targetUserId ?? null, e.login?.slice(0, 200) ?? null, e.sessionId ?? null, ip, userAgent, e.detail ? JSON.stringify(e.detail) : null],
    );
  } catch (err) {
    console.error('[audit] could not write', e.event, err);
  }
}
