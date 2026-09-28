// Who is calling an API route, and may they do this? Always taken from the session cookie —
// never from the request body or query string (any `role` / `actor` sent by the browser is ignored).
//
// Every route handler calls one of: requireUser, requireCap, requireRole, requireDeveloper
// (or is listed in scripts/check-route-auth.js as public). `npm run lint:auth` checks this.
import type { NextRequest } from 'next/server';
import { can, type Capability, type Role } from './access';
import { LedgerError } from './ledger-error';
import { query, type Q } from './db';
import { readSession, type Session, type SessionUser } from './auth/session';
import { AUTH } from './auth/config';
import { audit } from './auth/audit';

const run: Q = (text, params) => query(text, params as never[]);

export interface Actor {
  sessionId: string;
  /** Whose data this is: scope (a worker's own cards, a supervisor's sections). The viewed user during "View as". */
  userId: string;
  role: Role;
  name: string;
  workerId: string | null;
  /** Who is really acting — use for created_by / moved_by / confirmed_by. The developer during "View as". */
  by: string;
  /** Set while a developer is viewing as this user. */
  developerId: string | null;
}

const CLIENT_ROLES: Role[] = ['owner', 'supervisor', 'worker'];
const isClientRole = (r: unknown): r is Role => CLIENT_ROLES.includes(r as Role);
const readOnlyMethod = (m: string) => m === 'GET' || m === 'HEAD';

async function sessionOrThrow(req: NextRequest): Promise<Session> {
  const s = await readSession(req);
  if (!s) throw new LedgerError('Please sign in again.', 401);
  return s;
}

function clientActor(s: Session, u: SessionUser, developerId: string | null): Actor {
  return { sessionId: s.id, userId: u.id, role: u.role as Role, name: u.name, workerId: u.workerId, by: developerId ?? u.id, developerId };
}

/** Any approved, active owner / supervisor / worker — or a developer viewing as one. */
export async function requireUser(req: NextRequest): Promise<Actor> {
  const s = await sessionOrThrow(req);
  if (s.kind === 'developer') {
    const v = s.viewAs;
    if (!v) throw new LedgerError('Choose a user to view as in the developer console.', 403);
    if (!v.active || v.status !== 'approved' || !isClientRole(v.role)) throw new LedgerError('This user can no longer be viewed.', 403);
    if (!readOnlyMethod(req.method) && !AUTH.viewAsWrite) throw new LedgerError('View as is read-only.', 403);
    await audit(run, {
      event: 'dev.client_data', actorId: s.user.id, targetUserId: v.id, sessionId: s.id, req,
      detail: { method: req.method, path: req.nextUrl.pathname, query: req.nextUrl.search.slice(0, 300) || undefined },
    });
    return clientActor(s, v, s.user.id);
  }
  const u = s.user;
  if (u.status === 'pending') throw new LedgerError('Your account is waiting for the owner’s approval.', 403);
  if (u.status !== 'approved' || !isClientRole(u.role)) throw new LedgerError('You are not allowed to do this.', 403);
  if (u.mustChangePassword) throw new LedgerError('Set a new password to continue.', 403);
  return clientActor(s, u, null);
}

/** 403 unless the caller's role has the capability (src/lib/access.ts → MATRIX). */
export async function requireCap(req: NextRequest, cap: Capability): Promise<Actor> {
  const a = await requireUser(req);
  if (!can(a.role, cap)) throw new LedgerError('You are not allowed to do this.', 403);
  return a;
}

export async function requireRole(req: NextRequest, ...roles: Role[]): Promise<Actor> {
  const a = await requireUser(req);
  if (!roles.includes(a.role)) throw new LedgerError('You are not allowed to do this.', 403);
  return a;
}

/** Developer console only. Any client session — even the owner's — gets 404, as if the route did not exist. */
export async function requireDeveloper(req: NextRequest): Promise<Session> {
  const s = await readSession(req);
  if (!s || s.kind !== 'developer' || s.user.role !== 'developer' || s.user.status !== 'approved') throw new LedgerError('Not found', 404);
  return s;
}

/** Request body as a JSON object. Anything else (bad JSON, null, an array, a string) → 400. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route handlers validate each field themselves
export async function readObject(req: Request): Promise<Record<string, any>> {
  let b: unknown;
  try { b = await req.json(); } catch { throw new LedgerError('The request body is not valid JSON.'); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new LedgerError('Send a JSON object.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return b as Record<string, any>;
}
