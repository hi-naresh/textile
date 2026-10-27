import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { NextRequest } from 'next/server';
import pool, { query, withTransaction } from '../../src/lib/db';
import { createSession } from '../../src/lib/auth/session';
import { can, setAccessOff } from '../../src/lib/access';
import { createJobCard, recordIncoming, recordOutgoing } from '../../src/lib/ledger';
import { applyLedgerEdits } from '../../src/lib/ledger-edit';
import { runSpec } from '../../src/lib/chat/semantic';
import { lotsByIds } from '../../src/lib/lots-query';
import { ledgerPage } from '../../src/lib/ledger-query';
import { LedgerError } from '../../src/lib/ledger-error';
import { createDispatch } from '../../src/lib/dispatch/dispatches';
import { getFirmConfig } from '../../src/lib/settings';
import { PUT as putSettings } from '../../src/app/api/settings/route';
import { GET as getLots } from '../../src/app/api/lots/route';
import { GET as searchLots } from '../../src/app/api/lots/search/route';
import { GET as lotLocation } from '../../src/app/api/lots/location/route';
import { GET as getLedger } from '../../src/app/api/stock/ledger/route';
import { POST as lotClose } from '../../src/app/api/lots/close/route';
import { EditProblems } from '../../src/lib/ledger-edit';
import { applyBackfill, backfillPlanFingerprint, planBackfill } from '../../src/lib/lot-status-backfill';
import { checkOutgoing, commitOutgoingRow } from '../../src/lib/register-import';
import { newLedgerMemo } from '../../src/lib/ledger';
import { search } from '../../src/lib/search';
import { templateById } from '../../src/lib/chat/templates';
import { createOrder } from '../../src/lib/sales/orders';
import { manualAllocate } from '../../src/lib/sales/allocate';
import { GET as getOrderDetail } from '../../src/app/api/orders/[id]/route';
import { freeLotsForQuality, lotStock } from '../../src/lib/stock';

// Explicitly opt into a disposable local DB. Never load the project's .env here.
const url = new URL(process.env.DATABASE_URL || 'postgresql://localhost/invalid');
if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.endsWith('_test')) throw new Error('Use a disposable local DATABASE_URL ending in _test.');
process.env.DB_QUIET = '1';

const id = `st-${randomUUID().slice(0, 8)}`;
const lot = (n: number) => `${id}-L${n}`.toUpperCase();
const party = `Status Test Party ${id}`;
let ownerCookie = '';
let supCookie = '';
let testOrderId: number | null = null;
let overridesBefore: unknown = null;
const get = (cookie: string, path: string) => new NextRequest(`http://localhost${path}`, { headers: { cookie } });
const post = (cookie: string, path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const req = (cookie: string, body: unknown) => new NextRequest('http://localhost/api/settings', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const LOTS = Array.from({ length: 29 }, (_, i) => i + 1);
const balance = async (l: string) => Number((await query('SELECT bal_m FROM lots WHERE lot_id = $1', [l])).rows[0].bal_m);

async function addLot(l: string, meters: number) {
  await withTransaction((q) => recordIncoming(q, { lot_id: l, quality: 'Status Test', design: 'Plain', finished_meters: meters, mill_name: 'Status Test Mill' }, { requireLotDetails: true }));
}

before(async () => {
  overridesBefore = (await query('SELECT access_overrides FROM app_settings WHERE id = 1')).rows[0]?.access_overrides ?? {};
  await query("INSERT INTO users (id, name, role) VALUES ($1, 'Status test owner', 'owner'), ($2, 'Status test supervisor', 'supervisor')", [id, `${id}-s`]);
  for (const n of LOTS) await addLot(lot(n), 1000);
  await query("INSERT INTO workers (id, name, section) VALUES ($1, 'Status Test Folder', 'Folding')", [id]);
  const r = new NextRequest('http://localhost/');
  ownerCookie = `tb_at=${(await createSession(query, id, 'client', r)).tokens.access}`;
  supCookie = `tb_at=${(await createSession(query, `${id}-s`, 'client', r)).tokens.access}`;
});

after(async () => {
  await query('UPDATE app_settings SET access_overrides = $1::jsonb WHERE id = 1', [JSON.stringify(overridesBefore)]);
  setAccessOff({});
  if (testOrderId !== null) {
    await query('DELETE FROM allocations WHERE order_id = $1', [testOrderId]);
    await query('DELETE FROM orders WHERE id = $1', [testOrderId]);
  }
  const lots = LOTS.map(lot);
  await query('DELETE FROM lot_closures WHERE lot_id = ANY($1::text[])', [lots]);
  await query('DELETE FROM ledger_edits WHERE edited_by = $1', [id]);
  await query('DELETE FROM allotments WHERE worker_id = $1', [id]);
  await query('DELETE FROM job_cards WHERE lot_id = ANY($1::text[])', [lots]);
  await query('DELETE FROM workers WHERE id = $1', [id]);
  await query('DELETE FROM lot_locations WHERE lot_id = ANY($1::text[])', [lots]);
  await query('DELETE FROM stock_movements WHERE lot_id = ANY($1::text[])', [lots]);
  await query('DELETE FROM dispatches WHERE created_by = ANY($1::text[]) OR challan_no LIKE $2', [[id, `${id}-s`], `${id}%`.toUpperCase()]);
  await query('DELETE FROM lots WHERE lot_id = ANY($1::text[])', [lots]);
  await query('DELETE FROM parties WHERE name = $1', [party]);
  await query('DELETE FROM auth_audit WHERE actor_id = ANY($1::text[])', [[id, `${id}-s`]]);
  await query('DELETE FROM auth_sessions WHERE user_id = ANY($1::text[])', [[id, `${id}-s`]]);
  await query('DELETE FROM users WHERE id = ANY($1::text[])', [[id, `${id}-s`]]);
  await pool.end();
});

test('#3 outgoing entries default to Running; Packed is refused for sales', async () => {
  const run = await withTransaction((q) => recordOutgoing(q, { lot_id: lot(1), meters: 100, party }));
  assert.equal(run.entry_status, 'running');
  await assert.rejects(withTransaction((q) => recordOutgoing(q, { lot_id: lot(1), meters: 50, party, entry_status: 'Packed' })), /Packed is for incoming/);
  await withTransaction((q) => recordOutgoing(q, { lot_id: lot(1), meters: 50, party }));
  assert.equal(await balance(lot(1)), 850);
});

test('#3 End needs the stock.end permission; bad statuses are refused', async () => {
  await assert.rejects(withTransaction((q) => recordOutgoing(q, { lot_id: lot(2), meters: 10, party, entry_status: 'end' })), (e: unknown) => e instanceof LedgerError && e.status === 403);
  await assert.rejects(withTransaction((q) => recordOutgoing(q, { lot_id: lot(2), meters: 10, party, entry_status: 'shipped' }, { endAllowed: true })), LedgerError);
  const end = await withTransaction((q) => recordOutgoing(q, { lot_id: lot(2), meters: 10, party, entry_status: 'end' }, { endAllowed: true }));
  assert.equal(end.entry_status, 'end');
});

test('#3 incoming status is derived; outgoing statuses cannot be stored on receipts', async () => {
  await assert.rejects(query("INSERT INTO stock_movements (lot_id, direction, meters, entry_status) VALUES ($1, 'IN', 1, 'running')", [lot(3)]));
});

test('#3 Packed filter returns incoming receipts; Running filter returns sales', async () => {
  await withTransaction((q) => recordOutgoing(q, { lot_id: lot(3), meters: 20, party }));
  const page = await ledgerPage(query, { q: null, direction: null, status: 'packed', quality: null, design: null, lot: lot(3), party: null, from: null, to: null }, { limit: 50, cursor: null });
  assert.ok(page.rows.length >= 1);
  assert.ok(page.rows.every((r) => r.direction === 'IN' && r.entry_status === 'packed' && r.lot_id === lot(3)));
  const running = await ledgerPage(query, { q: null, direction: null, status: 'running', quality: null, design: null, lot: lot(3), party: null, from: null, to: null }, { limit: 50, cursor: null });
  assert.equal(running.rows.length, 1);
  assert.equal(running.rows[0].direction, 'OUT');
  assert.equal(running.rows[0].entry_status, 'running');
});

test('#3 dispatch lines carry a status; End is refused without permission', async () => {
  await query("INSERT INTO parties (name) VALUES ($1) ON CONFLICT DO NOTHING", [party]);
  await assert.rejects(withTransaction((q) => createDispatch(q, { party, lines: [{ lot_id: lot(4), meters: 5, entry_status: 'end' }], challan_no: `${id}-D1` }, id)), (e: unknown) => e instanceof LedgerError && e.status === 403);
  const d = await withTransaction((q) => createDispatch(q, { party, lines: [{ lot_id: lot(4), meters: 5, entry_status: 'running' }], challan_no: `${id}-D2` }, id));
  const r = await query('SELECT entry_status FROM stock_movements WHERE dispatch_id = $1', [d.id]);
  assert.deepEqual(r.rows.map((x) => x.entry_status), ['running']);
});

test('#3 owner switches "supervisors can mark End" in settings; supervisors cannot', async () => {
  const off = await putSettings(req(ownerCookie, { supervisor_can_end: false }));
  assert.equal(off.status, 200);
  await getFirmConfig(true);
  assert.equal(can('supervisor', 'stock.end'), false);
  assert.equal(can('owner', 'stock.end'), true);
  const audit = await query("SELECT detail FROM auth_audit WHERE actor_id = $1 AND event = 'access.changed' ORDER BY id DESC LIMIT 1", [id]);
  assert.deepEqual(audit.rows[0].detail, { role: 'supervisor', cap: 'stock.end', on: false, via: 'owner settings' });

  const on = await putSettings(req(ownerCookie, { supervisor_can_end: true }));
  assert.equal(on.status, 200);
  await getFirmConfig(true);
  assert.equal(can('supervisor', 'stock.end'), true);

  const sup = await putSettings(req(supCookie, { supervisor_can_end: false }));
  assert.equal(sup.status, 403);
  const bad = await putSettings(req(ownerCookie, { supervisor_can_end: 'no' }));
  assert.equal(bad.status, 400);
});

// ---------- #4 End closes the lot ----------
const lotRow = async (l: string) => (await query('SELECT status, closed_at, closed_by, close_reason, bal_m, cur_location FROM lots WHERE lot_id = $1', [l])).rows[0];
const closings = async (l: string) => (await query("SELECT direction, meters::float AS meters, to_char(ts, 'YYYY-MM-DD') AS d FROM stock_movements WHERE lot_id = $1 AND kind = 'closing'", [l])).rows;

test('#4 End with meters left over: closing OUT writes them off, lot closed at 0', async () => {
  const end = await withTransaction((q) => recordOutgoing(q, { lot_id: lot(5), meters: 600, party, entry_status: 'end', moved_by: id }, { endAllowed: true }));
  assert.deepEqual(await closings(lot(5)), [{ direction: 'OUT', meters: 400, d: (await query("SELECT to_char(ts, 'YYYY-MM-DD') AS d FROM stock_movements WHERE id = $1", [end.id])).rows[0].d }]);
  const l = await lotRow(lot(5));
  assert.equal(Number(l.bal_m), 0);
  assert.equal(l.status, 'completed');
  assert.equal(l.close_reason, 'end_entry');
  assert.equal(l.closed_by, id);
  assert.ok(l.closed_at);
  assert.equal(l.cur_location, 'Dispatched');
  const h = (await query('SELECT action, reason, adjustment_m::float AS adj, end_movement_id FROM lot_closures WHERE lot_id = $1', [lot(5)])).rows;
  assert.deepEqual(h, [{ action: 'close', reason: 'end_entry', adj: 400, end_movement_id: Number(end.id) }]);
});

test('#4 End beyond the balance: closing IN writes the excess back; exact End needs no adjustment', async () => {
  await withTransaction((q) => recordOutgoing(q, { lot_id: lot(6), meters: 1050, party, entry_status: 'end' }, { endAllowed: true }));
  assert.deepEqual((await closings(lot(6))).map((x) => [x.direction, x.meters]), [['IN', 50]]);
  assert.equal(await balance(lot(6)), 0);
  await withTransaction((q) => recordOutgoing(q, { lot_id: lot(7), meters: 1000, party, entry_status: 'end' }, { endAllowed: true }));
  assert.deepEqual(await closings(lot(7)), []);
  assert.ok((await lotRow(lot(7))).closed_at);
});

test('#4 back-dated End closes the lot on that date', async () => {
  await query("UPDATE stock_movements SET ts = '2026-08-01 12:00' WHERE lot_id = $1 AND direction = 'IN'", [lot(8)]);
  await withTransaction((q) => recordOutgoing(q, { lot_id: lot(8), meters: 300, party, entry_status: 'end', date: '2026-09-01' }, { endAllowed: true }));
  assert.deepEqual((await closings(lot(8))).map((x) => x.d), ['2026-09-01']);
  const l = await lotRow(lot(8));
  assert.equal(new Date(l.closed_at).toLocaleDateString('en-CA'), '2026-09-01');
});

test('#4 a closed lot takes no new entries, job cards or second close', async () => {
  const closed = (e: unknown) => e instanceof LedgerError && e.status === 409;
  await assert.rejects(withTransaction((q) => recordOutgoing(q, { lot_id: lot(5), meters: 1, party })), closed);
  await assert.rejects(withTransaction((q) => recordIncoming(q, { lot_id: lot(5), finished_meters: 10, mill_name: 'Status Test Mill' }, { requireLotDetails: true })), closed);
  await assert.rejects(withTransaction((q) => createJobCard(q, { lot_id: lot(5), process: 'Folding', worker_id: id, meters_in: 10 })), closed);
  await assert.rejects(withTransaction((q) => recordOutgoing(q, { lot_id: lot(5), meters: 1, party, entry_status: 'end' }, { endAllowed: true })), closed);
});

test('#4 closing adjustments are not receipts or dispatches', async () => {
  const owner = { role: 'owner' as const, sections: [] };
  const received = await runSpec({ metric: 'received', filters: { lot: lot(6) }, period: null }, owner);
  assert.equal(received.rows[0]?.value, 1000); // the 50 m written back is not a receipt
  const sent = await runSpec({ metric: 'dispatched', filters: { lot: lot(5) }, period: null }, owner);
  assert.equal(sent.rows[0]?.value, 600); // the 400 m written off is not a sale
});

test('#4 edit mode: closing rows are read-only and a closed lot keeps its status', async () => {
  const mv = (await query("SELECT id FROM stock_movements WHERE lot_id = $1 AND kind = 'closing'", [lot(5)])).rows[0].id;
  await assert.rejects(withTransaction((q) => applyLedgerEdits(q, [{ target: 'movement', id: Number(mv), field: 'source_doc_id', value: 'X1' }], id)), /Closing adjustments/);
  await assert.rejects(withTransaction((q) => applyLedgerEdits(q, [{ target: 'lot', id: lot(5), field: 'status', value: 'active' }], id)), /is closed/);
  const ok = await withTransaction((q) => applyLedgerEdits(q, [{ target: 'lot', id: lot(5), field: 'grade', value: 'B' }], id));
  assert.equal(ok.saved, 1);
});

// ---------- #5 closed lots leave current stock; owner-only Closed view ----------
test('#5 lot lists and pickers leave closed lots out; the owner lists them under Closed', async () => {
  const all = await (await getLots(get(ownerCookie, `/api/lots?q=${encodeURIComponent(id)}&limit=50`))).json();
  assert.ok(!all.rows.some((l: { lot_id: string }) => l.lot_id === lot(5)));
  assert.ok(all.rows.some((l: { lot_id: string }) => l.lot_id === lot(1)));
  const closed = await (await getLots(get(ownerCookie, `/api/lots?closed=1&q=${encodeURIComponent(id)}&limit=50`))).json();
  const l5 = closed.rows.find((l: { lot_id: string }) => l.lot_id === lot(5));
  assert.equal(l5.close_reason, 'end_entry');
  assert.equal(l5.adjustment_m, 400);
  assert.equal(l5.closed_by_name, 'Status test owner');
  assert.ok(closed.rows.every((l: { closed_at: string | null }) => l.closed_at));
  assert.equal((await getLots(get(supCookie, '/api/lots?closed=1'))).status, 403);

  const typeahead = await (await searchLots(get(ownerCookie, `/api/lots/search?q=${encodeURIComponent(lot(5))}`))).json();
  assert.equal(typeahead.lots.length, 0);
  const byIdOwner = await (await searchLots(get(ownerCookie, `/api/lots/search?ids=${lot(5)}`))).json();
  assert.equal(byIdOwner.lots.length, 1);
  const byIdSup = await (await searchLots(get(supCookie, `/api/lots/search?ids=${lot(5)}`))).json();
  assert.equal(byIdSup.lots.length, 0);
  assert.equal((await lotLocation(get(supCookie, `/api/lots/location?lot_id=${lot(5)}`))).status, 404);
  assert.equal((await lotLocation(get(ownerCookie, `/api/lots/location?lot_id=${lot(5)}`))).status, 200);
});

test('#5 supervisors get no rows of closed lots or closing adjustments from the ledger', async () => {
  const owner = await (await getLedger(get(ownerCookie, `/api/stock/ledger?lot=${lot(5)}`))).json();
  assert.ok(owner.rows.some((r: { kind: string }) => r.kind === 'closing'));
  const sup = await (await getLedger(get(supCookie, `/api/stock/ledger?lot=${lot(5)}`))).json();
  assert.deepEqual(sup.rows, []);
  const supOpen = await (await getLedger(get(supCookie, `/api/stock/ledger?lot=${lot(1)}`))).json();
  assert.ok(supOpen.rows.length > 0);
});

test('#6 editing meters on a closed lot recalculates and audits its closing adjustment', async () => {
  const end = await withTransaction((q) => recordOutgoing(q, {
    lot_id: lot(29), meters: 600, party, entry_status: 'end', moved_by: id,
  }, { endAllowed: true }));

  const save = (meters: number) => withTransaction((q) => applyLedgerEdits(
    q, [{ target: 'movement', id: Number(end.id), field: 'meters', value: meters }], id,
  ));
  const edited = await save(650);
  assert.equal(edited.reload, true);
  assert.deepEqual(edited.adjustments, [{ lot_id: lot(29), adjustment_m: 350 }]);
  assert.equal(await balance(lot(29)), 0);
  assert.deepEqual((await closings(lot(29))).map((x) => [x.direction, x.meters]), [['OUT', 350]]);

  const negative = await save(1050);
  assert.deepEqual(negative.adjustments, [{ lot_id: lot(29), adjustment_m: -50 }]);
  assert.equal(await balance(lot(29)), 0);
  assert.deepEqual((await closings(lot(29))).map((x) => [x.direction, x.meters]), [['IN', 50]]);

  const zero = await save(1000);
  assert.deepEqual(zero.adjustments, [{ lot_id: lot(29), adjustment_m: 0 }]);
  assert.equal(await balance(lot(29)), 0);
  assert.deepEqual(await closings(lot(29)), []);

  const audit = await query(
    `SELECT field, old_value, new_value, edited_by FROM ledger_edits
     WHERE target = 'lot' AND target_id = $1 AND field = 'closing_adjustment' ORDER BY id`,
    [lot(29)],
  );
  assert.deepEqual(audit.rows, [
    { field: 'closing_adjustment', old_value: '400', new_value: '350', edited_by: id },
    { field: 'closing_adjustment', old_value: '350', new_value: '-50', edited_by: id },
    { field: 'closing_adjustment', old_value: '-50', new_value: '0', edited_by: id },
  ]);
});

test('#5 search and chat: closed lots are hidden, the owner is told the lot is closed', async () => {
  const lotHit = async (l: string) => (await search(query, { role: 'owner', userId: id }, l)).groups.some((g) => g.hits.some((x) => x.type === 'lot' && x.id === l));
  assert.equal(await lotHit(lot(1)), true); // open lots are found
  assert.equal(await lotHit(lot(5)), false); // closed ones are not
  const t = templateById('lot_status')!;
  assert.match((await t.run({ lot: lot(5) }, { role: 'supervisor', sections: [] })).answer, /No lot/);
  assert.match((await t.run({ lot: lot(5) }, { role: 'owner', sections: [] })).answer, /is closed: closed by its End entry/);
});

test('#5 chat current stock excludes closed lots; supervisors cannot query their history', async () => {
  const closedLot = lot(28);
  const quality = `Closed stock ${id}`;
  await query('UPDATE lots SET quality = $2 WHERE lot_id = $1', [closedLot, quality]);
  await withTransaction((q) => createJobCard(q, { lot_id: closedLot, process: 'Folding', worker_id: id, meters_in: 100 }));
  await query("UPDATE job_cards SET status = 'closed', meters_out = 100, ts_closed = now() WHERE lot_id = $1", [closedLot]);

  const owner = { role: 'owner' as const, sections: [] };
  const supervisor = { role: 'supervisor' as const, sections: ['folding'] };
  await query('INSERT INTO parties (name) VALUES ($1) ON CONFLICT DO NOTHING', [party]);
  const created = await withTransaction((q) => createOrder(q, { party, quality, meters: 100, rate_per_m: 1 }, id));
  testOrderId = created.order.id;
  await withTransaction((q) => manualAllocate(q, created.order.id, closedLot, 10, id));

  const before = await runSpec({ metric: 'stock', filters: { quality }, period: null }, owner);
  assert.equal(before.rows[0]?.value, 1000);
  await query("UPDATE lots SET closed_at = now(), closed_by = $2, close_reason = 'manual', status = 'completed' WHERE lot_id = $1", [closedLot, id]);

  for (const metric of ['stock', 'free_stock'] as const) {
    const result = await runSpec({ metric, filters: { quality }, period: null }, owner);
    assert.equal(result.rows[0]?.value, 0);
  }
  const summary = await templateById('stock_by_quality')!.run({ quality }, owner);
  assert.match(summary.answer, /No stock/);
  assert.deepEqual(await freeLotsForQuality(query, quality), []);
  assert.equal(await lotStock(query, closedLot), null);

  const ownerHistory = await runSpec({ metric: 'output', filters: { lot: closedLot }, period: null }, owner);
  assert.equal(ownerHistory.rows[0]?.value, 100);
  const supervisorHistory = await runSpec({ metric: 'output', filters: { lot: closedLot }, period: null }, supervisor);
  assert.equal(supervisorHistory.rows[0]?.value, 0);
  const supervisorOutput = await runSpec({ metric: 'output', filters: { lot: closedLot }, period: null }, supervisor);
  assert.equal(supervisorOutput.rows[0]?.value, 0);

  const detailRequest = get(ownerCookie, `/api/orders/${created.order.id}`);
  const routeContext = { params: Promise.resolve({ id: String(created.order.id) }) };
  const ownerOrder = await (await getOrderDetail(detailRequest, routeContext)).json();
  assert.ok(ownerOrder.allocations.some((a: { lot_id: string }) => a.lot_id === closedLot));
  const supervisorOrder = await (await getOrderDetail(get(supCookie, `/api/orders/${created.order.id}`), routeContext)).json();
  assert.ok(supervisorOrder.allocations.every((a: { lot_id: string }) => a.lot_id !== closedLot));
});

// ---------- #6 edit status, close by hand, reopen ----------
const edit = (id: number, value: string) => ({ target: 'movement' as const, id, field: 'entry_status' as const, value });

test('#6 changing an entry to End closes the lot; taking End off reopens it', async () => {
  const a = await withTransaction((q) => recordOutgoing(q, { lot_id: lot(10), meters: 100, party }));
  // Legacy Packed sale: existing data remains readable and can be corrected to Running.
  await query("UPDATE stock_movements SET entry_status = 'packed' WHERE id = $1", [a.id]);
  const b = await withTransaction((q) => recordOutgoing(q, { lot_id: lot(10), meters: 200, party }));
  const r1 = await withTransaction((q) => applyLedgerEdits(q, [edit(Number(a.id), 'running'), edit(Number(b.id), 'end')], id, { endAllowed: true }));
  assert.equal(r1.reload, true);
  assert.deepEqual((await closings(lot(10))).map((x) => [x.direction, x.meters]), [['OUT', 700]]);
  assert.ok((await lotRow(lot(10))).closed_at);
  const log = (await query("SELECT target_id, old_value, new_value FROM ledger_edits WHERE field = 'entry_status' AND target_id = ANY($1::text[]) ORDER BY id", [[String(a.id), String(b.id)]])).rows;
  assert.deepEqual(log, [{ target_id: String(a.id), old_value: 'packed', new_value: 'running' }, { target_id: String(b.id), old_value: 'running', new_value: 'end' }]);

  const r2 = await withTransaction((q) => applyLedgerEdits(q, [edit(Number(b.id), 'running')], id, { endAllowed: true }));
  assert.equal(r2.reload, true);
  assert.deepEqual(await closings(lot(10)), []);
  const l = await lotRow(lot(10));
  assert.equal(l.closed_at, null);
  assert.equal(l.status, 'active');
  assert.equal(Number(l.bal_m), 700);
  const hist = (await query('SELECT action FROM lot_closures WHERE lot_id = $1 ORDER BY id', [lot(10)])).rows.map((x) => x.action);
  assert.deepEqual(hist, ['close', 'reopen']);
});

test('#6 status edits that cannot work are refused, nothing saved', async () => {
  const x = await withTransaction((q) => recordOutgoing(q, { lot_id: lot(13), meters: 10, party }));
  const y = await withTransaction((q) => recordOutgoing(q, { lot_id: lot(13), meters: 20, party }));
  await assert.rejects(withTransaction((q) => applyLedgerEdits(q, [edit(Number(x.id), 'end'), edit(Number(y.id), 'end')], id, { endAllowed: true })), /Only one entry can be the End/);
  await assert.rejects(withTransaction((q) => applyLedgerEdits(q, [edit(Number(x.id), 'end')], id, { endAllowed: false })), EditProblems);
  const inRow = (await query("SELECT id FROM stock_movements WHERE lot_id = $1 AND direction = 'IN'", [lot(14)])).rows[0].id;
  await assert.rejects(withTransaction((q) => applyLedgerEdits(q, [edit(Number(inRow), 'running')], id, { endAllowed: true })), /only for outgoing/);
  const closedEnd = (await query("SELECT id FROM stock_movements WHERE lot_id = $1 AND kind = 'normal' AND direction = 'OUT' AND entry_status = 'running' LIMIT 1", [lot(1)])).rows[0].id;
  await withTransaction((q) => applyLedgerEdits(q, [edit(Number(closedEnd), 'end')], id, { endAllowed: true }));
  const other = (await query("SELECT id FROM stock_movements WHERE lot_id = $1 AND direction = 'OUT' AND entry_status = 'running' LIMIT 1", [lot(1)])).rows[0].id;
  await assert.rejects(withTransaction((q) => applyLedgerEdits(q, [edit(Number(other), 'end')], id, { endAllowed: true })), /already closed/);
  assert.equal(await balance(lot(13)), 970);
});

test('#6 owner closes a lot by hand and reopens it; the End entry becomes Running again', async () => {
  const r = await lotClose(post(ownerCookie, '/api/lots/close', { lot_id: lot(11), action: 'close', note: 'Counted: nothing left' }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).adjustment_m, 1000);
  const l = await lotRow(lot(11));
  assert.equal(l.close_reason, 'manual');
  assert.equal((await query('SELECT close_note FROM lots WHERE lot_id = $1', [lot(11)])).rows[0].close_note, 'Counted: nothing left');
  assert.equal((await lotClose(post(supCookie, '/api/lots/close', { lot_id: lot(11), action: 'reopen' }))).status, 403);
  const re = await lotClose(post(ownerCookie, '/api/lots/close', { lot_id: lot(11), action: 'reopen' }));
  assert.equal((await re.json()).balance, 1000);
  assert.equal((await lotRow(lot(11))).closed_at, null);

  const end = await withTransaction((q) => recordOutgoing(q, { lot_id: lot(12), meters: 250, party, entry_status: 'end' }, { endAllowed: true }));
  await lotClose(post(ownerCookie, '/api/lots/close', { lot_id: lot(12), action: 'reopen' }));
  assert.equal((await query('SELECT entry_status FROM stock_movements WHERE id = $1', [end.id])).rows[0].entry_status, 'running');
  const log = (await query("SELECT old_value, new_value, edited_by FROM ledger_edits WHERE target = 'movement' AND target_id = $1", [String(end.id)])).rows;
  assert.deepEqual(log, [{ old_value: 'end', new_value: 'running', edited_by: id }]);
  assert.equal(await balance(lot(12)), 750);
  assert.equal((await lotClose(post(ownerCookie, '/api/lots/close', { lot_id: lot(12), action: 'reopen' }))).status, 409);
});

// ---------- #7 register LOT S codes → statuses; finished lots close ----------
// Rows as the sales-register import saved them before migration 015: a LOT S code, no status.
async function oldRegisterRow(l: string, meters: number, code: string | null, date: string, bill: string) {
  return Number((await query(
    `INSERT INTO stock_movements (lot_id, direction, meters, source_doc_id, import_ref, ts, lot_status_code) VALUES ($1, 'OUT', $2, $3, $4, $5::date + interval '12 hours', $6) RETURNING id`,
    [l, meters, bill, `${'ab'.repeat(10)}:${Math.floor(Math.random() * 1e6)}`, date, code],
  )).rows[0].id);
}
const statusOf = async (mv: number) => (await query('SELECT entry_status FROM stock_movements WHERE id = $1', [mv])).rows[0].entry_status;

test('#7 backfill: dry run lists what would close; apply maps confirmed codes and reviews A', async () => {
  // Register lots came in before they were sold: date their incoming entry earlier than the sales below.
  await query("UPDATE stock_movements SET ts = '2026-07-01 12:00' WHERE lot_id = ANY($1::text[]) AND direction = 'IN'", [[15, 16, 17, 18].map(lot)]);
  const s1 = await oldRegisterRow(lot(15), 300, 'S', '2026-08-01', `${id}-B1`);
  const r1 = await oldRegisterRow(lot(15), 200, 'R', '2026-08-05', `${id}-B2`);
  const e1 = await oldRegisterRow(lot(15), 400, 'E', '2026-08-09', `${id}-B3`);
  const a1 = await oldRegisterRow(lot(16), 1000, 'A', '2026-08-02', `${id}-B4`);
  const e2 = await oldRegisterRow(lot(17), 500, 'E', '2026-08-03', `${id}-B5`);
  const r2 = await oldRegisterRow(lot(17), 100, 'R', '2026-08-07', `${id}-B6`);
  const x1 = await oldRegisterRow(lot(18), 50, 'X', '2026-08-04', `${id}-B7`);

  const plan = await planBackfill(query);
  const mine = new Map(plan.lots.filter((l) => l.lot_id.startsWith(id.toUpperCase())).map((l) => [l.lot_id, l]));
  assert.deepEqual([...mine.keys()].sort(), [lot(15), lot(16), lot(17)]);
  assert.deepEqual({ ...mine.get(lot(15)), why: null }, { ...mine.get(lot(15))!, action: 'close', adjustment: 100, end_movement_id: e1, end_date: '2026-08-09', why: null });
  assert.equal(mine.get(lot(16))!.adjustment, 0);
  assert.equal(mine.get(lot(16))!.action, 'review');
  assert.match(mine.get(lot(16))!.why ?? '', /A is unconfirmed/);
  assert.equal(mine.get(lot(17))!.action, 'review');
  assert.ok(plan.unknown.some((u) => u.code === 'A'));
  assert.equal(await statusOf(s1), null); // dry run wrote nothing
  assert.ok(plan.unknown.some((u) => u.code === 'X'));

  const reviewedFingerprint = backfillPlanFingerprint(plan);
  await assert.rejects(
    withTransaction((q) => applyBackfill(q, id, '0'.repeat(64))),
    /changed after review/,
  );
  assert.equal(await statusOf(s1), null); // a stale / incorrect confirmation also writes nothing
  await withTransaction((q) => applyBackfill(q, id, reviewedFingerprint));
  assert.deepEqual(await Promise.all([s1, r1, e1, a1].map(statusOf)), ['running', 'running', 'end', null]);
  assert.deepEqual(await Promise.all([e2, r2, x1].map(statusOf)), [null, 'running', null]); // lot 17 left for review; X unknown
  const l15 = await lotRow(lot(15));
  assert.equal(l15.close_reason, 'register');
  assert.equal(new Date(l15.closed_at).toLocaleDateString('en-CA'), '2026-08-09');
  assert.deepEqual((await closings(lot(15))).map((x) => [x.direction, x.meters, x.d]), [['OUT', 100, '2026-08-09']]);
  assert.equal((await lotRow(lot(16))).closed_at, null); // A remains open until its meaning is confirmed
  assert.equal((await lotRow(lot(17))).closed_at, null);

  const againPlan = await planBackfill(query);
  const again = await withTransaction((q) => applyBackfill(q, id, backfillPlanFingerprint(againPlan)));
  assert.equal(again.closed.filter((c) => c.lot_id.startsWith(id.toUpperCase())).length, 0);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM lot_closures WHERE lot_id = $1', [lot(15)])).rows[0].n, 1);
});

test('#7 a new sales-register import sets the status from LOT S and closes the lot on E', async () => {
  const row = (n: number, code: string | null, meters: number) => ({ ref: `${'cd'.repeat(10)}:${n}`, date: '2026-10-01', lot_id: lot(19), meters, bill_no: `${id}-R${n}`, lot_status_code: code });
  await withTransaction((q) => commitOutgoingRow(q, row(1, 'S', 300), id, newLedgerMemo()));
  await withTransaction((q) => commitOutgoingRow(q, row(2, null, 100), id, newLedgerMemo()));
  await withTransaction((q) => commitOutgoingRow(q, row(3, 'E', 500), id, newLedgerMemo()));
  const st = (await query("SELECT entry_status FROM stock_movements WHERE lot_id = $1 AND direction = 'OUT' AND kind = 'normal' ORDER BY id", [lot(19)])).rows.map((x) => x.entry_status);
  assert.deepEqual(st, ['running', 'running', 'end']);
  assert.equal((await lotRow(lot(19))).close_reason, 'register');
  assert.equal(await balance(lot(19)), 0);
  await assert.rejects(withTransaction((q) => commitOutgoingRow(q, row(4, 'R', 10), id, newLedgerMemo())), /is closed/);
});

test('#7 a new A-coded sales-register row stays unmapped and does not close its lot', async () => {
  const row = { ref: `${'ef'.repeat(10)}:1`, date: '2026-10-01', lot_id: lot(21), meters: 100, bill_no: `${id}-A1`, lot_status_code: 'A' };
  await withTransaction((q) => commitOutgoingRow(q, row, id, newLedgerMemo()));
  const movement = (await query("SELECT entry_status, lot_status_code FROM stock_movements WHERE lot_id = $1 AND direction = 'OUT' AND kind = 'normal'", [lot(21)])).rows[0];
  assert.deepEqual(movement, { entry_status: null, lot_status_code: 'A' });
  assert.equal((await lotRow(lot(21))).closed_at, null);
  assert.equal(await balance(lot(21)), 900);
});

// ---------- closing by hand marks the last sale End ----------
test('closing a lot by hand marks its last sale End; reopening turns it back to Running', async () => {
  const first = await withTransaction((q) => recordOutgoing(q, { lot_id: lot(20), meters: 300, party, date: '2026-10-10' }));
  // A sale saved before statuses existed: no status.
  const last = Number((await query(`INSERT INTO stock_movements (lot_id, direction, meters, party, ts) VALUES ($1, 'OUT', 800, $2, '2026-10-12 12:00') RETURNING id`, [lot(20), party])).rows[0].id);
  const r = await lotClose(post(ownerCookie, '/api/lots/close', { lot_id: lot(20), action: 'close' }));
  assert.equal((await r.json()).adjustment_m, -100); // 1100 m went out of 1000: 100 m written back
  assert.equal(await statusOf(last), 'end');
  assert.equal(await statusOf(Number(first.id)), 'running'); // only the last sale
  const log = (await query("SELECT old_value, new_value, edited_by FROM ledger_edits WHERE target = 'movement' AND target_id = $1", [String(last)])).rows;
  assert.deepEqual(log, [{ old_value: null, new_value: 'end', edited_by: id }]);
  assert.equal((await query("SELECT end_movement_id FROM lot_closures WHERE lot_id = $1 AND action = 'close'", [lot(20)])).rows[0].end_movement_id, last);
  const closedOn = new Date((await lotRow(lot(20))).closed_at).toLocaleDateString('en-CA');
  assert.equal(closedOn, new Date().toLocaleDateString('en-CA')); // closed today, not on the sale's date

  await lotClose(post(ownerCookie, '/api/lots/close', { lot_id: lot(20), action: 'reopen' }));
  assert.equal(await statusOf(last), null); // back to what it had before the close marked it End
  assert.equal(await balance(lot(20)), -100);
});

test('a lot closed by hand before closing marked a sale End takes End on its sale without closing again', async () => {
  // Lot 20 is open again (previous test reopened it, balance −100). Close it the old way: no End entry recorded.
  await query(`INSERT INTO stock_movements (lot_id, direction, meters, kind) VALUES ($1, 'IN', 100, 'closing')`, [lot(20)]);
  await query(`UPDATE lots SET closed_at = now(), close_reason = 'manual', status = 'completed' WHERE lot_id = $1`, [lot(20)]);
  await query(`INSERT INTO lot_closures (lot_id, action, reason, adjustment_m) VALUES ($1, 'close', 'manual', -100)`, [lot(20)]);
  const sale = Number((await query(`SELECT id FROM stock_movements WHERE lot_id = $1 AND direction = 'OUT' AND kind = 'normal' ORDER BY ts DESC, id DESC LIMIT 1`, [lot(20)])).rows[0].id);
  const before = (await closings(lot(20))).length;
  const r = await withTransaction((q) => applyLedgerEdits(q, [edit(sale, 'end')], id, { endAllowed: true }));
  assert.equal(r.reload, false);
  assert.equal(await statusOf(sale), 'end');
  assert.equal((await closings(lot(20))).length, before); // no second write-off
  assert.equal((await query("SELECT end_movement_id FROM lot_closures WHERE lot_id = $1 AND action = 'close' ORDER BY id DESC LIMIT 1", [lot(20)])).rows[0].end_movement_id, sale);
  // Another sale of the same lot can't also be its End now.
  const other = Number((await query(`SELECT id FROM stock_movements WHERE lot_id = $1 AND direction = 'OUT' AND kind = 'normal' AND id <> $2 LIMIT 1`, [lot(20), sale])).rows[0].id);
  await assert.rejects(withTransaction((q) => applyLedgerEdits(q, [edit(other, 'end')], id, { endAllowed: true })), /closed by another End entry/);
  // Reopen puts back the status it had before it was marked End (none).
  await lotClose(post(ownerCookie, '/api/lots/close', { lot_id: lot(20), action: 'reopen' }));
  assert.equal(await statusOf(sale), null);
});

// ---------- review fixes ----------
test('End on an older entry while later entries exist closes the lot now, not back-dated', async () => {
  await withTransaction((q) => recordOutgoing(q, { lot_id: lot(21), meters: 100, party, entry_status: 'end', date: '2026-09-01' }, { endAllowed: true }));
  const today = new Date().toLocaleDateString('en-CA');
  assert.deepEqual((await closings(lot(21))).map((x) => x.d), [today]); // the lot's IN is dated today, after the End
  assert.equal(new Date((await lotRow(lot(21))).closed_at).toLocaleDateString('en-CA'), today);
});

test('reopen restores what the close changed: the sale\'s status, a lot on hold, no place', async () => {
  await query("UPDATE lots SET status = 'hold' WHERE lot_id = $1", [lot(22)]);
  const sale = await withTransaction((q) => recordOutgoing(q, { lot_id: lot(22), meters: 100, party }));
  await lotClose(post(ownerCookie, '/api/lots/close', { lot_id: lot(22), action: 'close' }));
  assert.equal(await statusOf(Number(sale.id)), 'end');
  assert.equal((await lotRow(lot(22))).cur_location, 'Dispatched');
  await lotClose(post(ownerCookie, '/api/lots/close', { lot_id: lot(22), action: 'reopen' }));
  assert.equal(await statusOf(Number(sale.id)), 'running');
  const l = await lotRow(lot(22));
  assert.equal(l.status, 'hold');
  assert.equal(l.cur_location, null); // it never had a place: not left at "Dispatched" with stock in it
});

test('register import check: closed lots are skipped; an E row followed by more sales keeps the lot open', async () => {
  await lotClose(post(ownerCookie, '/api/lots/close', { lot_id: lot(23), action: 'close' }));
  const raw = [
    { row: 2, v: { date: '2026-10-01', bno: `${id}-X1`, lot: lot(23), lots: 'R', qty: 10 } },
    { row: 3, v: { date: '2026-10-01', bno: `${id}-X2`, lot: lot(24), lots: 'E', qty: 100 } },
    { row: 4, v: { date: '2026-10-02', bno: `${id}-X3`, lot: lot(24), lots: 'R', qty: 50 } },
  ];
  const chk = await checkOutgoing(query, raw);
  assert.ok(chk.warnings.some((w) => w.row === 2 && w.skip && /is closed/.test(w.message)));
  assert.deepEqual(chk.rows.map((r) => [r.row, !!r.keep_open]), [[3, true], [4, false]]);
  for (const r of chk.rows) await withTransaction((q) => commitOutgoingRow(q, r as unknown as Record<string, unknown>, id, newLedgerMemo()));
  const st = (await query("SELECT entry_status FROM stock_movements WHERE lot_id = $1 AND direction = 'OUT' ORDER BY id", [lot(24)])).rows.map((x) => x.entry_status);
  assert.deepEqual(st, ['running', 'running']);
  assert.equal((await lotRow(lot(24))).closed_at, null);
});

test('chat challan lookup: entries of closed lots only for the owner', async () => {
  await withTransaction((q) => recordOutgoing(q, { lot_id: lot(25), meters: 10, party, source_doc: `${id}-CH1`.toUpperCase() }));
  await lotClose(post(ownerCookie, '/api/lots/close', { lot_id: lot(25), action: 'close' }));
  const t = templateById('challan_lookup')!;
  assert.match((await t.run({ challan: `${id}-CH1`.toUpperCase() }, { role: 'supervisor', sections: [] })).answer, /No challan/);
  assert.match((await t.run({ challan: `${id}-CH1`.toUpperCase() }, { role: 'owner', sections: [] })).answer, /dispatched 10 m/);
});


test('receipt → first sale → manual End: zero and negative balances stay Running until End', async () => {
  const stockStatus = async () => (await lotsByIds(query, [lot(26)]))[0].stock_status;
  assert.equal(await stockStatus(), 'packed');
  await withTransaction((q) => recordOutgoing(q, { lot_id: lot(26), meters: 1000, party }));
  assert.equal(await balance(lot(26)), 0);
  assert.equal(await stockStatus(), 'running');
  assert.equal((await lotRow(lot(26))).closed_at, null);
  const sale = await withTransaction((q) => recordOutgoing(q, { lot_id: lot(26), meters: 50, party }));
  assert.equal(await balance(lot(26)), -50);
  assert.equal(await stockStatus(), 'running');
  const open = await (await getLots(get(ownerCookie, `/api/lots?q=${lot(26)}`))).json();
  assert.equal(open.rows.length, 1);
  await withTransaction((q) => applyLedgerEdits(q, [edit(Number(sale.id), 'end')], id, { endAllowed: true }));
  assert.equal(await stockStatus(), 'end');
  assert.equal(await balance(lot(26)), 0);
  for (const cookie of [ownerCookie, supCookie]) {
    const hidden = await (await getLots(get(cookie, `/api/lots?q=${lot(26)}`))).json();
    assert.deepEqual(hidden.rows, []);
  }
  await lotClose(post(ownerCookie, '/api/lots/close', { lot_id: lot(26), action: 'reopen' }));
  assert.equal(await stockStatus(), 'running');
  assert.equal(await balance(lot(26)), -50);
  await addLot(lot(26), 100);
  assert.equal(await stockStatus(), 'running'); // a later receipt does not erase sales history
});

test('opening adjustments do not start a lot; old sales display as Running without rewriting history', async () => {
  await query("INSERT INTO stock_movements (lot_id, direction, meters, kind) VALUES ($1, 'OUT', 10, 'adjustment')", [lot(27)]);
  assert.equal((await lotsByIds(query, [lot(27)]))[0].stock_status, 'packed');
  await query("INSERT INTO stock_movements (lot_id, direction, meters, entry_status) VALUES ($1, 'OUT', 10, NULL), ($1, 'OUT', 10, 'packed')", [lot(27)]);
  assert.equal((await lotsByIds(query, [lot(27)]))[0].stock_status, 'running');
  const f = { q: null, direction: null, status: null, quality: null, design: null, lot: lot(27), party: null, from: null, to: null };
  const page = await ledgerPage(query, f, { limit: 50, cursor: null });
  assert.equal(page.rows.find((r) => r.direction === 'IN')?.entry_status, 'packed');
  assert.equal(page.rows.find((r) => r.kind === 'adjustment')?.entry_status, null);
  assert.deepEqual(page.rows.filter((r) => r.direction === 'OUT' && r.kind === 'normal').map((r) => r.entry_status), ['running', 'running']);
  const sales = await ledgerPage(query, { ...f, status: 'running' }, { limit: 50, cursor: null });
  assert.equal(sales.rows.length, 2);
  await assert.rejects(withTransaction((q) => applyLedgerEdits(q, [edit(sales.rows[0].id, 'packed')], id)), /Packed is for incoming/);
});
