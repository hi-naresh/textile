// Meta webhook (field "messages"): delivery statuses of what we sent, and messages people send us.
// Verification: GET with hub.mode=subscribe & hub.verify_token = WHATSAPP_VERIFY_TOKEN → echo hub.challenge.
// Events: POST signed with X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(raw body, WHATSAPP_APP_SECRET).
// Meta retries for up to 36 hours and may send duplicates: everything here is idempotent.
import { createHmac, timingSafeEqual } from 'crypto';
import { query, type Q } from '../db';
import { logError } from '../errors';
import { waEnv } from './config';

const run: Q = (text, params) => query(text, params as never[]);

function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** GET verification. Returns the challenge to echo, or null (→ 403). */
export function verifyChallenge(sp: URLSearchParams): string | null {
  const want = waEnv().verifyToken;
  if (!want) return null;
  if (sp.get('hub.mode') !== 'subscribe') return null;
  if (!same(sp.get('hub.verify_token') ?? '', want)) return null;
  const c = sp.get('hub.challenge') ?? '';
  return /^[A-Za-z0-9_\-.]{1,200}$/.test(c) ? c : null;
}

/** POST signature check on the raw body. False when the app secret is not set. */
export function signatureValid(raw: string, header: string | null): boolean {
  const secret = waEnv().appSecret;
  if (!secret || !header) return false;
  const want = `sha256=${createHmac('sha256', secret).update(raw, 'utf8').digest('hex')}`;
  return same(header.trim().toLowerCase(), want);
}

const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };

interface StatusEvt { id?: string; status?: string; timestamp?: string; recipient_id?: string; errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[] }
interface MsgEvt { id?: string; from?: string; timestamp?: string; type?: string; text?: { body?: string }; button?: { text?: string }; interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } } }
interface Change { field?: string; value?: { statuses?: StatusEvt[]; messages?: MsgEvt[]; contacts?: { wa_id?: string; profile?: { name?: string } }[] } }

const tsOf = (t?: string) => { const n = Number(t); return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : new Date().toISOString(); };

async function applyStatus(s: StatusEvt): Promise<boolean> {
  if (!s.id || !s.status) return false;
  const at = tsOf(s.timestamp);
  if (s.status === 'failed') {
    const e = s.errors?.[0];
    const msg = e ? `${e.title ?? e.message ?? 'Failed'}${e.error_data?.details ? ` — ${e.error_data.details}` : ''}${e.code != null ? ` (#${e.code})` : ''}` : 'Failed (no reason given)';
    // A late "failed" never overrides delivered / read.
    const r = await run(
      `UPDATE whatsapp_messages SET status = 'failed', error = $2, error_code = $3, failed_at = $4, updated_at = now()
       WHERE wa_id = $1 AND status IN ('queued', 'sent')`,
      [s.id, msg.slice(0, 1000), e?.code ?? null, at],
    );
    return !!r.rowCount;
  }
  const rank = RANK[s.status];
  if (rank == null) return false; // e.g. "deleted", "warning": ignore
  // Only move forward (webhooks can arrive out of order); a "read" also means delivered.
  const r = await run(
    `UPDATE whatsapp_messages SET
       status = CASE WHEN status = 'failed' OR (CASE status WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 0 END) < $2 THEN $3 ELSE status END,
       sent_at = COALESCE(sent_at, $4::timestamptz),
       delivered_at = CASE WHEN $2 >= 2 THEN COALESCE(delivered_at, $4::timestamptz) ELSE delivered_at END,
       read_at = CASE WHEN $2 >= 3 THEN COALESCE(read_at, $4::timestamptz) ELSE read_at END,
       error = CASE WHEN status = 'failed' THEN NULL ELSE error END,
       error_code = CASE WHEN status = 'failed' THEN NULL ELSE error_code END,
       updated_at = now()
     WHERE wa_id = $1`,
    [s.id, rank, s.status, at],
  );
  return !!r.rowCount;
}

async function storeIncoming(m: MsgEvt, name: string | null): Promise<boolean> {
  if (!m.id || !m.from) return false;
  const body = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? `[${m.type ?? 'message'}]`;
  const ten = m.from.length === 12 && m.from.startsWith('91') ? m.from.slice(2) : null;
  const r = await run(
    `INSERT INTO whatsapp_messages (direction, purpose, phone, params, body, party_id, status, wa_id, created_at, updated_at)
     VALUES ('in', 'incoming', $1, $2, $3, (SELECT id FROM parties WHERE $4::text IS NOT NULL AND phone = $4 ORDER BY active DESC, id LIMIT 1), 'received', $5, $6, now())
     ON CONFLICT (wa_id) WHERE wa_id IS NOT NULL DO NOTHING`,
    [m.from.slice(0, 20), JSON.stringify({ name, type: m.type ?? null }), body.slice(0, 4000), ten, m.id, tsOf(m.timestamp)],
  );
  return !!r.rowCount;
}

/** Handles one verified POST body. Never throws (Meta must always get 200 once the signature is good). */
export async function handleEvents(payload: unknown): Promise<{ statuses: number; messages: number }> {
  const out = { statuses: 0, messages: 0 };
  try {
    const p = payload as { object?: string; entry?: { changes?: Change[] }[] };
    if (p?.object !== 'whatsapp_business_account' || !Array.isArray(p.entry)) return out;
    for (const e of p.entry) {
      for (const c of e.changes ?? []) {
        if (c.field !== 'messages' || !c.value) continue;
        for (const s of c.value.statuses ?? []) if (await applyStatus(s).catch((err) => { logError('whatsapp.webhook.status', err); return false; })) out.statuses++;
        for (const m of c.value.messages ?? []) {
          const name = c.value.contacts?.find((x) => x.wa_id === m.from)?.profile?.name ?? null;
          if (await storeIncoming(m, name).catch((err) => { logError('whatsapp.webhook.message', err); return false; })) out.messages++;
        }
      }
    }
  } catch (e) {
    logError('whatsapp.webhook', e);
  }
  return out;
}
