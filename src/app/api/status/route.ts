import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/apiAuth';
import { errorResponseBody } from '@/lib/ledger';
import { featureFlags } from '@/lib/health';

// GET /api/status (any signed-in user) → { photoReading, aiWriting }: which features work right now.
// Plain yes/no only — service names, keys and fixes are in the developer console (/api/dev/health).
export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
    return NextResponse.json(await featureFlags(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
