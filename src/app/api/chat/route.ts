import { NextRequest, NextResponse } from 'next/server';
import { LedgerError } from '@/lib/ledger-error';
import { readObject, requireCap, type Actor } from '@/lib/apiAuth';
import { query, withTransaction } from '@/lib/db';
import { answerQuestion, conversationMemory } from '@/lib/chat/router';
import { beginTurn, conversationScope, finishTurn, getConversation, history, interruptedAnswer, resetConversation } from '@/lib/chat/conversations';
import { replyStyle } from '@/lib/chat/lang';
import type { Scope } from '@/lib/chat/templates';
import { sectionKey } from '@/lib/settings';
import { logError, PLAIN_ERROR } from '@/lib/errors';

export const maxDuration = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const response = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
function failure(error: unknown) {
  if (error instanceof LedgerError) return response({ error: error.message }, error.status);
  logError('chat', error);
  return response({ error: PLAIN_ERROR }, 500);
}
async function scopeFor(a: Actor): Promise<Scope> {
  const sections = a.role === 'supervisor' ? (await query(`SELECT s.name FROM supervisor_sections ss JOIN sections s ON s.id = ss.section_id WHERE ss.user_id = $1 AND s.active`, [a.userId])).rows.map((x) => sectionKey(x.name)) : [];
  return { role: a.role === 'owner' ? 'owner' : 'supervisor', sections, userId: a.userId };
}

export async function GET(request: NextRequest) {
  try {
    const a = await requireCap(request, 'chat.use');
    const scope = await scopeFor(a);
    const before = request.nextUrl.searchParams.get('before') ?? undefined;
    if (before && !/^\d{1,18}$/.test(before)) throw new LedgerError('Invalid history cursor.');
    const scopeKey = conversationScope(a, scope);
    await getConversation(a.by, scopeKey);
    return await withTransaction(async (q) => {
      // Hold a shared lock only while reading, so history and its revision describe
      // the same conversation even when another tab sends or clears a message.
      const c = (await q('SELECT * FROM chat_conversations WHERE user_id = $1 AND scope_key = $2 FOR SHARE', [a.by, scopeKey])).rows[0];
      if (!c || (before && request.nextUrl.searchParams.get('conversationId') !== c.id)) throw new LedgerError('This chat changed. Reload the conversation.', 409);
      const turns = await history(c.id, before, 31, q);
      const more = turns.length > 30;
      const page = more ? turns.slice(1) : turns;
      const active = !!c.lease_token && new Date(c.lease_until).getTime() > Date.now();
      const revision = (await q('SELECT COALESCE(MAX(id), 0)::text AS revision FROM chat_turns WHERE conversation_id = $1', [c.id])).rows[0].revision;
      return response({ conversationId: c.id, revision, turns: page.map((t) => ({ ...t, response: t.response ?? (active ? null : interruptedAnswer()) })), more });
    });
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest) {
  try {
    const a = await requireCap(request, 'chat.use');
    const body = await readObject(request);
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) throw new LedgerError('Type a question.');
    if (question.length > 4000) throw new LedgerError('Please keep each message under 4,000 characters.');
    if (typeof body.conversationId !== 'string' || !UUID.test(body.conversationId) || typeof body.requestId !== 'string' || !UUID.test(body.requestId) || typeof body.revision !== 'string' || !/^\d{1,18}$/.test(body.revision)) throw new LedgerError('Reload the chat before sending.');
    const scope = await scopeFor(a);
    const turn = await beginTurn(a.by, conversationScope(a, scope), body.conversationId, body.revision, body.requestId, question);
    if (turn.cached) return response({ success: true, ...turn.turn.response, conversationId: turn.conversation.id, revision: turn.turn.id });
    const c = turn.conversation;
    let memory = { summary: c.summary, through: c.summarized_through, language: replyStyle(question, c.language) };
    let result;
    try {
      // History and summary are loaded from the authenticated conversation, never trusted from the browser.
      const context = await conversationMemory(c, turn.turn.id, `chat:${a.by}`);
      memory = { ...memory, summary: context.summary, through: context.through };
      const answer = await answerQuestion(question, scope, `chat:${a.by}`, { ...context, language: c.language });
      result = answer.result;
      memory.language = answer.language;
    } catch (err) {
      logError('chat.turn', err);
      result = interruptedAnswer();
    }
    await finishTurn(c, body.requestId, turn.turn.id, result, memory);
    return response({ success: true, ...result, conversationId: c.id, revision: turn.turn.id });
  } catch (error) { return failure(error); }
}

export async function DELETE(request: NextRequest) {
  try {
    const a = await requireCap(request, 'chat.use');
    const body = await readObject(request);
    if (typeof body.conversationId !== 'string' || !UUID.test(body.conversationId)) throw new LedgerError('Reload the chat before clearing.');
    const c = await resetConversation(a.by, conversationScope(a, await scopeFor(a)), body.conversationId);
    return response({ conversationId: c.id, revision: '0', turns: [], more: false });
  } catch (error) { return failure(error); }
}
