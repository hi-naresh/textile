import { NextRequest, NextResponse } from 'next/server';
import { getAiStatus } from '@/lib/gemini';
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
  return NextResponse.json({ ai, photos }, { headers: { 'Cache-Control': 'no-store' } });
}
