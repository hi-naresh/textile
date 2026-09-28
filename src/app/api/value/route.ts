import { NextRequest, NextResponse } from 'next/server';
import { timeSaved } from '@/lib/value';
import { requireUser } from '@/lib/apiAuth';
import { errorResponseBody } from '@/lib/ledger';

// GET → time saved by photo capture vs the manual baseline: today, last 7 days, last 30 days.
export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
    const [today, week, month] = await Promise.all([timeSaved(1), timeSaved(7), timeSaved(30)]);
    return NextResponse.json({ today, week, month }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
