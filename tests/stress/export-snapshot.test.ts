import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import pool, { query, withTransaction } from '../../src/lib/db';
import { openExportSnapshot, snapshotExport, withExportSnapshot } from '../../src/lib/exportSnapshot';
import { recordIncoming, recordOutgoing } from '../../src/lib/ledger';
import { ledgerExportRows, filtersFrom, type LedgerRow } from '../../src/lib/ledger-query';
import { lotExportRows, lotFiltersFrom, type LotRow } from '../../src/lib/lots-query';
import { tallyExportRows, type ExportInvoice } from '../../src/lib/dispatch/tally';
import { NextRequest } from 'next/server';
import ExcelJS from 'exceljs';
import { GET as invoiceExport } from '../../src/app/api/invoices/export/route';
import { GET as reportExport } from '../../src/app/api/reports/export/route';
import { createSession } from '../../src/lib/auth/session';

const url = new URL(process.env.DATABASE_URL || 'postgresql://localhost/invalid');
if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname) || !url.pathname.endsWith('_test')) {
  throw new Error('Use a disposable local DATABASE_URL ending in _test.');
}
process.env.DB_QUIET = '1';
const tag = `SNAP-${randomUUID().slice(0, 8)}`;
const lotIds = [1, 2, 3].map((n) => `${tag}-${n}`);
let partyId: number;
let invoiceIds: number[];
const ownerId = `snapshot-${randomUUID().slice(0, 8)}`;
let cookie: string;

before(async () => {
  await query("INSERT INTO users (id, name, role) VALUES ($1, 'Snapshot owner', 'owner')", [ownerId]);
  cookie = `tb_at=${(await createSession(query, ownerId, 'client', new NextRequest('http://localhost/'))).tokens.access}`;
  for (const lot_id of lotIds) {
    await withTransaction((q) => recordIncoming(q, {
      lot_id, quality: 'Original', design: 'Snapshot', finished_meters: 100, mill_name: tag,
    }, { requireLotDetails: true }));
  }
  await withTransaction((q) => recordOutgoing(q, { lot_id: lotIds[0], meters: 10, party: tag }));
  await withTransaction((q) => recordOutgoing(q, { lot_id: lotIds[0], meters: 5, party: tag }));
  partyId = (await query('INSERT INTO parties (name) VALUES ($1) RETURNING id', [tag])).rows[0].id;
  invoiceIds = (await query(
    `INSERT INTO invoices (invoice_no, party_id, invoice_date, due_date, taxable_amount, total, lines)
     SELECT $1 || '-' || n, $2, '2090-01-01', '2090-01-31', 10, 10, '[]'::jsonb
     FROM generate_series(1, 3) n RETURNING id`, [tag, partyId],
  )).rows.map((r) => Number(r.id));
});
after(async () => {
  await query('DELETE FROM generated_docs WHERE created_by = $1', [ownerId]);
  await query('DELETE FROM api_rate_limits WHERE user_id = $1', [ownerId]);
  await query('DELETE FROM auth_audit WHERE actor_id = $1', [ownerId]);
  await query('DELETE FROM auth_sessions WHERE user_id = $1', [ownerId]);
  await query('DELETE FROM users WHERE id = $1', [ownerId]);
  await query('DELETE FROM invoices WHERE party_id = $1', [partyId]);
  await query('DELETE FROM parties WHERE id = $1', [partyId]);
  await query('DELETE FROM lot_locations WHERE lot_id = ANY($1::text[])', [lotIds]);
  await query('DELETE FROM stock_movements WHERE lot_id = ANY($1::text[])', [lotIds]);
  await query('DELETE FROM lots WHERE lot_id = ANY($1::text[])', [lotIds]);
  await pool.end();
});

test('invoice XLSX and XML routes stream complete files and commit tracking', async () => {
  for (const format of ['xlsx', 'xml']) {
    const response = await invoiceExport(new NextRequest(`http://localhost/api/invoices/export?format=${format}&from=2090-01-01&to=2090-01-01`, { headers: { cookie } }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Invoice-Count'), '3');
    if (format === 'xml') {
      const xml = await response.text();
      assert.equal((xml.match(/<VOUCHER VCHTYPE/g) ?? []).length, 3);
      assert.ok(xml.endsWith('</ENVELOPE>\n'));
    } else {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(await response.arrayBuffer()) as unknown as ArrayBuffer);
      assert.equal(wb.getWorksheet('Sales vouchers')!.rowCount, 5);
    }
  }
  assert.ok((await query('SELECT exported_at FROM invoices WHERE party_id = $1', [partyId])).rows.every((r) => r.exported_at));
  await query('UPDATE invoices SET exported_at = NULL WHERE party_id = $1', [partyId]);
});

test('report route exports a readable workbook from its shared snapshot', async () => {
  const response = await reportExport(new NextRequest('http://localhost/api/reports/export?period=day&date=2026-10-27', { headers: { cookie } }));
  assert.equal(response.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await response.arrayBuffer()) as unknown as ArrayBuffer);
  assert.ok(wb.getWorksheet('Stock'));
  assert.ok(wb.getWorksheet('Summary'));
});

test('a swallowed SQL error cannot turn a rolled-back transaction into a successful download', async () => {
  const { body, completion } = await snapshotExport(new AbortController().signal, async (q) => ({
    metadata: null,
    write: async (out) => { out.write('file'); },
    complete: async () => {
      await q('UPDATE invoices SET exported_at = NOW() WHERE id = $1', [invoiceIds[0]]);
      await q('SELECT 1 / 0').catch(() => {});
    },
  }), false);
  await Promise.all([
    assert.rejects(new Response(body).text(), /rolled back/),
    assert.rejects(completion, /rolled back/),
  ]);
  assert.equal((await query('SELECT exported_at FROM invoices WHERE id = $1', [invoiceIds[0]])).rows[0].exported_at, null);
});

test('challan snapshot preserves later pages after movement edits/deletes and related lot edits', async () => {
  const f = filtersFrom(new URLSearchParams({ lot: lotIds[0] }));
  const expected: LedgerRow[] = [];
  for await (const row of ledgerExportRows(query, f, 1)) expected.push(row);
  await withExportSnapshot(async (q) => {
    const rows = ledgerExportRows(q, f, 1);
    const actual = [(await rows.next()).value];
    await query('UPDATE stock_movements SET meters = 12 WHERE id = $1', [expected[1].id]);
    await query('DELETE FROM stock_movements WHERE id = $1', [expected[2].id]);
    await query("UPDATE lots SET quality = 'Changed' WHERE lot_id = $1", [lotIds[0]]);
    for await (const row of rows) actual.push(row);
    assert.deepEqual(actual, expected);
  });
});

test('lot snapshot keeps deleted lots and original balances across pages', async () => {
  const f = lotFiltersFrom(new URLSearchParams({ q: tag }));
  const expected: LotRow[] = [];
  for await (const row of lotExportRows(query, f, 1)) expected.push(row);
  await withExportSnapshot(async (q) => {
    const rows = lotExportRows(q, f, 1);
    const actual = [(await rows.next()).value];
    const deleted = expected[1].lot_id;
    await query('DELETE FROM lot_locations WHERE lot_id = $1', [deleted]);
    await query('DELETE FROM stock_movements WHERE lot_id = $1', [deleted]);
    await query('DELETE FROM lots WHERE lot_id = $1', [deleted]);
    await query("UPDATE lots SET quality = 'Edited later' WHERE lot_id = $1", [expected[2].lot_id]);
    for await (const row of rows) actual.push(row);
    assert.deepEqual(actual, expected);
  });
});

test('invoice snapshot preserves order, deleted rows and joined party data', async () => {
  const high = Math.max(...invoiceIds);
  const expected: ExportInvoice[] = [];
  for await (const row of tallyExportRows(query, '2090-01-01', '2090-01-01', high, 1)) expected.push(row);
  await withExportSnapshot(async (q) => {
    const rows = tallyExportRows(q, '2090-01-01', '2090-01-01', high, 1);
    const actual = [(await rows.next()).value];
    await query("UPDATE invoices SET invoice_date = '2091-01-01' WHERE id = $1", [invoiceIds[1]]);
    await query('DELETE FROM invoices WHERE id = $1', [invoiceIds[2]]);
    await query('UPDATE parties SET name = $1 WHERE id = $2', [`${tag} changed`, partyId]);
    for await (const row of rows) actual.push(row);
    assert.deepEqual(actual, expected);
  });
});

test('invoice marker conflict aborts download and rolls back earlier markers', async () => {
  const { body, completion } = await snapshotExport(new AbortController().signal, async (q) => {
    await q('SELECT id FROM invoices WHERE id = ANY($1::int[])', [invoiceIds]);
    await query('UPDATE invoices SET total = 11 WHERE id = $1', [invoiceIds[1]]);
    return {
      metadata: null,
      write: async (out) => { out.write('partial export'); },
      complete: async () => {
        await q('UPDATE invoices SET exported_at = NOW() WHERE id = $1', [invoiceIds[0]]);
        await q('UPDATE invoices SET exported_at = NOW() WHERE id = $1', [invoiceIds[1]]);
      },
    };
  }, false);
  await Promise.all([
    assert.rejects(new Response(body).text()),
    assert.rejects(completion, (error: unknown) => (error as { code: string }).code === '40001'),
  ]);
  assert.ok((await query('SELECT exported_at FROM invoices WHERE party_id = $1', [partyId])).rows.every((r) => r.exported_at === null));
});

test('successful streamed export commits markers before response completion and releases connection', async () => {
  const { body, completion } = await snapshotExport(new AbortController().signal, async (q) => ({
    metadata: null,
    write: async (out) => { out.write('complete export'); },
    complete: async () => { await q('UPDATE invoices SET exported_at = NOW() WHERE id = $1', [invoiceIds[0]]); },
  }), false);
  assert.equal(await new Response(body).text(), 'complete export');
  await completion;
  assert.ok((await query('SELECT exported_at FROM invoices WHERE id = $1', [invoiceIds[0]])).rows[0].exported_at);
  assert.equal(pool.totalCount, pool.idleCount);
});

test('preparation and writer failures release snapshot connections', async () => {
  await assert.rejects(snapshotExport(new AbortController().signal, async (q) => {
    await q('SELECT 1');
    throw new Error('prepare failed');
  }), /prepare failed/);
  const { body, completion } = await snapshotExport(new AbortController().signal, async () => ({
    metadata: null,
    write: async () => { throw new Error('writer failed'); },
  }));
  await Promise.all([assert.rejects(new Response(body).text(), /writer failed/), assert.rejects(completion, /writer failed/)]);
  assert.equal(pool.totalCount, pool.idleCount);
});

for (const cancellation of ['request', 'reader'] as const) {
  test(`${cancellation} cancellation interrupts a backpressured writer and releases its connection`, async () => {
    const controller = new AbortController();
    const { body, completion } = await snapshotExport(controller.signal, async (q) => {
      await q('SELECT 1');
      return {
        metadata: null,
        write: async (out) => {
          while (true) {
            if (!out.write(Buffer.alloc(64 * 1024))) await once(out, 'drain');
          }
        },
      };
    });
    const reader = body.getReader();
    await reader.read();
    if (cancellation === 'request') controller.abort(new Error('Request stopped'));
    else await reader.cancel();
    await assert.rejects(completion);
    assert.equal(pool.totalCount, pool.idleCount);
  });
}

test('read-only snapshots reject accidental writes and a pre-aborted request uses no connection', async () => {
  const snapshot = await openExportSnapshot();
  try {
    await assert.rejects(snapshot.q('UPDATE invoices SET total = total WHERE id = $1', [invoiceIds[0]]),
      (error: unknown) => (error as { code: string }).code === '25006');
  } finally { snapshot.abort(); }
  await assert.rejects(openExportSnapshot(AbortSignal.abort()));
  assert.equal(pool.totalCount, pool.idleCount);
});

test('database disconnect during a slow download aborts the writer and releases its slot', { timeout: 10000 }, async () => {
  let pid = 0;
  const { body, completion } = await snapshotExport(new AbortController().signal, async (q) => {
    pid = Number((await q('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    return { metadata: null, write: async (out) => {
      while (true) if (!out.write(Buffer.alloc(64 * 1024))) await once(out, 'drain');
    } };
  });
  const reader = body.getReader();
  await reader.read();
  assert.equal((await query('SELECT pg_terminate_backend($1) AS killed', [pid])).rows[0].killed, true);
  await assert.rejects(completion);
  await assert.rejects(async () => { while (!(await reader.read()).done) { /* consume until the stream error */ } });
  assert.equal(pool.totalCount, pool.idleCount);
});
