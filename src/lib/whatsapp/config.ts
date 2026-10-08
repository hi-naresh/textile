// WhatsApp Cloud API (Meta, direct) — environment and phone numbers. Server only.
// Not configured (no WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID) → nothing is sent and the app keeps
// offering the wa.me drafts it always had.

/** Graph API version used when WHATSAPP_API_VERSION is not set. v26.0 is the newest listed on
 *  developers.facebook.com/docs/graph-api/changelog/versions (released 29 Jul 2026). */
export const DEFAULT_API_VERSION = 'v26.0';

export const ENV_NAMES = {
  token: 'WHATSAPP_TOKEN',
  phoneId: 'WHATSAPP_PHONE_NUMBER_ID',
  appSecret: 'WHATSAPP_APP_SECRET',
  verifyToken: 'WHATSAPP_VERIFY_TOKEN',
  version: 'WHATSAPP_API_VERSION',
  base: 'WHATSAPP_API_BASE',
} as const;

const env = (k: string) => process.env[k]?.trim() || '';

export interface WaEnv { token: string; phoneId: string; appSecret: string; verifyToken: string; version: string; base: string }

export function waEnv(): WaEnv {
  const v = env(ENV_NAMES.version);
  return {
    token: env(ENV_NAMES.token),
    phoneId: env(ENV_NAMES.phoneId),
    appSecret: env(ENV_NAMES.appSecret),
    verifyToken: env(ENV_NAMES.verifyToken),
    version: /^v\d+\.\d+$/.test(v) ? v : DEFAULT_API_VERSION,
    base: (env(ENV_NAMES.base) || 'https://graph.facebook.com').replace(/\/+$/, ''),
  };
}

/** Can we send? (token + phone number id). Receiving status updates also needs the app secret + verify token. */
export function waConnected(): boolean {
  const e = waEnv();
  return !!(e.token && e.phoneId);
}

/** Which variables are set — names only, never values. */
export function waEnvStatus(): { name: string; set: boolean; need: 'required' | 'optional'; note: string }[] {
  return [
    { name: ENV_NAMES.token, set: !!env(ENV_NAMES.token), need: 'required', note: 'Permanent System User access token (whatsapp_business_messaging).' },
    { name: ENV_NAMES.phoneId, set: !!env(ENV_NAMES.phoneId), need: 'required', note: 'Phone number ID from WhatsApp → API Setup (not the phone number itself).' },
    { name: ENV_NAMES.appSecret, set: !!env(ENV_NAMES.appSecret), need: 'required', note: 'App settings → Basic → App secret. Checks that webhook calls really come from Meta.' },
    { name: ENV_NAMES.verifyToken, set: !!env(ENV_NAMES.verifyToken), need: 'required', note: 'Any long random text you choose; paste the same in Meta’s webhook setup.' },
    { name: ENV_NAMES.version, set: !!env(ENV_NAMES.version), need: 'optional', note: `Graph API version, default ${DEFAULT_API_VERSION}.` },
    { name: ENV_NAMES.base, set: !!env(ENV_NAMES.base), need: 'optional', note: 'Default https://graph.facebook.com (tests point it to a fake server).' },
  ];
}

/**
 * Any stored number → WhatsApp "to" (E.164 digits, no +). Indian 10-digit mobiles get 91.
 * "+91 98250 12345", "098250-12345", "919825012345", "9825012345" → "919825012345". Anything else → null.
 * Numbers with another country code are accepted when written with + or 00 (8–15 digits).
 */
export function waNumber(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).trim();
  if (!s) return null;
  const intl = s.startsWith('+') || s.startsWith('00');
  let d = s.replace(/\D/g, '');
  if (s.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && /^[6-9]/.test(d) && !intl) return `91${d}`;
  if (d.length === 11 && d.startsWith('0') && /^[6-9]/.test(d.slice(1))) return `91${d.slice(1)}`;
  if (d.length === 12 && d.startsWith('91') && /^[6-9]/.test(d.slice(2))) return d;
  if (intl && d.length >= 8 && d.length <= 15 && !d.startsWith('0')) return d;
  return null;
}

/** "919825012345" → "+91 98250 12345" for screens. */
export function showNumber(e164: string | null | undefined): string {
  if (!e164) return '';
  if (e164.length === 12 && e164.startsWith('91')) return `+91 ${e164.slice(2, 7)} ${e164.slice(7)}`;
  return `+${e164}`;
}
