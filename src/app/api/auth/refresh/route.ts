import { NextRequest, NextResponse } from 'next/server';
import { clearAuthCookies, refreshSession, setAuthCookies } from '@/lib/auth/session';
import { logError, PLAIN_ERROR } from '@/lib/errors';

// PUBLIC (needs the refresh cookie). POST → new access + refresh token; the session's expiry slides forward.
export async function POST(req: NextRequest) {
  try {
    const r = await refreshSession(req);
    if (!r.ok) {
      const res = NextResponse.json({ error: 'Please sign in again.' }, { status: 401 });
      clearAuthCookies(res);
      return res;
    }
    const res = NextResponse.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } });
    if (r.tokens) setAuthCookies(res, r.tokens);
    return res;
  } catch (error) {
    logError('auth.refresh', error);
    return NextResponse.json({ error: PLAIN_ERROR }, { status: 500 });
  }
}
