import { createHash, randomUUID } from 'node:crypto';
import { can, MATRIX } from '../access';
import type { Actor } from '../apiAuth';
import { query, withTransaction, type Q } from '../db';
import { LedgerError } from '../ledger-error';
import type { LanguagePreference } from './lang';
import type { Scope } from './templates';
import type { ChatAnswer } from './router';

export interface Conversation {
  id: string; user_id: string; scope_key: string; summary: string; summarized_through: string;
  language: LanguagePreference | null; lease_token: string | null; lease_until: string | null;
}
export interface Turn { id: string; question: string; response: ChatAnswer | null; created_at: string }
export const RECENT_TURNS = 10;

export function conversationScope(actor: Actor, scope: Scope) {
  return createHash('sha256').update(JSON.stringify({
    as: actor.userId, role: scope.role, sections: [...scope.sections].sort(),
    caps: MATRIX.filter((m) => can(actor.role, m.cap)).map((m) => m.cap),
  })).digest('hex');
}

export async function getConversation(userId: string, scopeKey: string, q: Q = query): Promise<Conversation> {
  await q(`INSERT INTO chat_conversations (id, user_id, scope_key) VALUES ($1, $2, $3)
    ON CONFLICT (user_id, scope_key) DO NOTHING`, [randomUUID(), userId, scopeKey]);
  const r = await q('SELECT * FROM chat_conversations WHERE user_id = $1 AND scope_key = $2', [userId, scopeKey]);
  return r.rows[0];
}

export async function history(conversationId: string, before?: string, limit = 30, q: Q = query): Promise<Turn[]> {
  const r = await q(`SELECT id, question, response, created_at FROM chat_turns
    WHERE conversation_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`, [conversationId, before ?? null, limit]);
  return r.rows.reverse();
}

export async function resetConversation(userId: string, scopeKey: string, expected: string) {
  return withTransaction(async (q) => {
    const r = await q('DELETE FROM chat_conversations WHERE user_id = $1 AND scope_key = $2 AND id = $3 RETURNING id', [userId, scopeKey, expected]);
    if (!r.rowCount) throw new LedgerError('This chat changed on another device. Reload the chat.', 409);
    return getConversation(userId, scopeKey, q);
  });
}

/** Short lease, no database transaction held while waiting on the model. */
export async function beginTurn(userId: string, scopeKey: string, expected: string, revision: string, requestId: string, question: string) {
  return withTransaction(async (q) => {
    const r = await q('SELECT * FROM chat_conversations WHERE user_id = $1 AND scope_key = $2 FOR UPDATE', [userId, scopeKey]);
    const c: Conversation | undefined = r.rows[0];
    if (!c || c.id !== expected) throw new LedgerError('This chat changed. Reload the chat and try again.', 409);
    const old = await q('SELECT * FROM chat_turns WHERE conversation_id = $1 AND request_id = $2', [c.id, requestId]);
    if (old.rows[0] && old.rows[0].question !== question) throw new LedgerError('This request was already used for a different message.', 409);
    if (old.rows[0]?.response) return { conversation: c, turn: old.rows[0] as Turn, cached: true };
    if (c.lease_token && new Date(c.lease_until!).getTime() > Date.now()) throw new LedgerError('An answer is still being prepared. Please wait a moment.', 409);
    const latest = await q('SELECT COALESCE(MAX(id), 0)::text AS revision FROM chat_turns WHERE conversation_id = $1', [c.id]);
    if (!old.rowCount && latest.rows[0].revision !== revision) throw new LedgerError('A new message arrived on another device. Reload the chat before sending.', 409);
    // Recover an abandoned request without leaving a permanent typing indicator.
    await q(`UPDATE chat_turns SET response = $2::jsonb WHERE conversation_id = $1 AND response IS NULL AND request_id <> $3`, [c.id, JSON.stringify(interruptedAnswer()), requestId]);
    await q(`UPDATE chat_conversations SET lease_token = $2, lease_until = now() + interval '3 minutes' WHERE id = $1`, [c.id, requestId]);
    const turn = old.rows[0] ?? (await q('INSERT INTO chat_turns (conversation_id, request_id, question) VALUES ($1, $2, $3) RETURNING *', [c.id, requestId, question])).rows[0];
    return { conversation: c, turn: turn as Turn, cached: false };
  });
}

export function interruptedAnswer(): ChatAnswer {
  return { answer: 'That answer was interrupted. Please send your question again.', rows: [], route: 'help', via: 'rules', lang: 'en', error: true };
}

export async function finishTurn(conversation: Conversation, requestId: string, turnId: string, response: ChatAnswer, memory: { summary: string; through: string; language: LanguagePreference }) {
  return withTransaction(async (q) => {
    const updated = await q(`UPDATE chat_conversations SET lease_token = NULL, lease_until = NULL,
      summary = $3, summarized_through = $4, language = $5::jsonb
      WHERE id = $1 AND user_id = $6 AND lease_token = $2 RETURNING id`,
    [conversation.id, requestId, memory.summary, memory.through, JSON.stringify(memory.language), conversation.user_id]);
    if (!updated.rowCount) throw new LedgerError('The chat was cleared or changed while answering. Reload it to continue.', 409);
    await q('UPDATE chat_turns SET response = $3::jsonb WHERE id = $1 AND conversation_id = $2', [turnId, conversation.id, JSON.stringify(response)]);
    await q('INSERT INTO chat_audit (user_id, question, sql_run, answer) SELECT $1, question, $3, $4 FROM chat_turns WHERE id = $2',
      [conversation.user_id, turnId, JSON.stringify(response.tools ?? []), response.answer]);
  });
}
