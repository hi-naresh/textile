import { NextRequest, NextResponse } from 'next/server';
import { readObject } from '@/lib/apiAuth';
import { runAgents } from '@/lib/agents/runner';

// GET  → Vercel Cron (daily; header "Authorization: Bearer $CRON_SECRET" when CRON_SECRET is set).
// POST → run now from the app ({ role: 'owner' }).
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json(await runAgents(true));
}

export async function POST(req: NextRequest) {
  const b = await readObject(req).catch(() => null);
  if (!b) return NextResponse.json({ error: 'Send a JSON object like { "role": "owner" }.' }, { status: 400 });
  if (b.role !== 'owner') return NextResponse.json({ error: 'Only the owner can run the agents.' }, { status: 403 });
  return NextResponse.json(await runAgents(true));
}
