// Cross-site request check for the API (defence in depth on top of SameSite=Lax cookies):
// a write (POST / PUT / PATCH / DELETE) whose Origin is another site is refused.
// Sign-in itself is checked in every route handler (src/lib/apiAuth.ts), not here.
import { NextResponse, type NextRequest } from 'next/server';

export function proxy(req: NextRequest) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return NextResponse.next();
  const origin = req.headers.get('origin');
  if (!origin) return NextResponse.next(); // same-origin fetches from older browsers / server-to-server (cron)
  let host: string | null = null;
  try { host = new URL(origin).host; } catch { host = null; }
  const expected = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!host || host !== expected) return NextResponse.json({ error: 'Cross-site request refused.' }, { status: 403 });
  return NextResponse.next();
}

export const config = { matcher: ['/api/:path*'] };
