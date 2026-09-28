import { NextResponse } from 'next/server';
import { timeSaved } from '@/lib/value';

// GET → time saved by photo capture vs the manual baseline: today, last 7 days, last 30 days.
export async function GET() {
  try {
    const [today, week, month] = await Promise.all([timeSaved(1), timeSaved(7), timeSaved(30)]);
    return NextResponse.json({ today, week, month }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[value] failed', error);
    return NextResponse.json({ error: 'Could not load time saved.' }, { status: 500 });
  }
}
