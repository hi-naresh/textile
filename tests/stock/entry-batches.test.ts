import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { createDisposableDatabase } from '../../scripts/stress/disposable-database';
import { calculatedBilledMeters, resolveBilledMeters } from '../../src/lib/registers';
import { entryDateValue } from '../../src/lib/entry-date';
import { EntryDateInput } from '../../src/components/EntryDateInput';
import { LotClosureCard } from '../../src/components/LotClosureCard';
import { fmt } from '../../src/components/ui';

let isolated: Awaited<ReturnType<typeof createDisposableDatabase>>;
let db: typeof import('../../src/lib/db');
let ledger: typeof import('../../src/lib/ledger');
let edit: typeof import('../../src/lib/ledger-edit');
let owner = '', supervisor = '';
let next = 0;
const request = (path: string, body?: unknown, cookie = owner, method = 'POST') => new NextRequest(`http://localhost/api/${path}`, {
  method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
before(async () => {
  isolated = await createDisposableDatabase('entrybatches');
  process.env.DATABASE_URL = isolated.url; process.env.DB_QUIET = '1';
  db = await import('../../src/lib/db'); ledger = await import('../../src/lib/ledger'); edit = await import('../../src/lib/ledger-edit');
  const { createSession } = await import('../../src/lib/auth/session');
  await db.query("INSERT INTO users (id, name, role) VALUES ('batch-owner', 'Batch Owner', 'owner'), ('batch-supervisor', 'Batch Supervisor', 'supervisor')");
  owner = `tb_at=${(await createSession(db.query, 'batch-owner', 'client', request(''))).tokens.access}`;
  supervisor = `tb_at=${(await createSession(db.query, 'batch-supervisor', 'client', request(''))).tokens.access}`;
});
after(async () => { if (db) await db.default.end(); if (isolated) await isolated.cleanup(); });
async function lot(id = `BATCH-${++next}`, extra = {}) {
  await db.withTransaction((q) => ledger.recordIncoming(q, { lot_id: id, quality: 'Cotton', design: 'Plain', finished_meters: 10000, mill_name: 'Test mill', ...extra }, { requireLotDetails: true }));
  return id;
}
async function sale(extra = {}) {
  const lot_id = await lot();
  return db.withTransaction((q) => ledger.recordOutgoing(q, { lot_id, meters: 1433, bill_pct: 98, party: 'Test party', ...extra }));
}
async function values(id: number) { return (await db.query("SELECT meters::float, bill_pct::float, billed_meters::float, to_char(ts, 'YYYY-MM-DD') AS date FROM stock_movements WHERE id = $1", [id])).rows[0]; }

test('#18 server saves two-decimal NQTY, explicit zero/custom wins, absent L stays empty', async () => {
  assert.equal(calculatedBilledMeters(1433, 98), 1404.34);
  assert.equal(calculatedBilledMeters(1999.25, 99), 1979.26);
  assert.equal(calculatedBilledMeters(1.01, 50), 0.51); // exact half-cent rounds up
  for (const [input, expected] of [[{}, 1404.34], [{ meters: 1999.25, bill_pct: 99 }, 1979.26], [{ billed_meters: 1404 }, 1404], [{ billed_meters: 0 }, 0], [{ bill_pct: null }, null]] as const) {
    const out = await sale(input); assert.equal((await values(Number(out.id))).billed_meters, expected);
  }
  assert.equal(resolveBilledMeters(10, 100, 10.1234), 10.1234);
});

test('#18 edits recalculate defaults independent of field order, preserve custom values and audit NQTY', async () => {
  const a = await sale(), b = await sale({ billed_meters: 1400 });
  await db.withTransaction((q) => edit.applyLedgerEdits(q, [
    { target: 'movement', id: Number(a.id), field: 'bill_pct', value: 99 },
    { target: 'movement', id: Number(a.id), field: 'meters', value: 1999.25 },
    { target: 'movement', id: Number(b.id), field: 'bill_pct', value: 99 },
  ], 'batch-owner'));
  assert.equal((await values(Number(a.id))).billed_meters, 1979.26);
  assert.equal((await values(Number(b.id))).billed_meters, 1400);
  await db.withTransaction((q) => edit.applyLedgerEdits(q, [
    { target: 'movement', id: Number(a.id), field: 'billed_meters', value: 1900 },
    { target: 'movement', id: Number(a.id), field: 'bill_pct', value: 98 },
  ], 'batch-owner'));
  assert.equal((await values(Number(a.id))).billed_meters, 1900);
  await db.withTransaction((q) => edit.applyLedgerEdits(q, [{ target: 'movement', id: Number(a.id), field: 'billed_meters', value: null }], 'batch-owner'));
  assert.equal((await values(Number(a.id))).billed_meters, 1959.27);
  assert.ok((await db.query("SELECT id FROM ledger_edits WHERE target_id = $1 AND field = 'billed_meters' AND edited_by = 'batch-owner'", [String(a.id)])).rows.length >= 3);
});

test('#18 dispatch, app template and sales register share the calculation and preserve typed NQTY', async () => {
  const { createDispatch } = await import('../../src/lib/dispatch/dispatches');
  const lot_id = await lot();
  const dispatch = await db.withTransaction((q) => createDispatch(q, { party: 'Test party', lines: [{ lot_id, meters: 1433, bill_pct: 98 }] }, 'batch-owner'));
  assert.equal(Number((await db.query('SELECT billed_meters FROM stock_movements WHERE dispatch_id = $1', [dispatch.id])).rows[0].billed_meters), 1404.34);
  const { newBook, TEMPLATE_COLUMNS, validateImport, commitChunk } = await import('../../src/lib/stock-import');
  const { toBuffer } = await import('../../src/lib/excel');
  const wb = newBook('Batch tests'); const ws = wb.addWorksheet('Stock entries');
  ws.columns = TEMPLATE_COLUMNS.map((c) => ({ header: c.header, key: c.key }));
  ws.addRow({ direction: 'OUT', lot_id, meters: 1999.25, bill_pct: 99, party: 'Test party' });
  const check = await validateImport(db.query, await toBuffer(wb)); assert.equal(check.ok, true, JSON.stringify(check.problems));
  await db.withTransaction((q) => commitChunk(q, check.batch!, check.rows!, 'batch-owner'));
  assert.equal(Number((await db.query('SELECT billed_meters FROM stock_movements WHERE import_ref = $1', [`${check.batch}:2`])).rows[0].billed_meters), 1979.26);
  const { checkOutgoing, commitOutgoingRow } = await import('../../src/lib/register-import');
  const { resolveReview } = await import('../../src/lib/import-status-review');
  const checked = await checkOutgoing(db.query, [
    { row: 2, v: { date: '2026-10-29', bno: 'BATCH-REG-1', lot: lot_id, qty: 1433, l: 98, lots: 'R' } },
    { row: 3, v: { date: '2026-10-29', bno: 'BATCH-REG-2', lot: lot_id, qty: 100, l: 98, nqty: 97.1234, lots: 'R' } },
  ]);
  assert.deepEqual(checked.rows.map((r) => r.billed_meters), [1404.34, 97.1234]);
  for (const row of resolveReview(checked.rows, {})) await db.withTransaction((q) => commitOutgoingRow(q, { ...row }, 'batch-owner', ledger.newLedgerMemo()));
});

test('#18 dry-run backfill corrects SR 6/10-shaped rows only after matching review, with audit and no duplicates', async () => {
  const first = await sale({ sr_no: 6 }), second = await sale({ sr_no: 10, meters: 1999.25, bill_pct: 99 });
  await db.query('UPDATE stock_movements SET billed_meters = NULL WHERE id = ANY($1::int[])', [[first.id, second.id]]);
  const { planBilledBackfill, applyBilledBackfill, billedPlanFingerprint } = await import('../../src/lib/billed-backfill');
  const plan = await planBilledBackfill(db.query);
  assert.deepEqual(plan.map((r) => r.billed_meters), [1404.34, 1979.26]);
  assert.equal((await values(Number(first.id))).billed_meters, null);
  await assert.rejects(db.withTransaction((q) => applyBilledBackfill(q, 'batch-owner', 'stale')), /plan changed/);
  assert.equal(await db.withTransaction((q) => applyBilledBackfill(q, 'batch-owner', billedPlanFingerprint(plan))), 2);
  assert.equal((await values(Number(second.id))).billed_meters, 1979.26);
  assert.deepEqual(await planBilledBackfill(db.query), []);
  assert.equal(await db.withTransaction((q) => applyBilledBackfill(q, 'batch-owner', billedPlanFingerprint([]))), 0);
});

test('#29 lot rows expose all incoming SRs/weavers and both are searchable across paging', async () => {
  const id = await lot('9028', { sr_no: 902801, weaver_name: 'Weaver Acceptance' });
  await lot(id, { sr_no: 902802, weaver_name: 'Second Weaver' });
  const { lotsPage } = await import('../../src/lib/lots-query');
  for (const q of ['902801', 'Acceptance', 'Second Weaver', '9028 Acceptance']) {
    const result = await lotsPage(db.query, { q, status: '', inStock: false, quality: '' }, { limit: 1, cursor: null });
    assert.equal(result.rows[0]?.lot_id, id, q);
    assert.deepEqual(result.rows[0].sr_nos, [902801, 902802]);
    assert.deepEqual(result.rows[0].weavers, ['Second Weaver', 'Weaver Acceptance']);
  }
  const changed = (await db.query("SELECT id FROM stock_movements WHERE lot_id = $1 AND sr_no = 902802", [id])).rows[0].id;
  await db.withTransaction((q) => edit.applyLedgerEdits(q, [{ target: 'movement', id: Number(changed), field: 'weaver_name', value: 'Updated Weaver' }], 'batch-owner'));
  assert.equal((await lotsPage(db.query, { q: 'Updated', status: '', inStock: false, quality: '' }, { limit: 2, cursor: null })).rows[0]?.lot_id, id);
});

test('#23 history supplies closure metadata; owner Reopen restores stock and supervisor is denied', async () => {
  const out = await sale({ meters: 1999.25, entry_status: 'running' });
  await db.withTransaction((q) => ledger.closeLot(q, out.lot_id, { reason: 'manual', by: 'batch-owner', note: 'Completed' }));
  const history = await import('../../src/app/api/lots/location/route');
  const close = await import('../../src/app/api/lots/close/route');
  const response = await history.GET(request(`lots/location?lot_id=${out.lot_id}`, undefined, owner, 'GET'));
  assert.equal(response.status, 200);
  const { lot: closed } = await response.json();
  assert.equal(closed.closed_by_name, 'Batch Owner'); assert.equal(closed.close_note, 'Completed'); assert.equal(closed.adjustment_m, 8000.75);
  const html = renderToStaticMarkup(createElement(LotClosureCard, { lot: closed, canReopen: true, onReopened: () => {}, onError: () => {} }));
  assert.match(html, /Reopen/); assert.match(html, /8,000.75/); assert.match(html, /Batch Owner/);
  assert.equal((await close.POST(request('lots/close', { lot_id: out.lot_id, action: 'reopen' }, supervisor))).status, 403);
  assert.equal((await close.POST(request('lots/close', { lot_id: out.lot_id, action: 'reopen' }))).status, 200);
  assert.equal(Number((await db.query('SELECT bal_m FROM lots WHERE lot_id = $1', [out.lot_id])).rows[0].bal_m), 8000.75);
});

test('#30 keyboard dates normalize and invalid/future dates are clearly refused', () => {
  for (const raw of ['29102026', '29-10-2026', '2026-10-29']) assert.equal(entryDateValue(raw), '2026-10-29');
  assert.equal(entryDateValue('29022024'), '2024-02-29');
  for (const raw of ['31022026', '29022025', '291020', '', '00-10-2026']) assert.throws(() => entryDateValue(raw), /valid date/);
  assert.throws(() => entryDateValue('31-12-9999'), /future/);
  const html = renderToStaticMarkup(createElement(EntryDateInput, { value: '2026-10-29', onChange: () => {} }));
  assert.match(html, /type="text"/); assert.match(html, /29-10-2026/); assert.doesNotMatch(html, /type="date"/);
});

test('#30 manual API and audited edit mode save a keyboard date, reject invalid dates atomically', async () => {
  const { POST } = await import('../../src/app/api/stock/route');
  const { PATCH } = await import('../../src/app/api/stock/edit/route');
  const lot_id = await lot();
  const response = await POST(request('stock', { direction: 'OUT', lot_id, meters: 1433, bill_pct: 98, party: 'Test party', date: '29102026' }));
  assert.equal(response.status, 200);
  const row = (await db.query("SELECT id FROM stock_movements WHERE lot_id = $1 AND direction = 'OUT'", [lot_id])).rows[0];
  assert.equal((await values(Number(row.id))).date, '2026-10-29');
  const change = (date: string) => PATCH(request('stock/edit', { changes: [{ target: 'movement', id: Number(row.id), field: 'date', value: date }] }, owner, 'PATCH'));
  assert.equal((await change('28102026')).status, 200); assert.equal((await values(Number(row.id))).date, '2026-10-28');
  assert.equal((await change('31022026')).status, 422); assert.equal((await values(Number(row.id))).date, '2026-10-28');
  assert.equal((await change('31129999')).status, 422);
});

test('#21 single-entry formatting retains hundredths without forcing trailing zeros', () => {
  assert.equal(fmt(1999.25, 2), '1,999.25'); assert.equal(fmt(1433, 2), '1,433');
});
