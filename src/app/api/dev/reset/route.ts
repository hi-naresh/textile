import { NextRequest, NextResponse } from 'next/server';
import { errorResponseBody } from '@/lib/ledger';
import { requireDeveloper } from '@/lib/apiAuth';
import { resetGet, resetPost } from '@/lib/resetRoute';

// Developer console → Reset data. Same as the owner's My firm → Reset data; confirmed with the developer's password.
export async function GET(req: NextRequest) {
  try {
    await requireDeveloper(req);
    return await resetGet(req);
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

export async function POST(req: NextRequest) {
  try {
    const s = await requireDeveloper(req);
    return await resetPost(req, { userId: s.user.id, sessionId: s.id, viaDeveloper: true });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
