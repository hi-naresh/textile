import { NextRequest, NextResponse } from 'next/server';
import { readObject } from '@/lib/apiAuth';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { passwordLogin } from '@/lib/auth/login';
import { normalizePhone } from '@/lib/auth/phone';
import { setAuthCookies } from '@/lib/auth/session';

// PUBLIC. POST { phone, password } → signs in an owner / supervisor / worker (or a pending sign up).
export async function POST(req: NextRequest) {
  try {
    const b = await readObject(req);
    const phone = normalizePhone(b.phone);
    if (!phone) throw new LedgerError('Enter a 10-digit mobile number.');
    if (typeof b.password !== 'string' || !b.password) throw new LedgerError('Enter your password.');
    const r = await passwordLogin(req, 'client', phone, b.password);
    const res = NextResponse.json({ success: true, status: r.status, mustChangePassword: r.mustChangePassword });
    setAuthCookies(res, r.tokens);
    return res;
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
