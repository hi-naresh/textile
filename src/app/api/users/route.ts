import { NextRequest, NextResponse } from 'next/server';
import { query, type Q } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { requireCap } from '@/lib/apiAuth';
import { listAccounts } from '@/lib/auth/users';

const run: Q = (text, params) => query(text, params as never[]);

// GET /api/users (owner) → { users } — pending sign ups first, then everyone else. Never lists developers.
export async function GET(req: NextRequest) {
  try {
    await requireCap(req, 'users.manage');
    const [users, workers] = await Promise.all([
      listAccounts(run),
      run(`SELECT w.id, w.name, w.section FROM workers w WHERE w.active AND NOT EXISTS (SELECT 1 FROM users u WHERE u.worker_id = w.id) ORDER BY w.name`),
    ]);
    return NextResponse.json({ users, unlinkedWorkers: workers.rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
