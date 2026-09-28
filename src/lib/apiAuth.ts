// Role checks for API routes. There is no login yet: role + actor come from the request
// (the "Preview as" switch). TODO(auth): take both from the session once login exists.
import { can, type Capability, type Role } from './access';
import { LedgerError } from './ledger-error';

export function roleOf(v: unknown): Role {
  return v === 'owner' || v === 'supervisor' || v === 'worker' ? v : 'worker';
}

/** Throws 403 unless the role has the capability. Returns the role. */
export function requireCap(roleRaw: unknown, cap: Capability): Role {
  const role = roleOf(roleRaw);
  if (!can(role, cap)) throw new LedgerError('You are not allowed to do this.', 403);
  return role;
}

export function actorOf(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 50) : null;
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
