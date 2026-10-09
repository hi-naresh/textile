import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import pool, { query } from '../../src/lib/db';
import { createSession } from '../../src/lib/auth/session';
import { setAccessOff } from '../../src/lib/access';
import { GET, POST, DELETE } from '../../src/app/api/chat/route';
import { beginTurn, finishTurn, getConversation, history, resetConversation, conversationScope } from '../../src/lib/chat/conversations';
import { replyStyle } from '../../src/lib/chat/lang';
import { answerQuestion, conversationMemory, type ChatAnswer } from '../../src/lib/chat/router';
import { assistantTools, executeTool } from '../../src/lib/chat/tools';
import { appHelp } from '../../src/lib/chat/help';
import { ChatMarkdown } from '../../src/components/ChatMarkdown';
import type { Actor } from '../../src/lib/apiAuth';
import type { Scope } from '../../src/lib/chat/templates';

// Explicitly opt into a disposable local DB. Never load the project's .env here.
const url = new URL(process.env.DATABASE_URL || 'postgresql://localhost/invalid');
if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.endsWith('_test')) throw new Error('Use a disposable local DATABASE_URL ending in _test.');
process.env.DB_QUIET = '1';
process.env.GEMINI_API_KEY = '';
const id = `chat-test-${randomUUID().slice(0, 8)}`;
const owner: Scope = { role: 'owner', sections: [], userId: id };
const supervisor: Scope = { role: 'supervisor', sections: ['folding'], userId: `${id}-s` };
const answer: ChatAnswer = { answer: 'Saved answer', rows: [], lang: 'en', via: 'rules', route: 'help' };
const memory = { summary: '', through: '0', language: replyStyle('hello') };
const context = { recent: [], summary: '', language: null };
let cookie = '';
let workerCookie = '';
let card = 0;
const request = (method: string, body?: unknown, suffix = '', auth = cookie) => new NextRequest(`http://localhost/api/chat${suffix}`, { method, headers: { cookie: auth, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

before(async () => {
  await query("INSERT INTO users (id, name, role) VALUES ($1, 'Chat test owner', 'owner'), ($2, 'Chat test supervisor', 'supervisor'), ($3, 'Chat test worker', 'worker')", [id, `${id}-s`, `${id}-w`]);
  await query("INSERT INTO workers (id, name, section) VALUES ($1, 'Chat Test Folder', 'Folding'), ($2, 'Chat Test Packer', 'Packing')", [id, `${id}-p`]);
  await query("INSERT INTO lots (lot_id, quality, design) VALUES ($1, 'Chat Test', 'Plain'), ($2, 'Chat Test', 'Plain')", [id, `${id}-p`]);
  card = (await query("INSERT INTO job_cards (lot_id, worker_id, process, meters_in, ts_created) VALUES ($1, $1, 'Folding', 600, CURRENT_DATE - 9) RETURNING id", [id])).rows[0].id;
  await query("INSERT INTO job_cards (lot_id, worker_id, process, meters_in) VALUES ($1, $1, 'Packing', 200)", [`${id}-p`]);
  await query("INSERT INTO stock_movements (lot_id, direction, meters, source_doc_id, ts) VALUES ($1, 'IN', 100, $2, CURRENT_DATE - 1), ($1, 'IN', 200, $3, CURRENT_DATE)", [id, `${id}-y`, `${id}-t`]);
  const s = await createSession(query, id, 'client', request('GET'));
  cookie = `tb_at=${s.tokens.access}`;
  const w = await createSession(query, `${id}-w`, 'client', request('GET'));
  workerCookie = `tb_at=${w.tokens.access}`;
});
after(async () => {
  setAccessOff({});
  await query('DELETE FROM job_cards WHERE lot_id = ANY($1::text[])', [[id, `${id}-p`]]);
  await query('DELETE FROM stock_movements WHERE lot_id = $1', [id]);
  await query('DELETE FROM lots WHERE lot_id = ANY($1::text[])', [[id, `${id}-p`]]);
  await query('DELETE FROM workers WHERE id = ANY($1::text[])', [[id, `${id}-p`]]);
  await query('DELETE FROM chat_audit WHERE user_id = ANY($1::text[])', [[id, `${id}-s`, `${id}-w`]]);
  await query('DELETE FROM users WHERE id = ANY($1::text[])', [[id, `${id}-s`, `${id}-w`]]);
  await pool.end();
});

test('language and script follow the user; explicit preference persists', () => {
  assert.deepEqual(replyStyle('kem cho, ketla challan che'), { lang: 'gu', script: 'latin', explicit: false });
  assert.equal(replyStyle('yaar mereko help chahiye').lang, 'hi');
  const gu = replyStyle('talk to me in Gujarati');
  assert.deepEqual(gu, { lang: 'gu', script: 'native', explicit: true });
  assert.deepEqual(replyStyle('list open job cards', gu), gu);
  assert.equal(replyStyle('use romanised letters', gu).script, 'latin');
  assert.equal(replyStyle('reply in English', gu).lang, 'en');
});

test('tools and guides enforce role and switched-off capabilities', async () => {
  assert.equal(appHelp('supervisor', 'money').length, 0);
  assert.ok(appHelp('owner', 'manual-entry')[0].steps.length);
  assert.ok((await executeTool('query_data', { metric: 'outstanding' }, supervisor)).error);
  assert.ok((await executeTool('lookup', { template: 'stock_by_quality' }, supervisor)).error);
  assert.ok((await executeTool('query_data', { metric: '__proto__' }, owner)).error);
  assert.ok((await executeTool('query_data', { metric: 'workers', group_by: 'sql' }, owner)).error);
  assert.ok((await executeTool('query_data', { metric: 'workers', filters: 'worker=Ramesh' }, owner)).error);
  assert.ok((await executeTool('raw_sql', { sql: 'SELECT * FROM users' }, owner)).error);
  setAccessOff({ supervisor: ['jobs.manage'] });
  assert.equal(appHelp('supervisor', 'job-cards').length, 0);
  setAccessOff({});
});

test('work list names specific cards and hides other sections', async () => {
  const r = await executeTool('lookup', { template: 'open_job_cards' }, supervisor);
  assert.match(r.answer!, new RegExp(`JC-${card}`));
  assert.match(r.answer!, /Chat Test Folder/);
  assert.match(r.answer!, /open 9 days/);
  assert.match(r.answer!, /check progress/);
  assert.doesNotMatch(r.answer!, /Chat Test Packer/);
  assert.equal(r.rows?.some(row => row.lot_id === `${id}-p`), false);
});

test('undated totals include older records; yesterday excludes today', async () => {
  const all = await executeTool('query_data', { metric: 'received', filters: { lot: id } }, owner);
  const yesterday = await executeTool('query_data', { metric: 'received', filters: { lot: id }, period: 'yesterday' }, owner);
  assert.equal(all.rows?.[0].value, 300);
  assert.equal(yesterday.rows?.[0].value, 100);
  assert.match(all.answer!, /all recorded dates/);
});

test('fallback answers how-many queries and preserves yesterday boundaries', async () => {
  const count = await answerQuestion('how many workers', owner, 'test', context);
  assert.equal(count.result.route, 'query');
  const result = await answerQuestion('how much received yesterday', owner, 'test', context);
  assert.equal(result.result.route, 'query');
  assert.match(result.result.answer, /yesterday/);
  assert.equal(result.result.rows[0].value, 100);
});

test('follow-up help uses the preceding topic without AI', async () => {
  const recent = [{ id: '1', question: 'Open job cards', response: answer, created_at: new Date().toISOString() }];
  const r = await answerQuestion('help', owner, 'test', { ...context, recent });
  assert.match(r.result.answer, /Close card/);
  assert.match(r.result.answer, /#app=jobs/);
});

test('conversation reload, retry idempotence, question mismatch and stale revision', async () => {
  const c = await getConversation(id, 'persistence');
  const req = randomUUID();
  const t = await beginTurn(id, 'persistence', c.id, '0', req, 'hello');
  await finishTurn(c, req, t.turn.id, answer, memory);
  assert.equal((await getConversation(id, 'persistence')).id, c.id);
  assert.equal((await history(c.id))[0].response?.answer, answer.answer);
  assert.equal((await beginTurn(id, 'persistence', c.id, '0', req, 'hello')).cached, true);
  await assert.rejects(beginTurn(id, 'persistence', c.id, '0', req, 'different'), /different message/);
  await assert.rejects(beginTurn(id, 'persistence', c.id, '0', randomUUID(), 'next'), /another device/);
});

test('simultaneous turns permit only one writer', async () => {
  const c = await getConversation(id, 'race');
  const results = await Promise.allSettled([beginTurn(id, 'race', c.id, '0', randomUUID(), 'one'), beginTurn(id, 'race', c.id, '0', randomUUID(), 'two')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
});

test('clearing removes messages and language and rejects a late answer', async () => {
  const c = await getConversation(id, 'clear');
  const req = randomUUID();
  const t = await beginTurn(id, 'clear', c.id, '0', req, 'hello');
  const fresh = await resetConversation(id, 'clear', c.id);
  assert.notEqual(fresh.id, c.id);
  assert.equal(fresh.language, null);
  assert.deepEqual(await history(c.id), []);
  await assert.rejects(finishTurn(c, req, t.turn.id, answer, memory), /cleared or changed/);
});

test('expired leases recover interrupted messages', async () => {
  const c = await getConversation(id, 'expired');
  const t = await beginTurn(id, 'expired', c.id, '0', randomUUID(), 'abandoned');
  await query("UPDATE chat_conversations SET lease_until = now() - interval '1 minute' WHERE id = $1", [c.id]);
  await beginTurn(id, 'expired', c.id, t.turn.id, randomUUID(), 'new question');
  assert.equal((await history(c.id))[0].response?.error, true);
});

test('older history is summarized while the last ten turns remain intact', async () => {
  const c = await getConversation(id, 'memory');
  await query("INSERT INTO chat_turns (conversation_id, request_id, question, response) SELECT $1, gen_random_uuid(), 'Remember lot ' || n, $2::jsonb FROM generate_series(1, 14) n", [c.id, JSON.stringify(answer)]);
  const last = (await history(c.id)).at(-1)!;
  const m = await conversationMemory(c, String(BigInt(last.id) + BigInt(1)), 'test');
  assert.equal(m.recent.length, 10);
  assert.match(m.summary, /Remember lot 1/);
  assert.equal(m.recent[0].question, 'Remember lot 5');
  assert.notEqual(m.through, '0');
});

test('users, role changes, section changes and capability changes isolate history', async () => {
  const actor = { userId: id, role: 'owner' } as Actor;
  const original = conversationScope(actor, owner);
  assert.notEqual(original, conversationScope({ ...actor, userId: 'other' }, owner));
  assert.notEqual(original, conversationScope({ ...actor, role: 'supervisor' }, supervisor));
  assert.notEqual(conversationScope({ ...actor, role: 'supervisor' }, supervisor), conversationScope({ ...actor, role: 'supervisor' }, { ...supervisor, sections: ['packing'] }));
  const scopedActor = { ...actor, role: 'supervisor' as const };
  const previousScope = conversationScope(scopedActor, supervisor);
  setAccessOff({ supervisor: ['jobs.manage'] });
  assert.notEqual(previousScope, conversationScope(scopedActor, supervisor));
  setAccessOff({});
  const a = await getConversation(id, 'private');
  const b = await getConversation(`${id}-s`, 'private');
  assert.notEqual(a.id, b.id);
  await assert.rejects(beginTurn(`${id}-s`, 'private', a.id, '0', randomUUID(), 'read owner'), /changed/);
});

test('Markdown renders lists/tables and only role-permitted app links', () => {
  const html = renderToStaticMarkup(<ChatMarkdown role="supervisor" navigate={() => {}} text={'**Work**\n\n- A\n- B\n\n| Card | Lot |\n| --- | --- |\n| 1 | 2 |\n\n[Jobs](#app=jobs) [Money](#app=money) [bad](javascript:alert(1)) <script>alert(1)</script>'} />);
  assert.match(html, /<strong>Work<\/strong>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<table>/);
  assert.match(html, /href="#app=jobs"/);
  assert.doesNotMatch(html, /href="#app=money"|href="javascript:|<script>/);
});

test('real handlers save, restore, clear, paginate and enforce authentication', async () => {
  assert.equal((await GET(request('GET', undefined, '', ''))).status, 401);
  assert.equal((await GET(request('GET', undefined, '', workerCookie))).status, 403);
  const loaded = await GET(request('GET'));
  assert.equal(loaded.headers.get('cache-control'), 'private, no-store');
  const c = await loaded.json();
  const posted = await POST(request('POST', { question: 'talk to me in Gujarati', conversationId: c.conversationId, revision: c.revision, requestId: randomUUID() }));
  assert.equal(posted.status, 200);
  const p = await posted.json();
  assert.match(p.answer, /[\u0a80-\u0aff]/);
  const restored = await (await GET(request('GET'))).json();
  assert.equal(restored.turns[0].response.answer, p.answer);
  await query("INSERT INTO chat_turns (conversation_id, request_id, question, response) SELECT $1, gen_random_uuid(), 'Page ' || n, $2::jsonb FROM generate_series(1, 35) n", [c.conversationId, JSON.stringify(answer)]);
  const page = await (await GET(request('GET'))).json();
  assert.equal(page.turns.length, 30);
  assert.equal(page.more, true);
  const older = await (await GET(request('GET', undefined, `?before=${page.turns[0].id}&conversationId=${c.conversationId}`))).json();
  assert.equal(older.turns.length, 6);
  const clear = await DELETE(request('DELETE', { conversationId: c.conversationId }));
  assert.equal(clear.status, 200);
  assert.deepEqual((await (await GET(request('GET'))).json()).turns, []);
  assert.equal((await GET(request('GET', undefined, `?before=${page.turns[0].id}&conversationId=${c.conversationId}`))).status, 409);
});

test('model receives history, language and bounded tools, then their results', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Record<string, unknown>[] = [];
  process.env.GEMINI_API_KEY = 'test-key';
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    calls.push(body);
    const parts = calls.length === 1 ? [{ functionCall: { name: 'app_help', args: { topic: 'job-cards' } }, thoughtSignature: 'test-signature' }] : [{ text: 'Open [Job cards](#app=jobs), then choose **Close**.' }];
    return Response.json({ candidates: [{ content: { role: 'model', parts } }] });
  };
  try {
    const recent = [{ id: '1', question: 'open job cards', response: answer, created_at: new Date().toISOString() }];
    const r = await answerQuestion('help krdo', supervisor, 'chat-test', { recent, summary: 'Earlier: selected lot 123', language: null });
    assert.equal(r.result.route, 'assistant');
    assert.equal(r.language.lang, 'hi');
    assert.equal(calls.length, 2);
    const first = JSON.stringify(calls[0]);
    assert.match(first, /open job cards/);
    assert.match(first, /Earlier: selected lot 123/);
    assert.match(first, /Latin letters/);
    assert.match(JSON.stringify(calls[1]), /functionResponse/);
    assert.match(JSON.stringify(calls[1]), /test-signature/);
    assert.equal(assistantTools(supervisor).find(t => t.name === 'query_data')!.description.includes('outstanding:'), false);
  } finally { globalThis.fetch = originalFetch; process.env.GEMINI_API_KEY = ''; }
});
