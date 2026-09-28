import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { requireDeveloper } from '@/lib/apiAuth';

// Developer only. GET ?event=login.failed&user=<id>&limit=200 → audit trail, newest first.
export async function GET(req: NextRequest) {
  try {
    await requireDeveloper(req);
    const sp = req.nextUrl.searchParams;
    const event = sp.get('event')?.slice(0, 40) || null;
    const user = sp.get('user')?.slice(0, 50) || null;
    const limit = Math.min(Math.max(parseInt(sp.get('limit') ?? '200', 10) || 200, 1), 1000);
    const r = await query(
      `SELECT a.id, a.ts, a.event, a.actor_id, ua.name AS actor_name, a.target_user_id, ut.name AS target_name, a.login, a.session_id, a.ip, a.user_agent, a.detail
       FROM auth_audit a
       LEFT JOIN users ua ON ua.id = a.actor_id
       LEFT JOIN users ut ON ut.id = a.target_user_id
       WHERE ($1::varchar IS NULL OR a.event = $1 OR a.event LIKE $1 || '.%')
         AND ($2::varchar IS NULL OR a.actor_id = $2 OR a.target_user_id = $2)
       ORDER BY a.id DESC LIMIT $3`,
      [event, user, limit],
    );
    return NextResponse.json({ entries: r.rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
