// Where capture photos are kept.
// - Vercel + Supabase: private Supabase Storage bucket (the server's own disk is wiped on Vercel).
// - Local development without Supabase: public/uploads on disk.
// The DB stores a reference: "sb:<bucket>/<path>" for Supabase, "/uploads/<file>" for local files.
import fs from 'fs';
import path from 'path';

const BUCKET = process.env.PHOTO_BUCKET || 'capture-photos';
const SIGNED_URL_SECONDS = 60 * 60;

function supabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  // New Supabase keys (SUPABASE_SECRET_KEY) or the legacy service-role key.
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const legacyJwt = key.startsWith('eyJ');
  const headers: Record<string, string> = { apikey: key };
  if (legacyJwt) headers.Authorization = `Bearer ${key}`;
  return { base: `${url.replace(/\/$/, '')}/storage/v1`, headers };
}

export function photoStorageMode(): 'supabase' | 'local' {
  return supabase() ? 'supabase' : 'local';
}

let bucketReady = false;
async function ensureBucket(sb: NonNullable<ReturnType<typeof supabase>>) {
  if (bucketReady) return;
  const res = await fetch(`${sb.base}/bucket`, {
    method: 'POST',
    headers: { ...sb.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: 15 * 1024 * 1024 }),
  });
  // 200 = created; 400/409 = already exists. Anything else is a real problem.
  if (!res.ok && res.status !== 400 && res.status !== 409) {
    throw new Error(`Photo storage: could not prepare bucket (${res.status} ${await res.text()})`);
  }
  bucketReady = true;
}

/** Save a photo and return the reference to store in capture_events.photo_url. */
export async function savePhoto(buffer: Buffer, name: string, contentType: string): Promise<string> {
  const sb = supabase();
  if (sb) {
    await ensureBucket(sb);
    const objectPath = `${new Date().toISOString().slice(0, 7)}/${name}`; // e.g. 2026-09/incoming_stock_123.jpg
    const res = await fetch(`${sb.base}/object/${BUCKET}/${objectPath}`, {
      method: 'POST',
      headers: { ...sb.headers, 'Content-Type': contentType, 'x-upsert': 'false' },
      body: new Uint8Array(buffer),
    });
    if (!res.ok) throw new Error(`Photo storage: upload failed (${res.status} ${await res.text()})`);
    return `sb:${BUCKET}/${objectPath}`;
  }
  if (process.env.VERCEL) throw new Error('Photo storage is not configured (SUPABASE_URL and SUPABASE_SECRET_KEY are missing).');
  const dir = path.join(process.cwd(), 'public', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buffer);
  return `/uploads/${name}`;
}

/** URL the browser can show for a stored reference. */
export function photoUrlForClient(ref: string | null): string | null {
  if (!ref) return null;
  return ref.startsWith('sb:') ? `/api/photos?ref=${encodeURIComponent(ref)}` : ref;
}

/** Short-lived signed URL for a Supabase-stored photo. */
export async function signedPhotoUrl(ref: string): Promise<string | null> {
  const sb = supabase();
  if (!sb || !ref.startsWith('sb:')) return null;
  const objectPath = ref.slice(3); // "<bucket>/<path>"
  if (objectPath.includes('..')) return null;
  const res = await fetch(`${sb.base}/object/sign/${objectPath}`, {
    method: 'POST',
    headers: { ...sb.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: SIGNED_URL_SECONDS }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { signedURL?: string; signedUrl?: string };
  const signed = data.signedURL || data.signedUrl;
  return signed ? `${sb.base}${signed.startsWith('/') ? '' : '/'}${signed}` : null;
}
