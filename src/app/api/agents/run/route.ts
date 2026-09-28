import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { requireRole } from '@/lib/apiAuth';
import { errorResponseBody } from '@/lib/ledger';
import { runAgents } from '@/lib/agents/runner';

function cronAllowed(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return !process.env.VERCEL; // local development only
  const given = Buffer.from(req.headers.get('authorization') ?? '');
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

// PUBLIC with CRON_SECRET. GET → Vercel Cron (daily; header "Authorization: Bearer $CRON_SECRET").
export async function GET(req: NextRequest) {
  if (!cronAllowed(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json(await runAgents(true));
}

// POST (owner) → run now from the app.
export async function POST(req: NextRequest) {
  try {
    await requireRole(req, 'owner');
    return NextResponse.json(await runAgents(true));
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
