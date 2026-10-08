import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { requireRole } from '@/lib/apiAuth';
import { errorResponseBody } from '@/lib/ledger';
import { runAgents } from '@/lib/agents/runner';
import { runWhatsAppDaily } from '@/lib/whatsapp/flows';

function cronAllowed(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return !process.env.VERCEL; // local development only
  const given = Buffer.from(req.headers.get('authorization') ?? '');
  const want = Buffer.from(`Bearer ${secret}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

// PUBLIC with CRON_SECRET. GET → Vercel Cron (daily 01:30 UTC = 07:00 IST, vercel.json; header "Authorization: Bearer $CRON_SECRET").
// Switched-off agents are skipped (developer console → Agents). Then the daily WhatsApp job (owner switches in
// My firm → Policy → WhatsApp): morning summary + automatic payment reminders. It never throws and sends each once per day.
export async function GET(req: NextRequest) {
  if (!cronAllowed(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const agents = await runAgents({ force: true, trigger: 'cron' });
  const whatsapp = await runWhatsAppDaily();
  return NextResponse.json({ ...agents, whatsapp });
}

// POST (owner) → run now from the app.
export async function POST(req: NextRequest) {
  try {
    await requireRole(req, 'owner');
    return NextResponse.json(await runAgents({ force: true, trigger: 'manual' }));
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
