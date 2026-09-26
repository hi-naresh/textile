// Turns a Postgres URL into pg settings that work both locally and on hosted Postgres (Supabase/Neon).
// Hosted providers need TLS; their pooler certificates don't verify under node-postgres's strict
// `sslmode=require` handling, so TLS is set explicitly and the sslmode flag is removed from the URL.
import type { ConnectionOptions } from 'tls';

export function resolveDbConfig(url: string | undefined, fallback: string): { connectionString: string; ssl: false | ConnectionOptions } {
  const raw = url && url.trim() ? url.trim() : fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { connectionString: raw, ssl: false };
  }
  const host = parsed.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
  const mode = parsed.searchParams.get('sslmode');
  parsed.searchParams.delete('sslmode');
  parsed.searchParams.delete('sslrootcert');
  const wantsTls = !local && mode !== 'disable';
  return { connectionString: parsed.toString(), ssl: wantsTls ? { rejectUnauthorized: false } : false };
}
