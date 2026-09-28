import { NextRequest, NextResponse } from 'next/server';
import { query, type Q } from '@/lib/db';
import { COOKIE } from '@/lib/auth/config';
import { audit } from '@/lib/auth/audit';
import { clearAuthCookies, revokeSession, sha256 } from '@/lib/auth/session';
import { logError } from '@/lib/errors';

const run: Q = (text, params) => query(text, params as never[]);

// PUBLIC. POST → ends this device's session (found by either cookie) and clears the cookies.
export async function POST(req: NextRequest) {
  const at = req.cookies.get(COOKIE.access)?.value;
  const rt = req.cookies.get(COOKIE.refresh)?.value;
  try {
    if (at || rt) {
      const r = await run(
        `SELECT id, user_id FROM auth_sessions WHERE revoked_at IS NULL AND (access_hash = $1 OR refresh_hash = $2)`,
        [at ? sha256(at) : '', rt ? sha256(rt) : ''],
      );
      for (const s of r.rows) {
        await revokeSession(run, s.id, 'logout', s.user_id);
        await audit(run, { event: 'logout', actorId: s.user_id, targetUserId: s.user_id, sessionId: s.id, req });
      }
    }
  } catch (error) {
    logError('auth.logout', error);
  }
  const res = NextResponse.json({ success: true });
  clearAuthCookies(res);
  return res;
}
