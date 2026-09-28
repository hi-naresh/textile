import { NextRequest, NextResponse } from 'next/server';
import { signedPhotoUrl } from '@/lib/photos';
import { requireUser } from '@/lib/apiAuth';
import { errorResponseBody } from '@/lib/ledger';

// GET /api/photos?ref=sb:capture-photos/2026-09/x.jpg → redirect to a short-lived signed URL.
// Photos stay in a private bucket; only the app hands out temporary links, and only to signed-in users.
export async function GET(request: NextRequest) {
  try {
    await requireUser(request);
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
  const ref = request.nextUrl.searchParams.get('ref') || '';
  if (!ref.startsWith('sb:')) return NextResponse.json({ error: 'Invalid photo reference.' }, { status: 400 });
  const url = await signedPhotoUrl(ref);
  if (!url) return NextResponse.json({ error: 'Photo not found.' }, { status: 404 });
  return NextResponse.redirect(url, { status: 302, headers: { 'Cache-Control': 'private, max-age=300' } });
}
