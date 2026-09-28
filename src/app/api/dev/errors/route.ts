import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { requireDeveloper } from '@/lib/apiAuth';

// Developer only. GET ?days=7 → technical error details (message, stack, context) logged by the server.
export async function GET(req: NextRequest) {
  try {
    await requireDeveloper(req);
    const d = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get('days') ?? '7', 10) || 7, 1), 90);
    const r = await query(
      `SELECT id, ts, source, message, stack, user_id, detail FROM app_errors WHERE ts > now() - make_interval(days => $1::int) ORDER BY id DESC LIMIT 200`,
      [d],
    );
    return NextResponse.json({ days: d, errors: r.rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
