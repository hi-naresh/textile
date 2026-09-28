import { NextRequest, NextResponse } from 'next/server';
import { callGemini, geminiKey, parseJsonAnswer } from '@/lib/gemini';

// POST multipart { audio: 16 kHz mono WAV (≤ 25 s), role }
// Speech → text for browsers without built-in speech recognition (e.g. iPhone home-screen app).
// Uses the low-tier model; every call is logged in llm_usage as voice.stt.
export async function POST(req: NextRequest) {
  try {
    const fd = await req.formData();
    const role = String(fd.get('role') ?? '');
    if (role !== 'owner' && role !== 'supervisor') return NextResponse.json({ error: 'Voice chat is for the owner and supervisors.' }, { status: 403 });
    const audio = fd.get('audio') as File | null;
    if (!audio || !audio.size) return NextResponse.json({ error: 'No audio.' }, { status: 400 });
    if (audio.size > 1_000_000) return NextResponse.json({ error: 'Too long — keep it under 25 seconds.' }, { status: 400 });
    if (!geminiKey()) return NextResponse.json({ error: 'Voice on this phone needs the AI key (GEMINI_API_KEY) on the server.' }, { status: 503 });
    const b64 = Buffer.from(await audio.arrayBuffer()).toString('base64');
    const text = await callGemini({
      tier: 'low', feature: 'voice.stt', json: true, timeoutMs: 20_000, ref: 'voice',
      parts: [
        { text: 'Transcribe exactly what the speaker says (a textile business owner; words like lot, challan, meters, folding, party, mill are common). They may speak English, Hindi, Gujarati or a mix. Write Hindi in Devanagari and Gujarati in Gujarati script; keep numbers as digits. If there is no speech, text is "". Reply JSON: {"text": "...", "lang": "en" | "hi" | "gu"}' },
        { inlineData: { mimeType: 'audio/wav', data: b64 } },
      ],
    });
    const out = parseJsonAnswer<{ text?: string; lang?: string }>(text);
    const lang = out.lang === 'hi' || out.lang === 'gu' ? out.lang : 'en';
    return NextResponse.json({ text: (out.text ?? '').trim().slice(0, 500), lang });
  } catch (error) {
    console.error('[chat/transcribe] failed', error);
    return NextResponse.json({ error: 'Could not hear that. Try again.' }, { status: 502 });
  }
}
