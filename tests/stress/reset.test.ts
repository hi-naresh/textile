import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { NextRequest } from 'next/server';
import { Pool } from 'pg';
import { createDisposableDatabase } from '../../scripts/stress/disposable-database';

let isolated: Awaited<ReturnType<typeof createDisposableDatabase>>;
let db: typeof import('../../src/lib/db');
let route: typeof import('../../src/app/api/reset/route');
let cookie: string;
const password = 'Reset-test-only-58291';
const ownerId = 'reset-test-owner';

before(async () => {
  isolated = await createDisposableDatabase('reset');
  process.env.DATABASE_URL = isolated.url;
  process.env.DB_QUIET = '1';
  db = await import('../../src/lib/db');
  route = await import('../../src/app/api/reset/route');
  const { hashPassword } = await import('../../src/lib/auth/password');
  const { createSession } = await import('../../src/lib/auth/session');
  await db.query("INSERT INTO users (id, name, role, password_hash) VALUES ($1, 'Reset owner', 'owner', $2)", [ownerId, await hashPassword(password)]);
  cookie = `tb_at=${(await createSession(db.query, ownerId, 'client', new NextRequest('http://localhost/'))).tokens.access}`;
  await db.query("INSERT INTO lots (lot_id, quality, design) VALUES ('RESET-FIXTURE', 'Reset test', 'Synthetic')");
  await db.query("INSERT INTO stock_movements (lot_id, direction, meters, mill_name) SELECT 'RESET-FIXTURE', 'IN', 1, 'Reset mill' FROM generate_series(1,10000)");
  await db.query("INSERT INTO lot_closures (lot_id, action, reason, adjustment_m) VALUES ('RESET-FIXTURE','reopen', 'manual', 0)");
});
after(async () => {
  if (db) await db.default.end();
  if (isolated) await isolated.cleanup();
});
const post = (overrides: Record<string, unknown> = {}) => route.POST(new NextRequest('http://localhost/api/reset', {
  method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
  body: JSON.stringify({ parts: ['stock'], confirm: 'RESET', password, ...overrides }),
}));
const count = async () => Number((await db.query('SELECT COUNT(*) AS n FROM stock_movements')).rows[0].n);

test('reset requires authentication, explicit confirmation and the current password', async () => {
  assert.equal((await route.POST(new NextRequest('http://localhost/api/reset', { method: 'POST', body: '{}' }))).status, 401);
  assert.equal((await post({ confirm: '' })).status, 400);
  assert.equal((await post({ password: 'wrong-password' })).status, 403);
  assert.equal(await count(), 10000);
});

test('backup includes complete movement and lot-closure history before deletion', async () => {
  const res = await route.GET(new NextRequest('http://localhost/api/reset?backup=stock', { headers: { cookie } }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.tables.stock_movements.length, 10000);
  assert.equal(data.tables.lot_closures.length, 1);
  assert.equal(data.tables.lots[0].bal_m, 10000);
  assert.equal(db.default.totalCount, db.default.idleCount);
});

test('cancelling a slow backup releases its snapshot connection and table locks', async () => {
  const res = await route.GET(new NextRequest('http://localhost/api/reset?backup=stock', { headers: { cookie } }));
  const reader = res.body!.getReader();
  await reader.read();
  await reader.cancel();
  for (let i = 0; i < 100 && db.default.totalCount !== db.default.idleCount; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(db.default.totalCount, db.default.idleCount);
  await db.withTransaction(async (q) => {
    await q("SET LOCAL lock_timeout = '1s'");
    await q('LOCK TABLE stock_movements IN ACCESS EXCLUSIVE MODE');
  });
});

test('a failed reset audit rolls back data and sequence restarts and returns failure', async () => {
  const previous = (await db.query('SELECT last_value, is_called FROM stock_movements_id_seq')).rows[0];
  await db.query(`CREATE FUNCTION reject_reset_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.event = 'data.reset' THEN RAISE EXCEPTION 'injected reset audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_reset_audit BEFORE INSERT ON auth_audit FOR EACH ROW EXECUTE FUNCTION reject_reset_audit()`);
  try {
    const response = await post();
    assert.equal(response.status, 500);
    assert.equal(await count(), 10000);
    assert.deepEqual((await db.query('SELECT last_value, is_called FROM stock_movements_id_seq')).rows[0], previous);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM lot_closures')).rows[0].n, 1);
  } finally { await db.query('DROP TRIGGER reject_reset_audit ON auth_audit; DROP FUNCTION reject_reset_audit()'); }
});

test('separate firm databases keep identical lot IDs and sessions isolated during concurrent reads', async () => {
  const second = await createDisposableDatabase('isolation');
  const other = new Pool({ connectionString: second.url, max: 5 });
  try {
    await other.query('SELECT 1');
    const { createSession } = await import('../../src/lib/auth/session');
    await other.query("INSERT INTO users (id, name, role) VALUES ($1, 'Other firm owner', 'owner')", [ownerId]);
    await other.query("INSERT INTO lots (lot_id, quality, design) VALUES ('RESET-FIXTURE', 'Other firm', 'Other')");
    const session = await createSession((sql, params) => other.query(sql, params), ownerId, 'client', new NextRequest('http://other-firm/'));
    const responses = await Promise.all(Array.from({ length: 20 }, () => route.GET(new NextRequest('http://localhost/api/reset', {
      headers: { cookie: `tb_at=${session.tokens.access}` },
    }))));
    assert.ok(responses.every((r) => r.status === 401));
    const reads = await Promise.all(Array.from({ length: 20 }, async () => [
      (await db.query("SELECT quality FROM lots WHERE lot_id = 'RESET-FIXTURE'")).rows[0].quality,
      (await other.query("SELECT quality FROM lots WHERE lot_id = 'RESET-FIXTURE'")).rows[0].quality,
    ]));
    assert.ok(reads.every(([a, b]) => a === 'Reset test' && b === 'Other firm'));
  } finally { await other.end(); await second.cleanup(); }
});

test('confirmed stock reset removes dependent rows, keeps firm/owner and writes its audit record', async () => {
  const firm = (await db.query('SELECT firm_name FROM app_settings WHERE id = 1')).rows[0].firm_name;
  const response = await post();
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.equal((await response.json()).removed.stock, 10002);
  assert.equal(await count(), 0);
  for (const table of ['lots', 'lot_closures', 'lot_locations', 'job_cards', 'allocations', 'known_names', 'lot_facets']) {
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n, 0);
  }
  assert.equal((await db.query('SELECT firm_name FROM app_settings WHERE id = 1')).rows[0].firm_name, firm);
  assert.equal((await db.query('SELECT id FROM users WHERE id = $1', [ownerId])).rowCount, 1);
  assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM auth_audit WHERE event = 'data.reset'")).rows[0].n, 1);
  assert.equal(Number((await db.query("SELECT nextval('stock_movements_id_seq') AS id")).rows[0].id), 1);
});
