import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { NextRequest } from 'next/server';
import { POST as validateStockImport } from '../../src/app/api/stock/import/route';
import { createSession } from '../../src/lib/auth/session';
import pool, { query } from '../../src/lib/db';

const databaseUrl = new URL(process.env.DATABASE_URL || 'postgresql://localhost/invalid');
if (!['localhost', '127.0.0.1', '::1'].includes(databaseUrl.hostname) || !databaseUrl.pathname.endsWith('_test')) {
  throw new Error('Use a disposable local DATABASE_URL ending in _test.');
}
process.env.DB_QUIET = '1';

const ownerId = `st-im-${randomUUID().replace(/-/g, '').slice(0, 10)}`;
let ownerCookie = '';

before(async () => {
  await query(`INSERT INTO users (id, name, role) VALUES ($1, 'Stress import owner', 'owner')`, [ownerId]);
  const sessionRequest = new NextRequest('http://localhost/');
  ownerCookie = `tb_at=${(await createSession(query, ownerId, 'client', sessionRequest)).tokens.access}`;
});

after(async () => {
  await query('DELETE FROM api_rate_limits WHERE user_id = $1', [ownerId]);
  await query('DELETE FROM auth_audit WHERE actor_id = $1', [ownerId]);
  await query('DELETE FROM auth_sessions WHERE user_id = $1', [ownerId]);
  await query('DELETE FROM users WHERE id = $1', [ownerId]);
  await pool.end();
});

test('stock import route rejects a file larger than 8 MB with a clear message', async () => {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'too-large.xlsx'));
  const req = new NextRequest('http://localhost/api/stock/import', {
    method: 'POST',
    headers: { cookie: ownerCookie },
    body: form,
  });
  const response = await validateStockImport(req);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /larger than 8 MB/);
});
