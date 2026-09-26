import { NextRequest, NextResponse } from 'next/server';
import { signedPhotoUrl } from '@/lib/photos';

// GET /api/photos?ref=sb:capture-photos/2026-09/x.jpg → redirect to a short-lived signed URL.
// Photos stay in a private bucket; only the app hands out temporary links.
export async function GET(request: NextRequest) {
  const ref = request.nextUrl.searchParams.get('ref') || '';
  if (!ref.startsWith('sb:')) return NextResponse.json({ error: 'Invalid photo reference.' }, { status: 400 });
  const url = await signedPhotoUrl(ref);
  if (!url) return NextResponse.json({ error: 'Photo not found.' }, { status: 404 });
  return NextResponse.redirect(url, { status: 302, headers: { 'Cache-Control': 'private, max-age=300' } });
}
