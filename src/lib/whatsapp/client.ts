// Raw calls to the WhatsApp Cloud API (Graph API). Never throws: every call returns ok / error.
//   POST {base}/{version}/{PHONE_NUMBER_ID}/messages   — send a template
//   GET  {base}/{version}/{PHONE_NUMBER_ID}?fields=…    — connection check (display name, quality)
import { waEnv } from './config';

const TIMEOUT_MS = 10_000;

export interface GraphError { message: string; code: number | null; subcode: number | null; details: string | null; http: number }
export type GraphResult<T> = { ok: true; data: T } | { ok: false; error: GraphError };

/** Error codes that mean "slow down" — a batch stops at the first one. */
export const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131048, 131056]);

/** Plain words for the errors people will actually hit; the raw Meta text is kept next to it. */
const HINTS: Record<number, string> = {
  190: 'Access token expired or wrong — make a new permanent token (System User) and update WHATSAPP_TOKEN.',
  10: 'The token has no permission for WhatsApp — give the System User whatsapp_business_messaging.',
  200: 'The token has no permission for WhatsApp — give the System User whatsapp_business_messaging.',
  100: 'Meta refused a value (wrong phone number ID, or a template variable).',
  132000: 'The number of variables does not match the approved template.',
  132001: 'Template not found in this language, or not approved yet (WhatsApp Manager → Message templates).',
  132005: 'Template text too long after filling the variables.',
  132007: 'Template content was flagged by Meta.',
  132012: 'Variable format does not match the approved template.',
  131030: 'This number is not on the test recipient list (API Setup → To). Add it or use your real business number.',
  131026: 'Message could not be delivered — the number may not be on WhatsApp.',
  131047: 'More than 24 hours since the person last wrote — only templates can be sent.',
  131049: 'Meta held this message back to keep engagement healthy. Try another day.',
  131051: 'Unsupported message type.',
  131042: 'Payment problem on the WhatsApp Business account (add a payment method in Business Settings).',
  131031: 'The WhatsApp Business account is restricted or locked.',
  133010: 'The phone number is not registered with the Cloud API yet.',
  130429: 'Sending too fast (rate limit). Try again in a few minutes.',
  131056: 'Too many messages to the same number in a short time.',
  80007: 'WhatsApp Business account rate limit reached.',
  4: 'Too many API calls (rate limit).',
};

export function explain(e: { code: number | null; message: string; details?: string | null }): string {
  const hint = e.code != null ? HINTS[e.code] : undefined;
  const raw = [e.message, e.details].filter(Boolean).join(' — ');
  return `${hint ? `${hint} ` : ''}(${e.code != null ? `#${e.code} ` : ''}${raw || 'no details'})`.slice(0, 1000);
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<GraphResult<T>> {
  const e = waEnv();
  if (!e.token || !e.phoneId) return { ok: false, error: { message: 'WhatsApp is not connected (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID not set).', code: null, subcode: null, details: null, http: 0 } };
  const url = `${e.base}/${e.version}/${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${e.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (err) {
    const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, error: { message: timeout ? `No answer from Meta in ${TIMEOUT_MS / 1000} s.` : `Could not reach Meta: ${err instanceof Error ? err.message : String(err)}`, code: null, subcode: null, details: null, http: 0 } };
  }
  const text = await res.text().catch(() => '');
  let j: Record<string, unknown> = {};
  try { j = text ? JSON.parse(text) : {}; } catch { /* not JSON (proxy error page…) */ }
  if (!res.ok || j.error) {
    const er = (j.error ?? {}) as { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string } };
    return {
      ok: false,
      error: {
        message: er.message || `HTTP ${res.status}${text && !j.error ? `: ${text.slice(0, 200)}` : ''}`,
        code: typeof er.code === 'number' ? er.code : null, subcode: typeof er.error_subcode === 'number' ? er.error_subcode : null,
        details: er.error_data?.details ?? null, http: res.status,
      },
    };
  }
  return { ok: true, data: j as T };
}

export interface SendTemplateBody { to: string; name: string; lang: string; params: string[] }
interface SendResponse { messages?: { id: string; message_status?: string }[]; contacts?: { wa_id: string }[] }

/** Exact request shape from Meta's docs (messages API, type "template", body text parameters). */
export function templatePayload(b: SendTemplateBody) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: b.to,
    type: 'template',
    template: {
      name: b.name,
      language: { code: b.lang },
      ...(b.params.length ? { components: [{ type: 'body', parameters: b.params.map((text) => ({ type: 'text', text })) }] } : {}),
    },
  };
}

export async function sendTemplateRaw(b: SendTemplateBody): Promise<GraphResult<{ waId: string; status: string | null }>> {
  const r = await call<SendResponse>('POST', `${encodeURIComponent(waEnv().phoneId)}/messages`, templatePayload(b));
  if (!r.ok) return r;
  const m = r.data.messages?.[0];
  if (!m?.id) return { ok: false, error: { message: 'Meta answered without a message id.', code: null, subcode: null, details: null, http: 200 } };
  return { ok: true, data: { waId: m.id, status: m.message_status ?? null } };
}

export interface PhoneInfo { id?: string; display_phone_number?: string; verified_name?: string; quality_rating?: string; code_verification_status?: string; platform_type?: string; throughput?: { level?: string } }

export async function phoneInfo(): Promise<GraphResult<PhoneInfo>> {
  return call<PhoneInfo>('GET', `${encodeURIComponent(waEnv().phoneId)}?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,throughput`);
}
