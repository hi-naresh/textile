import { NextRequest, NextResponse } from 'next/server';
import { errorResponseBody } from '@/lib/ledger';
import { requireRole } from '@/lib/apiAuth';
import { resetGet, resetPost } from '@/lib/resetRoute';

// My firm → Reset data (owner only). See src/lib/resetRoute.ts for the contract.
export async function GET(req: NextRequest) {
  try {
    await requireRole(req, 'owner');
    return await resetGet(req);
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

export async function POST(req: NextRequest) {
  try {
    const a = await requireRole(req, 'owner');
    return await resetPost(req, { userId: a.by, sessionId: a.sessionId, viaDeveloper: !!a.developerId });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
