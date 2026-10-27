// Quality catalog, several / lettered pipes, location filter, stock components (summary cards), final meters at End.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { NextRequest } from 'next/server';
import pool, { query, withTransaction } from '../../src/lib/db';
import { createSession } from '../../src/lib/auth/session';
import { checkPipe, describePlace, formatMarketLocation, parseMarketLocation } from '../../src/lib/location';
import { recordIncoming, recordOutgoing } from '../../src/lib/ledger';
import { ledgerSummary, ledgerPage, type LedgerFilters } from '../../src/lib/ledger-query';
import { lotsPage, lotsSummary } from '../../src/lib/lots-query';
import { applyLedgerEdits } from '../../src/lib/ledger-edit';
import { POST as postStock } from '../../src/app/api/stock/route';
import { GET as getQualities, POST as postQuality, PATCH as patchQuality } from '../../src/app/api/qualities/route';
import { GET as getPipes } from '../../src/app/api/markets/pipes/route';
import { GET as getShortage } from '../../src/app/api/lots/shortage/route';
import { POST as lotClose } from '../../src/app/api/lots/close/route';

const url = new URL(process.env.DATABASE_URL || 'postgresql://localhost/invalid');
if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.endsWith('_test')) throw new Error('Use a disposable local DATABASE_URL ending in _test.');
process.env.DB_QUIET = '1';

const id = `qc-${randomUUID().slice(0, 8)}`;
const lot = (n: number) => `${id}-L${n}`.toUpperCase();
const LOTS = [1, 2, 3, 4, 5, 6, 7].map(lot);
const Q1 = `Rayon ${id}`;
const Q2 = `Cotton ${id}`;
const code = `T${id.slice(3, 7).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`.slice(0, 6);
const party = `QC Party ${id}`;
let marketId = 0;
let cookie = '';
const send = (method: string, path: string, body?: unknown) => new NextRequest(`http://localhost${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const F = (x: Partial<LedgerFilters>): LedgerFilters => ({ q: null, direction: null, status: null, quality: null, design: null, lot: null, party: null, from: null, to: null, ...x });
const mk = [{ id: 1, name: 'Landmark', code: 'LM', active: true }];

before(async () => {
  await query("INSERT INTO users (id, name, role) VALUES ($1, 'QC owner', 'owner')", [id]);
  marketId = Number((await query(`INSERT INTO markets (name, code) VALUES ($1, $2) RETURNING id`, [`QC Market ${id}`, code])).rows[0].id);
  await query(`INSERT INTO market_shops (market_id, shop_no) VALUES ($1, '245'), ($1, '12A')`, [marketId]);
  await query(`INSERT INTO qualities (name) VALUES ($1)`, [Q1]);
  cookie = `tb_at=${(await createSession(query, id, 'client', new NextRequest('http://localhost/'))).tokens.access}`;
});

after(async () => {
  await query('DELETE FROM lot_closures WHERE lot_id = ANY($1::text[])', [LOTS]);
  await query('DELETE FROM ledger_edits WHERE edited_by = $1 OR target_id = ANY($2::text[])', [id, LOTS]);
  await query('DELETE FROM lot_locations WHERE lot_id = ANY($1::text[])', [LOTS]);
  await query('DELETE FROM stock_movements WHERE lot_id = ANY($1::text[])', [LOTS]);
  await query('DELETE FROM lots WHERE lot_id = ANY($1::text[])', [LOTS]);
  await query('DELETE FROM market_shops WHERE market_id = $1', [marketId]);
  await query('DELETE FROM markets WHERE id = $1', [marketId]);
  await query('DELETE FROM qualities WHERE name ILIKE $1', [`%${id}%`]);
  await query('DELETE FROM parties WHERE name = $1', [party]);
  await query('DELETE FROM auth_audit WHERE actor_id = $1', [id]);
  await query('DELETE FROM auth_sessions WHERE user_id = $1', [id]);
  await query('DELETE FROM users WHERE id = $1', [id]);
  await pool.end();
});

test('pipes: letters + digits, several per location, old numbers still read', () => {
  assert.deepEqual(checkPipe('a25250'), { ok: true, value: 'A25250' });
  assert.deepEqual(checkPipe(['ABCD256', 'b3', 'B3', '']), { ok: true, value: 'ABCD256, B3' });
  assert.deepEqual(checkPipe('03'), { ok: true, value: '3' });
  assert.equal(checkPipe('A 25!').ok, false);
  assert.equal(formatMarketLocation('LM', '245', 'A25, B3'), 'LM 245 · Pipe A25, B3');
  const r = parseMarketLocation('LM 245 · Pipe A25, B3', mk);
  assert.ok(r && r.ok && r.place.pipe === 'A25, B3');
  const old = parseMarketLocation('LM 245 · Pipe 3', mk);
  assert.ok(old && old.ok && old.place.pipe === '3');
  const bare = parseMarketLocation('LM 245', mk);
  assert.ok(bare && bare.ok && bare.place.pipe === null);
  assert.equal(describePlace('Landmark', '245', 'A25, B3'), 'Landmark, shop 245, pipes A25, B3');
});

test('quality catalog: existing qualities are listed for the type-ahead; manual entry refuses others', async () => {
  const list = (await (await getQualities(send('GET', '/api/qualities'))).json()).qualities as { name: string; active: boolean }[];
  assert.ok(list.some((q) => q.name === Q1 && q.active), 'catalog quality is offered');
  assert.ok(list.filter((q) => q.name.toLowerCase().startsWith('r')).some((q) => q.name === Q1), 'first letter finds it');

  const bad = await postStock(send('POST', '/api/stock', { direction: 'IN', lot_id: lot(1), quality: Q2, design: 'Plain', grey_meters: 5000, finished_meters: 4800, mill_name: 'QC Mill', location: `${code} 245 · Pipe A25, B3` }));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /not in the quality catalog/);

  // Different case → stored with the catalog's spelling; several lettered pipes saved.
  const ok = await postStock(send('POST', '/api/stock', { direction: 'IN', lot_id: lot(1), quality: Q1.toUpperCase(), design: 'Plain', grey_meters: 5000, finished_meters: 4800, mill_name: 'QC Mill', location: `${code} 245 · Pipe a25, B3` }));
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  const l = (await query('SELECT quality, cur_location FROM lots WHERE lot_id = $1', [lot(1)])).rows[0];
  assert.equal(l.quality, Q1);
  assert.equal(l.cur_location, `${code} 245 · Pipe A25, B3`);
  const mv = (await query(`SELECT register_pct FROM stock_movements WHERE lot_id = $1`, [lot(1)])).rows[0];
  assert.equal(Number(mv.register_pct), 4, 'shortage % worked out from grey → finished');
  const pipes = (await (await getPipes(send('GET', `/api/markets/pipes?market_id=${marketId}&shop=245`))).json()).pipes;
  assert.deepEqual([...pipes].sort(), ['A25', 'B3']);
});

test('quality catalog: add, rename (lots follow), switch off blocks new lots and edits', async () => {
  assert.equal((await postQuality(send('POST', '/api/qualities', { name: Q2 }))).status, 200);
  assert.equal((await postQuality(send('POST', '/api/qualities', { name: Q2.toLowerCase() }))).status, 409);
  await withTransaction((q) => recordIncoming(q, { lot_id: lot(2), quality: Q2, design: 'Plain', finished_meters: 1000, mill_name: 'QC Mill', location: `${code} 12A` }, { requireLotDetails: true, qualityCatalog: true }));
  const q2 = (await query('SELECT id FROM qualities WHERE name = $1', [Q2])).rows[0].id;
  const renamed = `${Q2} Fine`;
  assert.equal((await patchQuality(send('PATCH', '/api/qualities', { id: q2, name: renamed }))).status, 200);
  assert.equal((await query('SELECT quality FROM lots WHERE lot_id = $1', [lot(2)])).rows[0].quality, renamed);
  assert.equal((await patchQuality(send('PATCH', '/api/qualities', { id: q2, active: false }))).status, 200);
  await assert.rejects(withTransaction((q) => recordIncoming(q, { lot_id: lot(3), quality: renamed, design: 'Plain', finished_meters: 10, mill_name: 'QC Mill' }, { requireLotDetails: true, qualityCatalog: true })), /switched off/);
  // Ledger edit to a quality outside the catalog is refused.
  const mvId = Number((await query(`SELECT id FROM stock_movements WHERE lot_id = $1`, [lot(1)])).rows[0].id);
  await assert.rejects(withTransaction((q) => applyLedgerEdits(q, [{ target: 'movement', id: mvId, field: 'quality', value: 'Nope Quality' }], id)), /quality catalog/);
  await patchQuality(send('PATCH', '/api/qualities', { id: q2, active: true }));
});

test('location filter + stock components follow the filters', async () => {
  await withTransaction((q) => recordOutgoing(q, { lot_id: lot(1), meters: 800, party, pieces: 4 }));
  const shop245 = await ledgerSummary(query, F({ market: code, shop: '245' }));
  assert.equal(shop245.lots, 1);
  assert.equal(shop245.in_m, 4800);
  assert.equal(shop245.grey_m, 5000);
  assert.equal(shop245.shortage_m, 200);
  assert.equal(shop245.shortage_pct, 4);
  assert.equal(shop245.out_m, 800);
  assert.equal(shop245.out_pieces, 4);
  assert.equal(shop245.net_m, 4000);
  assert.equal(shop245.on_hand_m, 4000);
  const market = await ledgerSummary(query, F({ market: code }));
  assert.equal(market.lots, 2);
  assert.equal(market.on_hand_m, 5000);
  const rows = (await ledgerPage(query, F({ market: code, shop: '12A' }), { limit: 50, cursor: null })).rows;
  assert.ok(rows.length === 1 && rows[0].lot_id === lot(2));
  const lots = await lotsPage(query, { q: '', status: '', inStock: false, quality: '', market: code, shop: '245' }, { limit: 50, cursor: null });
  assert.deepEqual(lots.rows.map((r) => r.lot_id), [lot(1)]);
  const ls = await lotsSummary(query, { q: '', status: '', inStock: false, quality: '', market: code });
  assert.equal(ls.lots, 2);
  assert.equal(ls.on_hand_m, 5000);
  assert.equal(ls.running_lots, 1);
  assert.equal(ls.packed_lots, 1);
});

test('lot end asks final meters: default = dispatched, typed value updates the shortage', async () => {
  // End entry with no final meters → final = everything dispatched.
  await withTransaction((q) => recordIncoming(q, { lot_id: lot(4), quality: Q1, design: 'Plain', grey_meters: 5000, finished_meters: 4800, mill_name: 'QC Mill' }, { requireLotDetails: true }));
  await withTransaction((q) => recordOutgoing(q, { lot_id: lot(4), meters: 4800, party, entry_status: 'end' }, { endAllowed: true }));
  assert.equal(Number((await query('SELECT final_meters FROM lots WHERE lot_id = $1', [lot(4)])).rows[0].final_meters), 4800);
  // Folding gave 4,850: typed final meters.
  await withTransaction((q) => recordIncoming(q, { lot_id: lot(5), quality: Q1, design: 'Plain', grey_meters: 5000, finished_meters: 4800, mill_name: 'QC Mill' }, { requireLotDetails: true }));
  await withTransaction((q) => recordOutgoing(q, { lot_id: lot(5), meters: 4850, party, entry_status: 'end', final_meters: 4850 }, { endAllowed: true }));
  const s = await (await getShortage(send('GET', `/api/lots/shortage?lot_id=${lot(5)}`))).json();
  assert.equal(s.final_meters, 4850);
  assert.equal(s.shortage_m, 150);
  assert.equal(s.shortage_pct, 3);
  // Manual close with 4,750.
  await withTransaction((q) => recordIncoming(q, { lot_id: lot(6), quality: Q1, design: 'Plain', grey_meters: 5000, finished_meters: 4800, mill_name: 'QC Mill' }, { requireLotDetails: true }));
  await withTransaction((q) => recordOutgoing(q, { lot_id: lot(6), meters: 4700, party }));
  const res = await lotClose(send('POST', '/api/lots/close', { lot_id: lot(6), action: 'close', final_meters: 4750 }));
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.final_meters, 4750);
  assert.equal(out.shortage_m, 250);
  // Reopen clears it.
  await lotClose(send('POST', '/api/lots/close', { lot_id: lot(6), action: 'reopen' }));
  assert.equal((await query('SELECT final_meters FROM lots WHERE lot_id = $1', [lot(6)])).rows[0].final_meters, null);
});
