import { NextRequest, NextResponse } from 'next/server';
import { handleEvents, signatureValid, verifyChallenge } from '@/lib/whatsapp/webhook';

// Meta WhatsApp webhook (configure in the Meta app → WhatsApp → Configuration; subscribe to "messages").
// No user session: protected by WHATSAPP_VERIFY_TOKEN (GET) and the X-Hub-Signature-256 HMAC with WHATSAPP_APP_SECRET (POST).

// PUBLIC with WHATSAPP_VERIFY_TOKEN. GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=… → the challenge as plain text.
export async function GET(req: NextRequest) {
  const challenge = verifyChallenge(req.nextUrl.searchParams);
  if (challenge == null) return new NextResponse('Forbidden', { status: 403 });
  return new NextResponse(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

// PUBLIC with WHATSAPP_APP_SECRET signature. POST → message statuses (sent / delivered / read / failed) + incoming messages, logged.
export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!signatureValid(raw, req.headers.get('x-hub-signature-256'))) return NextResponse.json({ error: 'Bad signature' }, { status: 401 });
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }); }
  const r = await handleEvents(payload);
  return NextResponse.json({ ok: true, ...r });
}
