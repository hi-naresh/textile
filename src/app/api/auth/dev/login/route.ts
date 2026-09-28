import { NextRequest, NextResponse } from 'next/server';
import { readObject } from '@/lib/apiAuth';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { passwordLogin } from '@/lib/auth/login';
import { normalizeEmail } from '@/lib/auth/phone';
import { setAuthCookies } from '@/lib/auth/session';

// PUBLIC. POST { email, password } → developer sign-in (separate from the client login).
export async function POST(req: NextRequest) {
  try {
    const b = await readObject(req);
    const email = normalizeEmail(b.email);
    if (!email) throw new LedgerError('Enter your email.');
    if (typeof b.password !== 'string' || !b.password) throw new LedgerError('Enter your password.');
    const r = await passwordLogin(req, 'developer', email, b.password);
    const res = NextResponse.json({ success: true });
    setAuthCookies(res, r.tokens);
    return res;
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
