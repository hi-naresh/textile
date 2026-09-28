import { NextRequest, NextResponse } from 'next/server';
import { readSession, type SessionUser } from '@/lib/auth/session';
import { AUTH } from '@/lib/auth/config';
import { logError, PLAIN_ERROR } from '@/lib/errors';

const pub = (u: SessionUser) => ({ id: u.id, name: u.name, role: u.role, status: u.status, phone: u.phone, email: u.email, workerId: u.workerId, mustChangePassword: u.mustChangePassword });

// PUBLIC (answers 401 without a session). GET → who is signed in on this device.
export async function GET(req: NextRequest) {
  try {
    const s = await readSession(req);
    if (!s) return NextResponse.json({ error: 'Please sign in again.' }, { status: 401 });
    return NextResponse.json(
      { kind: s.kind, user: pub(s.user), viewAs: s.viewAs ? pub(s.viewAs) : null, viewAsSince: s.viewAsSince, viewAsWrite: s.kind === 'developer' && AUTH.viewAsWrite },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    logError('auth.me', error);
    return NextResponse.json({ error: PLAIN_ERROR }, { status: 500 });
  }
}
