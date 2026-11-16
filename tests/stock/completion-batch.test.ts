import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { NextRequest } from 'next/server';
import { createDisposableDatabase } from '../../scripts/stress/disposable-database';
import { parseSr } from '../../src/lib/sr-series';

let isolated: Awaited<ReturnType<typeof createDisposableDatabase>>;
let db: typeof import('../../src/lib/db');
let ledger: typeof import('../../src/lib/ledger');
let owner = '', supervisor = '';
const req = (path: string, body?: unknown, cookie = owner) => new NextRequest(`http://localhost/api/${path}`, {
  method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
before(async () => {
  isolated = await createDisposableDatabase('completion');
  process.env.DATABASE_URL = isolated.url; process.env.DB_QUIET = '1';
  db = await import('../../src/lib/db'); ledger = await import('../../src/lib/ledger');
  await db.query("INSERT INTO users (id, name, role) VALUES ('completion-owner', 'Owner', 'owner'), ('completion-supervisor', 'Supervisor', 'supervisor')");
  const { createSession } = await import('../../src/lib/auth/session');
  owner = `tb_at=${(await createSession(db.query, 'completion-owner', 'client', req(''))).tokens.access}`;
  supervisor = `tb_at=${(await createSession(db.query, 'completion-supervisor', 'client', req(''))).tokens.access}`;
  await db.query("INSERT INTO sr_series (prefix, name) VALUES ('RS', 'RS godown'), ('RR', 'RR godown')");
});
after(async () => { if (db) await db.default.end(); if (isolated) await isolated.cleanup(); });
async function incoming(id: string, extra = {}) {
  return db.withTransaction(q => ledger.recordIncoming(q, { lot_id: id, quality: 'Completion Cotton', design: 'Plain', finished_meters: 100, mill_name: 'Completion mill', ...extra }, { requireLotDetails: true }));
}

test('#17 parsing, per-direction counters, same number in different series and duplicate refusal', async () => {
  assert.deepEqual(parseSr('rs 104'), { number: 104, series: 'RS' });
  assert.throws(() => parseSr('RS-104', 'RR'), /match/);
  for (const bad of ['RS-0', 'RS--4', 'RS-9999999999', '3E2', 'RS-1.5']) assert.throws(() => parseSr(bad));
  await incoming('SERIES-MAIN', { sr_no: 104 }); await incoming('SERIES-RS', { sr_no: 'rs 104' });
  assert.equal((await ledger.nextSr(db.query, 'IN', 'RS')).next, 105);
  assert.equal((await ledger.nextSr(db.query, 'OUT', 'RS')).next, 1);
  assert.equal((await ledger.nextSr(db.query, 'IN')).next, 105);
  await assert.rejects(incoming('SERIES-DUP', { sr_no: 'RS-104' }), /Next free number: RS-105/);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM lots WHERE lot_id = 'SERIES-DUP'")).rows[0].n, 0);
  const { GET } = await import('../../src/app/api/stock/next-sr/route');
  const next = await (await GET(req('stock/next-sr?direction=IN&series=RS&sr=104'))).json();
  assert.equal(next.next_label, 'RS-105'); assert.equal(next.taken.lot_id, 'SERIES-RS');
});

test('#17 owner-managed series deny supervisor changes; inactive prefixes cannot be used', async () => {
  const { POST, GET } = await import('../../src/app/api/stock/series/route');
  assert.equal((await POST(req('stock/series', { prefix: 'XY', name: 'Test' }, supervisor))).status, 403);
  assert.equal((await GET(req('stock/series', undefined, supervisor))).status, 403);
  assert.equal((await POST(req('stock/series', { prefix: '', name: 'Main', active: false }))).status, 400);
  assert.equal((await POST(req('stock/series', { prefix: 'XY', name: 'Test' }))).status, 200);
  assert.equal((await POST(req('stock/series', { prefix: 'XY', name: 'Test', active: false }))).status, 200);
  await assert.rejects(incoming('SERIES-OFF', { sr_no: 'XY-1' }), /not active/);
});

test('#17 SR edits swap series atomically, preserve numbers and refuse collisions', async () => {
  const a = await incoming('EDIT-RS', { sr_no: 'RS-110' }), b = await incoming('EDIT-RR', { sr_no: 'RR-110' });
  const { applyLedgerEdits } = await import('../../src/lib/ledger-edit');
  const edit = (id: number, value: string) => ({ target: 'movement' as const, id, field: 'sr_no' as const, value });
  await assert.rejects(db.withTransaction(q => applyLedgerEdits(q, [edit(Number(a.id), 'RR-110')], 'completion-owner')), /already used/);
  await db.withTransaction(q => applyLedgerEdits(q, [edit(Number(a.id), 'RR-110'), edit(Number(b.id), 'RS-110')], 'completion-owner'));
  const rows = (await db.query('SELECT sr_no, sr_series FROM stock_movements WHERE id = ANY($1::int[]) ORDER BY id', [[a.id, b.id]])).rows;
  assert.deepEqual(rows, [{ sr_no: 110, sr_series: 'RR' }, { sr_no: 110, sr_series: 'RS' }]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM ledger_edits WHERE field = 'sr_series'")).rows[0].n, 2);
});

test('#17 search, ledger, Excel and dispatch documents retain the prefix', async () => {
  const { search } = await import('../../src/lib/search');
  const found = await search(db.query, { role: 'owner', userId: 'completion-owner' }, 'RS-104');
  assert.ok(JSON.stringify(found).includes('SR RS-104'));
  assert.ok(!JSON.stringify(found).includes('SERIES-MAIN'));
  const { ledgerPage } = await import('../../src/lib/ledger-query');
  const filters = { q: 'RS-104', direction: null, status: null, quality: null, design: null, lot: null, party: null, from: null, to: null };
  assert.deepEqual((await ledgerPage(db.query, { ...filters, q: 'RS-9999999999' }, { limit: 50, cursor: null })).rows, []);
  const page = await ledgerPage(db.query, filters, { limit: 50, cursor: null });
  assert.equal(page.rows.length, 1); assert.equal(page.rows[0].sr_series, 'RS');
  const { newBook, challanSheet } = await import('../../src/lib/stock-import');
  const wb = newBook('Series'); challanSheet(wb, page.rows);
  assert.ok(JSON.stringify(wb.worksheets[0].getSheetValues()).includes('RS-104'));
  const { createDispatch, getDispatch } = await import('../../src/lib/dispatch/dispatches');
  const d = await db.withTransaction(q => createDispatch(q, { party: 'Completion buyer', lines: [{ lot_id: 'SERIES-RS', meters: 2, sr_no: 'RS-104' }] }, 'completion-owner'));
  const detail = await getDispatch(db.query, d.id, true);
  assert.equal(detail.lines[0].sr_series, 'RS'); assert.equal(detail.lines[0].sr_no, 104);
  const { PDFDocument, PDFRawStream, decodePDFRawStream } = await import('pdf-lib');
  for (const kind of ['challan', 'packing-list']) {
    const route = kind === 'challan' ? await import('../../src/app/api/docs/challan/route') : await import('../../src/app/api/docs/packing-list/route');
    const response = await route.GET(req(`docs/${kind}?dispatch_id=${d.id}`)); assert.equal(response.status, 200);
    const pdf = await PDFDocument.load(await response.arrayBuffer());
    const text = pdf.context.enumerateIndirectObjects().flatMap(([, obj]) => {
      if (!(obj instanceof PDFRawStream)) return [];
      return [...Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1').matchAll(/<([0-9a-f]+)>\s*Tj/gi)].map(m => Buffer.from(m[1], 'hex').toString('latin1'));
    }).join(' ');
    assert.match(text, /RS-104/);
  }
});

test('#17 app template and register imports distinguish Main and prefixed SRs', async () => {
  const { newBook, TEMPLATE_COLUMNS, validateImport, commitChunk } = await import('../../src/lib/stock-import');
  const { toBuffer } = await import('../../src/lib/excel');
  const wb = newBook('Series'); const ws = wb.addWorksheet('Stock entries'); ws.columns = TEMPLATE_COLUMNS.map(c => ({ header: c.header, key: c.key }));
  ws.addRow({ direction: 'IN', sr_no: 'RS-120', lot_id: 'TEMPLATE-RS', quality: 'Completion Cotton', design: 'Plain', finished_meters: 100, mill_name: 'Completion mill' });
  const chk = await validateImport(db.query, await toBuffer(wb)); assert.equal(chk.ok, true, JSON.stringify(chk.problems));
  await db.withTransaction(q => commitChunk(q, chk.batch!, chk.rows!, 'completion-owner'));
  assert.equal((await db.query("SELECT sr_series FROM stock_movements WHERE lot_id = 'TEMPLATE-RS'")).rows[0].sr_series, 'RS');
  const { checkIncoming, checkOutgoing, commitIncomingRow } = await import('../../src/lib/register-import');
  const raw = [{ row: 2, v: { date: '2026-11-01', sr: 'RS-130', lot: 'REG-RS', mtr: 100, item: 'Completion Cotton' } }];
  const inc = await checkIncoming(db.query, raw, false); assert.deepEqual(inc.errors, []); assert.equal(inc.rows[0].sr_series, 'RS');
  await db.withTransaction(q => commitIncomingRow(q, { ...inc.rows[0] }, 'completion-owner', ledger.newLedgerMemo()));
  const repeated = await checkIncoming(db.query, [{ ...raw[0], v: { ...raw[0].v, sr: 'rs 130' } }], false);
  assert.equal(repeated.rows.length, 0); // normalized identity prevents a duplicate import
  const out = await checkOutgoing(db.query, [
    { row: 2, v: { date: '2026-11-02', sr: 'RS-104', bno: 'SR-LINK-RS', qty: 5, lots: 'R' } },
    { row: 3, v: { date: '2026-11-02', sr: '104', bno: 'SR-LINK-MAIN', qty: 5, lots: 'R' } },
  ]);
  assert.deepEqual(out.errors, []); assert.deepEqual(out.rows.map(r => r.lot_id), ['SERIES-RS', 'SERIES-MAIN']);
});

test('#15 all filtered buckets reconcile, explicit status wins and ended balances stay in Other with alerts', async () => {
  const { stockBreakdown, lotsPage } = await import('../../src/lib/lots-query');
  for (const suffix of ['PACKED', 'RUNNING', 'HOLD', 'END', 'OTHER']) await incoming(`STATUS-${suffix}`, { quality: 'Status isolated', design: 'Stripe' });
  await db.withTransaction(q => ledger.recordOutgoing(q, { lot_id: 'STATUS-RUNNING', meters: 10, party: 'Filter buyer' }));
  await db.withTransaction(q => ledger.recordOutgoing(q, { lot_id: 'STATUS-END', meters: 20, party: 'Filter buyer' }));
  await db.query("UPDATE lots SET status = 'hold' WHERE lot_id = 'STATUS-HOLD'");
  await db.query("UPDATE lots SET closed_at = now(), status = 'completed' WHERE lot_id = 'STATUS-END'"); // intentionally inconsistent historical fixture
  await db.query("UPDATE lots SET status = 'completed' WHERE lot_id = 'STATUS-OTHER'");
  const base = { q: '', status: '', inStock: false, quality: 'Status isolated' };
  for (const extra of [{}, { design: 'Stripe' }, { party: 'Filter buyer' }, { design: 'Stripe', party: 'Filter buyer' }, { quality: 'Nothing' }]) {
    const s = await stockBreakdown(db.query, { ...base, ...extra });
    assert.equal(s.on_hand_m, s.packed_m + s.running_m + s.on_hold_m + s.other_m);
  }
  const s = await stockBreakdown(db.query, base);
  assert.deepEqual([s.on_hand_m, s.packed_m, s.running_m, s.on_hold_m, s.other_m, s.ended_balance_count], [470, 100, 90, 100, 180, 1]);
  assert.equal(s.ended_balances[0].lot_id, 'STATUS-END');
  const shown = await lotsPage(db.query, base, { limit: 50, cursor: null }); assert.ok(!shown.rows.some(l => l.lot_id === 'STATUS-END'));
  const ended = await lotsPage(db.query, { ...base, closed: true }, { limit: 50, cursor: null }); assert.equal(ended.rows[0].lot_id, 'STATUS-END');
  const filtered = await stockBreakdown(db.query, { ...base, party: 'Filter buyer' }); assert.equal(filtered.on_hand_m, 170);
  const { templateById } = await import('../../src/lib/chat/templates');
  const chat = await templateById('stock_summary')!.run({ quality: 'Status isolated', design: 'Stripe', party: 'Filter buyer' }, { role: 'owner', sections: [] });
  assert.match(chat.answer, /170/); assert.match(chat.answer, /ended/i);
  const { runSpec } = await import('../../src/lib/chat/semantic');
  const semantic = await runSpec({ metric: 'stock', groupBy: 'status', filters: { quality: 'Status isolated', party: 'Filter buyer' }, period: null, top: null }, { role: 'owner', sections: [] });
  assert.equal(semantic.rows.reduce((n, r) => n + Number(r.value), 0), 170);
  const { GET } = await import('../../src/app/api/inventory/route');
  assert.equal((await GET(req('inventory', undefined, supervisor))).status, 403);
  const inv = await (await GET(req('inventory?quality=Status%20isolated&party=Filter%20buyer'))).json(); assert.equal(inv.stock.on_hand_m, 170);
});


test('#17 concurrent saves cannot claim the same number within a series', async () => {
  const { POST } = await import('../../src/app/api/stock/route');
  await db.query("INSERT INTO qualities (name) VALUES ('Completion Cotton')");
  const responses = await Promise.all(['RACE-A', 'RACE-B'].map(lot_id => POST(req('stock', { direction: 'IN', lot_id, sr_no: 'RS-500', quality: 'Completion Cotton', design: 'Plain', finished_meters: 10, mill_name: 'Completion mill' }))));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM stock_movements WHERE sr_series = 'RS' AND sr_no = 500 AND direction = 'IN'")).rows[0].n, 1);
});

test('#7 A remains unmapped; explicit choices are preserved in the historical preview', async () => {
  await incoming('BACKFILL-A');
  await db.query("INSERT INTO stock_movements (lot_id, direction, meters, lot_status_code, entry_status) VALUES ('BACKFILL-A', 'OUT', 1, 'A', NULL), ('BACKFILL-A', 'OUT', 1, 'E', 'running')");
  const { planBackfill } = await import('../../src/lib/lot-status-backfill');
  const plan = await planBackfill(db.query);
  assert.deepEqual(plan.statuses, []); assert.deepEqual(plan.unknown, [{ code: 'A', rows: 1 }]);
  assert.ok(!plan.lots.some(l => l.action === 'close'));
  assert.equal((await db.query("SELECT entry_status FROM stock_movements WHERE lot_id = 'BACKFILL-A' AND lot_status_code = 'E'")).rows[0].entry_status, 'running');
});
