import { NextRequest, NextResponse } from 'next/server';
import { geminiModel, getAiStatus } from '@/lib/gemini';
import { visionKey } from '@/lib/vision';
import { photoStorageMode } from '@/lib/photos';

// GET /api/status → health of external connections, used for in-app warnings.
// ?recheck=1 forces a fresh AI check (Settings → Connections → Check again).
export async function GET(request: NextRequest) {
  const force = request.nextUrl.searchParams.get('recheck') === '1';
  const ai = await getAiStatus(force);
  const storage = photoStorageMode();
  const photos =
    storage === 'supabase'
      ? { state: 'connected' as const, message: 'Photos are stored in Supabase Storage.' }
      : process.env.VERCEL
        ? { state: 'missing' as const, message: 'Photo storage is not connected — photos cannot be saved.', fix: 'Connect Supabase to this project (it adds SUPABASE_URL and SUPABASE_SECRET_KEY).' }
        : { state: 'local' as const, message: 'Photos are saved in this computer’s public/uploads folder (development).' };
  const ocr = visionKey()
    ? { state: 'connected' as const, message: 'Photos are read with Google Cloud Vision OCR first; AI is used only when OCR can’t read a photo.' }
    : { state: 'missing' as const, message: 'OCR is not connected, so every photo is read by the AI model (slower and costs more).', fix: 'Add GOOGLE_VISION_API_KEY (Google Cloud → APIs & Services → enable Cloud Vision API → create an API key) and redeploy.' };
  const models = { low: geminiModel('low'), high: geminiModel('high') };
  return NextResponse.json({ ai, ocr, models, photos }, { headers: { 'Cache-Control': 'no-store' } });
}
