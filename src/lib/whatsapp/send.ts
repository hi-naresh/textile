// send(): one template message, logged in whatsapp_messages. Never throws into the caller's flow —
// a dispatch / payment / cron run must never fail because WhatsApp did.
// Two steps: enqueue() logs it as 'queued' (DB only, fast); deliver() calls Meta and marks it sent / failed.
// Inside a user's save (recording a dispatch) the route enqueues, then runs deliver() in next/server after(),
// so the response never waits for Meta.
//
// Idempotency: a dedupe key (e.g. "dispatch:42", "summary:2026-10-02:919825012345") is unique among rows that
// are not failed, so a retried request / cron run sends nothing twice; a failed one may be tried again.
import { query, type Q } from '../db';
import { logError } from '../errors';
import { waConnected, waNumber } from './config';
import { explain, RATE_LIMIT_CODES, sendTemplateRaw } from './client';
import { clean } from './templates';

const run: Q = (text, params) => query(text, params as never[]);

export type Purpose = 'reminder' | 'dispatch' | 'summary' | 'test';
export type WaStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'received';

export interface SendInput {
  purpose: Purpose;
  to: string | null | undefined; // as stored (10-digit, +91 …) — normalized here
  template: string;
  lang: string;
  params: unknown[];
  partyId?: number | null;
  invoiceIds?: number[] | null;
  dispatchId?: number | null;
  sentBy: string;
  dedupeKey?: string | null;
}

export interface SendResult {
  ok: boolean;
  /** Why nothing was sent (no log row unless 'duplicate'). */
  skipped?: 'not_connected' | 'no_number' | 'duplicate';
  id?: number;
  status?: WaStatus;
  error?: string;
  errorCode?: number | null;
  rateLimited?: boolean;
  to?: string;
}

/** A message logged as 'queued', ready for deliver(). */
export interface QueuedJob { id: number; to: string; template: string; lang: string; params: string[] }

/**
 * Step 1 (fast, DB only): check, normalize and log the message as 'queued'. Returns the job, or why nothing was queued
 * ('duplicate' when the dedupe key was already used by a message that did not fail).
 */
export async function enqueue(i: SendInput): Promise<{ job: QueuedJob | null; result?: SendResult }> {
  if (!waConnected()) return { job: null, result: { ok: false, skipped: 'not_connected', error: 'WhatsApp is not connected.' } };
  const to = waNumber(i.to ?? '');
  if (!to) return { job: null, result: { ok: false, skipped: 'no_number', error: 'No valid WhatsApp number.' } };
  const params = i.params.map((p) => clean(p));
  try {
    const ins = await run(
      `INSERT INTO whatsapp_messages (direction, purpose, phone, template, lang, params, party_id, invoice_ids, dispatch_id, status, dedupe_key, sent_by)
       VALUES ('out', $1, $2, $3, $4, $5, $6, $7, $8, 'queued', $9, $10)
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status <> 'failed' DO NOTHING
       RETURNING id`,
      [i.purpose, to, i.template, i.lang, JSON.stringify(params), i.partyId ?? null, i.invoiceIds?.length ? i.invoiceIds : null, i.dispatchId ?? null, i.dedupeKey ?? null, i.sentBy.slice(0, 80)],
    );
    if (!ins.rows[0]) {
      const prev = await run(`SELECT id, status FROM whatsapp_messages WHERE dedupe_key = $1 AND status <> 'failed' ORDER BY id DESC LIMIT 1`, [i.dedupeKey]);
      return { job: null, result: { ok: true, skipped: 'duplicate', id: prev.rows[0] ? Number(prev.rows[0].id) : undefined, status: prev.rows[0]?.status, to } };
    }
    return { job: { id: Number(ins.rows[0].id), to, template: i.template, lang: i.lang, params } };
  } catch (e) {
    logError('whatsapp.send.log', e, { purpose: i.purpose, template: i.template });
    return { job: null, result: { ok: false, error: 'Could not log the message, so it was not sent.' } };
  }
}

/** Step 2: call Meta (10 s timeout) and mark the logged row sent / failed. Never throws — safe inside after(). */
export async function deliver(job: QueuedJob): Promise<SendResult> {
  const { id, to } = job;
  try {
    const r = await sendTemplateRaw({ to, name: job.template, lang: job.lang, params: job.params });
    if (r.ok) {
      // A webhook may already have moved it on (delivered / read) — never go back.
      await run(
        `UPDATE whatsapp_messages SET wa_id = $2, status = CASE WHEN status = 'queued' THEN 'sent' ELSE status END,
                sent_at = COALESCE(sent_at, now()), updated_at = now() WHERE id = $1`,
        [id, r.data.waId],
      );
      return { ok: true, id, status: 'sent', to };
    }
    const msg = explain(r.error);
    await run(`UPDATE whatsapp_messages SET status = 'failed', error = $2, error_code = $3, failed_at = now(), updated_at = now() WHERE id = $1`, [id, msg, r.error.code]);
    return { ok: false, id, status: 'failed', error: msg, errorCode: r.error.code, rateLimited: r.error.code != null && RATE_LIMIT_CODES.has(r.error.code), to };
  } catch (e) {
    logError('whatsapp.send', e, { id });
    await run(`UPDATE whatsapp_messages SET status = 'failed', error = $2, failed_at = now(), updated_at = now() WHERE id = $1`, [id, 'Unexpected error while sending (see Errors).']).catch(() => {});
    return { ok: false, id, status: 'failed', error: 'Unexpected error while sending.', to };
  }
}

/** Queue + deliver now (the caller waits for Meta's answer): explicit "send" buttons and the daily job. */
export async function send(i: SendInput): Promise<SendResult> {
  const q = await enqueue(i);
  if (!q.job) return q.result!;
  return deliver(q.job);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The last message of a purpose for a party / dispatch, for status chips. */
export interface LastMessage { id: number; status: WaStatus; error: string | null; at: string; phone: string; sent_by: string | null }

export function toLast(r: Record<string, unknown> | undefined): LastMessage | null {
  if (!r) return null;
  return { id: Number(r.id), status: r.status as WaStatus, error: (r.error as string) ?? null, at: new Date(String(r.at)).toISOString(), phone: String(r.phone), sent_by: (r.sent_by as string) ?? null };
}

const LAST_COLS = `id, status, error, phone, sent_by, GREATEST(created_at, updated_at) AS at`;

export async function lastForParty(q: Q, partyId: number, purpose: Purpose): Promise<LastMessage | null> {
  const r = await q(`SELECT ${LAST_COLS} FROM whatsapp_messages WHERE party_id = $1 AND purpose = $2 AND direction = 'out' ORDER BY id DESC LIMIT 1`, [partyId, purpose]).catch(() => null);
  return toLast(r?.rows[0]);
}

export async function lastForDispatch(q: Q, dispatchId: number): Promise<LastMessage | null> {
  const r = await q(`SELECT ${LAST_COLS} FROM whatsapp_messages WHERE dispatch_id = $1 AND purpose = 'dispatch' AND direction = 'out' ORDER BY id DESC LIMIT 1`, [dispatchId]).catch(() => null);
  return toLast(r?.rows[0]);
}
