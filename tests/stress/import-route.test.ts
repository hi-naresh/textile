import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { NextRequest } from 'next/server';
import { POST as validateStockImport } from '../../src/app/api/stock/import/route';
import { POST as commitStockImport } from '../../src/app/api/stock/import/commit/route';
import { IMPORT_SHEET, TEMPLATE_COLUMNS, newBook, type ValidateResult } from '../../src/lib/stock-import';
import { toBuffer } from '../../src/lib/excel';
import { createSession } from '../../src/lib/auth/session';
import pool, { query } from '../../src/lib/db';

const databaseUrl = new URL(process.env.DATABASE_URL || 'postgresql://localhost/invalid');
if (!['localhost', '127.0.0.1', '::1'].includes(databaseUrl.hostname) || !databaseUrl.pathname.endsWith('_test')) {
  throw new Error('Use a disposable local DATABASE_URL ending in _test.');
}
process.env.DB_QUIET = '1';

const ownerId = `st-im-${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const lotId = `RESUME-${randomUUID().slice(0, 8)}`.toUpperCase();
let ownerCookie = '';

before(async () => {
  await query(`INSERT INTO users (id, name, role) VALUES ($1, 'Stress import owner', 'owner')`, [ownerId]);
  const sessionRequest = new NextRequest('http://localhost/');
  ownerCookie = `tb_at=${(await createSession(query, ownerId, 'client', sessionRequest)).tokens.access}`;
});

after(async () => {
  await query('DELETE FROM lot_locations WHERE lot_id = $1', [lotId]);
  await query('DELETE FROM stock_movements WHERE lot_id = $1', [lotId]);
  await query('DELETE FROM lots WHERE lot_id = $1', [lotId]);
  await query('DELETE FROM api_rate_limits WHERE user_id = $1', [ownerId]);
  await query('DELETE FROM auth_audit WHERE actor_id = $1', [ownerId]);
  await query('DELETE FROM auth_sessions WHERE user_id = $1', [ownerId]);
  await query('DELETE FROM users WHERE id = $1', [ownerId]);
  await pool.end();
});

test('reopening the same workbook after every chunk boundary resumes without duplicates', async () => {
  const wb = newBook('Interrupted import');
  const ws = wb.addWorksheet(IMPORT_SHEET);
  ws.columns = TEMPLATE_COLUMNS.map((c) => ({ header: c.header, key: c.key }));
  for (let i = 0; i < 1001; i++) ws.addRow({
    direction: 'IN', lot_id: lotId, quality: 'Resume', design: 'Test', finished_meters: 1, mill_name: 'Test',
  });
  const bytes = new Uint8Array(await toBuffer(wb));
  const validate = async () => {
    const form = new FormData();
    form.append('file', new File([bytes], 'resume.xlsx'));
    const response = await validateStockImport(new NextRequest('http://localhost/api/stock/import', {
      method: 'POST', headers: { cookie: ownerCookie }, body: form,
    }));
    assert.equal(response.status, 200);
    const data = await response.json() as ValidateResult;
    assert.equal(data.ok, true);
    return data;
  };
  let checked = await validate();
  const batch = checked.batch;
  let saved = 0;
  while (checked.rows!.length) {
    const rows = checked.rows!.slice(0, 500);
    const send = () => commitStockImport(new NextRequest('http://localhost/api/stock/import/commit', {
      method: 'POST', headers: { cookie: ownerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch, rows }),
    }));
    const response = await send();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).saved, rows.length);
    // Replay a lost successful response, then simulate reopening the browser/file.
    const replay = await send();
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).skipped, rows.length);
    saved += rows.length;
    checked = await validate();
    assert.equal(checked.batch, batch);
    assert.equal(checked.alreadySaved, saved);
    assert.equal(checked.rows!.length, 1001 - saved);
  }
  assert.equal(saved, 1001);
  assert.equal(Number((await query('SELECT bal_m FROM lots WHERE lot_id = $1', [lotId])).rows[0].bal_m), 1001);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM stock_movements WHERE lot_id = $1', [lotId])).rows[0].n, 1001);
});

test('malformed commit requests and corrupt XLSX uploads return explicit client errors', async () => {
  const badCommit = await commitStockImport(new NextRequest('http://localhost/api/stock/import/commit', {
    method: 'POST', headers: { cookie: ownerCookie, 'Content-Type': 'application/json' }, body: '{',
  }));
  assert.equal(badCommit.status, 400);
  for (const contents of [new Uint8Array(), new Uint8Array([80, 75, 3, 4, 0, 0])]) {
    const form = new FormData();
    form.append('file', new File([contents], 'broken.xlsx'));
    const response = await validateStockImport(new NextRequest('http://localhost/api/stock/import', {
      method: 'POST', headers: { cookie: ownerCookie }, body: form,
    }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Could not open/);
  }
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
