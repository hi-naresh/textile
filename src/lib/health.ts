// Health of external services. Full detail is for the developer console only;
// clients get plain yes/no feature flags (featureFlags).
import { geminiModel, getAiStatus } from './gemini';
import { visionKey } from './vision';
import { photoStorageMode } from './photos';
import type { Features, SystemStatus } from './types';
import { waConnected } from './whatsapp/config';

export async function systemStatus(force = false): Promise<SystemStatus> {
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
  return { ai, ocr, models, photos };
}

export async function featureFlags(): Promise<Features> {
  const st = await systemStatus();
  const aiOk = st.ai.state === 'connected';
  const reader = st.ocr?.state === 'connected' || aiOk || st.ai.state === 'demo';
  return { photoReading: reader && st.photos.state !== 'missing', aiWriting: aiOk, whatsapp: waConnected() };
}

/** Which settings are present (never their values). */
export function connections(): { name: string; set: boolean; note: string }[] {
  const has = (...k: string[]) => k.some((x) => !!process.env[x]?.trim());
  return [
    { name: 'Database', set: has('DATABASE_URL', 'POSTGRES_URL'), note: 'DATABASE_URL / POSTGRES_URL' },
    { name: 'Migrations connection', set: has('MIGRATION_DATABASE_URL', 'POSTGRES_URL_NON_POOLING'), note: 'MIGRATION_DATABASE_URL / POSTGRES_URL_NON_POOLING' },
    { name: 'Photo storage (Supabase)', set: has('SUPABASE_URL') && has('SUPABASE_SECRET_KEY'), note: 'SUPABASE_URL + SUPABASE_SECRET_KEY' },
    { name: 'OCR (Google Cloud Vision)', set: has('GOOGLE_VISION_API_KEY'), note: 'GOOGLE_VISION_API_KEY' },
    { name: 'AI (Gemini)', set: has('GEMINI_API_KEY'), note: 'GEMINI_API_KEY' },
    { name: 'Daily agents cron', set: has('CRON_SECRET'), note: 'CRON_SECRET' },
    { name: 'WhatsApp (Meta Cloud API)', set: has('WHATSAPP_TOKEN') && has('WHATSAPP_PHONE_NUMBER_ID'), note: 'WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID (+ WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN for the webhook)' },
    { name: 'Developer account', set: has('DEV_ADMIN_EMAIL') && has('DEV_ADMIN_PASSWORD'), note: 'DEV_ADMIN_EMAIL + DEV_ADMIN_PASSWORD' },
  ];
}
