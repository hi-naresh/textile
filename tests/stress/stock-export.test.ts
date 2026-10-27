import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { after, before, test } from 'node:test';
import ExcelJS from 'exceljs';
import { NextRequest } from 'next/server';
import { GET as stockExport } from '../../src/app/api/stock/export/route';
import { createSession } from '../../src/lib/auth/session';
import pool, { query, withTransaction } from '../../src/lib/db';
import { recordIncoming, recordOutgoing } from '../../src/lib/ledger';
import { ledgerExportRows } from '../../src/lib/ledger-query';
import { lotExportRows } from '../../src/lib/lots-query';
import type { LotRow } from '../../src/lib/lots-query';
import { streamChallanWorkbook } from '../../src/lib/stock-import';
import { streamLotsWorkbook } from '../../src/lib/excel';

const databaseUrl = new URL(process.env.DATABASE_URL || 'postgresql://localhost/invalid');
if (!['localhost', '127.0.0.1', '::1'].includes(databaseUrl.hostname) || !databaseUrl.pathname.endsWith('_test')) {
  throw new Error('Use a disposable local DATABASE_URL ending in _test.');
}
process.env.DB_QUIET = '1';

const fixtureTag = randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
const lotId = `STRESS-EXPORT-${fixtureTag}`;
const relatedLotIds = [`STRESS-${fixtureTag}-B`, `STRESS-${fixtureTag}-C`];
const ownerId = `st-ex-${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const filters = { q: null, direction: null, status: null, quality: null, design: null, lot: lotId, party: null, from: null, to: null };
let ownerCookie = '';

before(async () => {
  await query(`INSERT INTO users (id, name, role) VALUES ($1, 'Stress export owner', 'owner')`, [ownerId]);
  const sessionRequest = new NextRequest('http://localhost/');
  ownerCookie = `tb_at=${(await createSession(query, ownerId, 'client', sessionRequest)).tokens.access}`;
  await withTransaction((q) => recordIncoming(q, {
    lot_id: lotId, quality: 'Stress test', design: 'Synthetic', finished_meters: 100, mill_name: 'Stress test mill',
  }, { requireLotDetails: true }));
  for (const relatedLotId of relatedLotIds) {
    await withTransaction((q) => recordIncoming(q, {
      lot_id: relatedLotId, quality: 'Stress test', design: 'Synthetic', finished_meters: 100, mill_name: 'Stress test mill',
    }, { requireLotDetails: true }));
  }
  await withTransaction((q) => recordOutgoing(q, { lot_id: lotId, meters: 10, party: 'Stress export test' }));
  await withTransaction((q) => recordOutgoing(q, { lot_id: lotId, meters: 5, party: 'Stress export test' }));
});

after(async () => {
  await query('DELETE FROM auth_audit WHERE actor_id = $1', [ownerId]);
  await query('DELETE FROM auth_sessions WHERE user_id = $1', [ownerId]);
  await query('DELETE FROM users WHERE id = $1', [ownerId]);
  const lotIds = [lotId, ...relatedLotIds];
  await query('DELETE FROM lot_locations WHERE lot_id = ANY($1::text[])', [lotIds]);
  await query('DELETE FROM stock_movements WHERE lot_id = ANY($1::text[])', [lotIds]);
  await query('DELETE FROM lots WHERE lot_id = ANY($1::text[])', [lotIds]);
  await pool.end();
});

test('keyset export yields every matching movement in ledger order', async () => {
  const rows = [];
  for await (const row of ledgerExportRows(query, filters, 2)) rows.push(row);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.direction), ['IN', 'OUT', 'OUT']);
  assert.ok(rows.every((row) => row.lot_id === lotId));
  assert.deepEqual(rows.map((row) => row.id), [...rows.map((row) => row.id)].sort((a, b) => a - b));
});

test('streamed challan export is a readable XLSX with all rows', async () => {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const finished = new Promise<void>((resolve, reject) => {
    output.once('end', resolve);
    output.once('error', reject);
  });
  await streamChallanWorkbook('Stress test', output, ledgerExportRows(query, filters, 2));
  await finished;

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.concat(chunks) as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Challans');
  assert.ok(ws);
  assert.equal(ws.rowCount, 4);
  assert.equal(ws.getCell('A2').value, 1);
  assert.equal(ws.getCell('F2').value, lotId);
  assert.equal(ws.getCell('A4').value, 3);
});

test('stock export route streams the filtered challan workbook', async () => {
  const req = new NextRequest(`http://localhost/api/stock/export?kind=challans&lot=${lotId}`, { headers: { cookie: ownerCookie } });
  const response = await stockExport(req);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type') ?? '', /spreadsheetml/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await response.arrayBuffer()) as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Challans');
  assert.ok(ws);
  assert.equal(ws.rowCount, 4);
  assert.equal(ws.getCell('F2').value, lotId);
});

test('lot export uses keyset pages and includes all matching lots', async () => {
  const rows = [];
  for await (const row of lotExportRows(query, {
    q: fixtureTag, status: '', inStock: false, quality: '',
  }, 2)) rows.push(row);
  assert.deepEqual(rows.map((row) => row.lot_id).sort(), [lotId, ...relatedLotIds].sort());
});

test('lot workbook streams formula-like and unicode text as literal strings', async () => {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const finished = new Promise<void>((resolve, reject) => {
    output.once('end', resolve);
    output.once('error', reject);
  });
  const rows: LotRow[] = [{
    lot_id: '=HYPERLINK("https://example.invalid","click")', quality: '+SUM(1,1)', design: 'आकाश 🌿',
    balance: 2, location: '@SUM(1,1)', status: 'active', stock_status: 'packed',
    grade: '', closed_at: null, location_stage: null, location_ts: null, loc_code: null, reg_lot_no: null,
  }];
  async function* inputRows() { yield* rows; }
  await streamLotsWorkbook('Stress test', output, inputRows());
  await finished;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.concat(chunks) as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Lots');
  assert.ok(ws);
  for (const address of ['B2', 'C2', 'D2', 'F2']) {
    assert.equal(ws.getCell(address).type, ExcelJS.ValueType.String);
  }
  assert.equal(ws.getCell('B2').value, rows[0].lot_id);
  assert.equal(ws.getCell('D2').value, 'आकाश 🌿');
});

test('stock export route streams lot balances', async () => {
  const req = new NextRequest(`http://localhost/api/stock/export?kind=lots&q=${encodeURIComponent(lotId)}`, { headers: { cookie: ownerCookie } });
  const response = await stockExport(req);
  assert.equal(response.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await response.arrayBuffer()) as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Lots');
  assert.ok(ws);
  assert.equal(ws.rowCount, 2);
  assert.equal(ws.getCell('B2').value, lotId);
});

test('multiple stock exports complete concurrently without dropping rows', async () => {
  const responses = await Promise.all(Array.from({ length: 10 }, () =>
    stockExport(new NextRequest(
      `http://localhost/api/stock/export?kind=challans&lot=${lotId}`,
      { headers: { cookie: ownerCookie } },
    ))));
  const workbooks = await Promise.all(responses.map(async (response) => {
    assert.equal(response.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await response.arrayBuffer()) as unknown as ArrayBuffer);
    return wb.getWorksheet('Challans');
  }));
  assert.ok(workbooks.every((ws) => ws?.rowCount === 4));
});
