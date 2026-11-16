import assert from 'node:assert/strict';
import { before, after, test, mock } from 'node:test';
import { createRequire } from 'node:module';
import { NextRequest } from 'next/server';
import { createDisposableDatabase } from '../../scripts/stress/disposable-database';

// Fresh local database: role-policy tests may create captures and change firm settings.
let isolated: Awaited<ReturnType<typeof createDisposableDatabase>>;
let db: typeof import('../../src/lib/db');
let supervisorCookie = '';
let ownerCookie = '';
const route = (name: string) => import(`../../src/app/api/${name}/route.ts`);
const request = (path: string, method = 'GET', body?: unknown, cookie = supervisorCookie) => new NextRequest(`http://localhost/api/${path}`, {
  method, headers: { cookie, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

before(async () => {
  isolated = await createDisposableDatabase('supervisor');
  process.env.DATABASE_URL = isolated.url;
  process.env.DB_QUIET = '1';
  process.env.ALLOW_MOCK_AI = '1';
  process.env.GEMINI_API_KEY = '';
  process.env.GOOGLE_VISION_API_KEY = '';
  process.env.GOOGLE_API_KEY = '';
  db = await import('../../src/lib/db');
  const { createSession } = await import('../../src/lib/auth/session');
  const { recordIncoming, recordOutgoing, createJobCard } = await import('../../src/lib/ledger');
  await db.query("INSERT INTO users (id, name, role) VALUES ('policy-owner', 'Owner', 'owner'), ('policy-supervisor', 'Supervisor', 'supervisor')");
  await db.query("INSERT INTO workers (id, name, section) VALUES ('policy-worker', 'Folder', 'Folding')");
  ownerCookie = `tb_at=${(await createSession(db.query, 'policy-owner', 'client', request(''))).tokens.access}`;
  supervisorCookie = `tb_at=${(await createSession(db.query, 'policy-supervisor', 'client', request(''))).tokens.access}`;
  for (const lot_id of ['POLICY-NEW', 'POLICY-JOB', 'POLICY-CLOSED', '257A']) {
    await db.withTransaction((q) => recordIncoming(q, { lot_id, quality: 'Policy silk', design: 'Plain', finished_meters: 10000, mill_name: 'Test mill' }, { requireLotDetails: true }));
  }
  for (const lot_id of ['POLICY-JOB', 'POLICY-CLOSED']) await db.withTransaction((q) => createJobCard(q, { lot_id, worker_id: 'policy-worker', process: 'Folding', meters_in: 100 }));
  await db.withTransaction((q) => recordOutgoing(q, { lot_id: 'POLICY-CLOSED', meters: 1, party: 'Test party', entry_status: 'end' }, { endAllowed: true }));
  await db.query("UPDATE lots SET cur_location = 'RS 104' WHERE lot_id = 'POLICY-NEW'");
  await db.query('UPDATE app_settings SET ai_auto_confirm_pct = 85 WHERE id = 1');
  // The route's post-response photo-storage task needs a Next request scope. Skip
  // only that task here; extraction, permissions, capture rows and ledger use real code.
  const nextServer = createRequire(`${process.cwd()}/package.json`)('next/server');
  mock.method(nextServer, 'after', () => {});
});

after(async () => {
  mock.restoreAll();
  if (db) await db.default.end();
  if (isolated) await isolated.cleanup();
});

test('#27 supervisor sees new and other-section stock, location and history without summaries', async () => {
  const lots = await route('lots');
  const response = await lots.GET(request('lots?q=Policy%20silk'));
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.ok(page.rows.some((r: { lot_id: string }) => r.lot_id === 'POLICY-NEW'));
  assert.ok(page.rows.some((r: { lot_id: string }) => r.lot_id === 'POLICY-JOB'));
  assert.ok(page.rows.every((r: { lot_id: string }) => r.lot_id !== 'POLICY-CLOSED'));
  assert.equal(page.rows.find((r: { lot_id: string }) => r.lot_id === 'POLICY-NEW').location, 'RS 104');
  assert.equal(Object.hasOwn(page, 'total'), false);
  assert.equal((await lots.GET(request('lots?closed=1'))).status, 403);
  const ledger = await (await (await route('stock/ledger')).GET(request('stock/ledger?lot=POLICY-NEW&facets=1'))).json();
  assert.equal(ledger.rows.length, 1);
  assert.equal(Object.hasOwn(ledger, 'total'), false);
  const jobs = await (await (await route('job-cards')).GET(request('job-cards'))).json();
  assert.ok(jobs.jobCards.some((j: { lot_id: string }) => j.lot_id === 'POLICY-JOB'));
  assert.ok(jobs.jobCards.every((j: { lot_id: string }) => j.lot_id !== 'POLICY-CLOSED'));
  const snapshot = await (await (await route('stock')).GET(request('stock'))).json();
  assert.deepEqual(Object.keys(snapshot).sort(), ['ledger', 'rev']);
  const owner = await (await (await route('stock')).GET(request('stock', 'GET', undefined, ownerCookie))).json();
  assert.ok(owner.stockSummary.on_hand_m > 0);
});

test('#27 direct summaries and chat requests are denied', async () => {
  for (const path of ['lots/summary', 'stock/ledger/summary', 'stock/flow', 'lots/shortage', 'value', 'chat', 'overview', 'inventory', 'reports', 'reports/export']) {
    assert.equal((await (await route(path)).GET(request(path))).status, 403, path);
  }
  const quality = await (await (await route('qualities')).GET(request('qualities'))).json();
  assert.ok(quality.qualities.every((q: object) => !Object.hasOwn(q, 'lots') && !Object.hasOwn(q, 'in_stock_lots')));
  const suggestions = await (await (await route('agents/suggestions')).GET(request('agents/suggestions'))).json();
  assert.deepEqual(suggestions.suggestions, []);
});

test('#27 business writes are rejected before request validation', async () => {
  const writes = [
    ['stock', 'POST'], ['stock/edit', 'PATCH'], ['lots/close', 'POST'], ['lots/location', 'POST'],
    ['job-cards', 'POST'], ['job-cards', 'PATCH'], ['workers', 'POST'],
    ['orders', 'POST'], ['orders/[id]', 'PATCH'], ['orders/[id]/allocate', 'POST'],
    ['allocations/[id]/release', 'POST'], ['dispatches', 'POST'], ['inquiries', 'POST'],
    ['capture/confirm', 'POST'], ['qualities', 'POST'], ['qualities', 'PATCH'],
    ['markets/shops', 'POST'], ['settings', 'PUT'], ['settings/users', 'POST'],
    ['agents/suggestions', 'POST'], ['chat', 'POST'], ['chat', 'DELETE'],
  ];
  for (const [path, method] of writes) {
    const handler = (await route(path))[method];
    assert.equal(typeof handler, 'function', `${method} ${path} exists`);
    const response = await handler(request(path.replace('[id]', '1'), method, {}), { params: Promise.resolve({ id: '1' }) });
    assert.equal(response.status, 403, `${method} ${path}`);
  }
});

test('#27 high-confidence supervisor challans stay pending until the owner confirms', async () => {
  const capture = await route('capture');
  const baseline = Number((await db.query('SELECT COUNT(*) AS n FROM stock_movements')).rows[0].n);
  const ids: number[] = [];
  for (const type of ['incoming_stock', 'outgoing_stock']) {
    const form = new FormData();
    form.set('type', type);
    form.set('file', new File(['local mock image'], 'high-confidence.jpg', { type: 'image/jpeg' }));
    const res = await capture.POST(new NextRequest('http://localhost/api/capture', { method: 'POST', headers: { cookie: supervisorCookie }, body: form }));
    assert.equal(res.status, 200, await res.clone().text());
    const data = await res.json();
    assert.equal(data.autoCommitted, false);
    assert.equal(data.event.status, 'pending');
    ids.push(data.event.id);
  }
  assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM stock_movements')).rows[0].n), baseline);
  const confirm = await route('capture/confirm');
  assert.equal((await confirm.POST(request('capture/confirm', 'POST', { id: ids[0] }))).status, 403);
  const saved = (await db.query('SELECT status FROM capture_events WHERE id = ANY($1::int[])', [ids])).rows;
  assert.ok(saved.every((r) => r.status === 'pending'));
  const ownerForm = new FormData();
  ownerForm.set('type', 'incoming_stock');
  ownerForm.set('file', new File(['local mock image'], 'high-confidence.jpg', { type: 'image/jpeg' }));
  const ownerRes = await capture.POST(new NextRequest('http://localhost/api/capture', { method: 'POST', headers: { cookie: ownerCookie }, body: ownerForm }));
  assert.equal(ownerRes.status, 200);
  const ownerData = await ownerRes.json();
  assert.equal(ownerData.autoCommitted, true, JSON.stringify(ownerData));
  assert.equal(ownerData.event.status, 'confirmed');
  assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM stock_movements')).rows[0].n), baseline + 1);
});

test('#27 navigation exposes stock, capture, job cards and orders without write screens', async () => {
  const { HOME_TAB, navFor, MOBILE_PRIMARY, can, setAccessOff } = await import('../../src/lib/access');
  assert.equal(HOME_TAB.supervisor, 'stock');
  assert.deepEqual(navFor('supervisor').map((x) => x.tab), ['stock', 'capture', 'jobs', 'orders', 'settings']);
  assert.deepEqual(MOBILE_PRIMARY.supervisor, ['stock', 'capture', 'jobs', 'orders']);
  setAccessOff({});
  for (const cap of ['stock.end', 'chat.use', 'capture.confirm', 'jobs.manage'] as const) assert.equal(can('supervisor', cap), false);
});
