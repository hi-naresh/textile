import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { createDisposableDatabase } from '../../scripts/stress/disposable-database';
import type { ValidateResult, RegOutRow } from '../../src/lib/stock-import';
import { toBuffer } from '../../src/lib/excel';
import { ImportStatusReview } from '../../src/components/ImportStatusReview';
import { resolveReview, reviewStatuses } from '../../src/lib/import-status-review';

let isolated: Awaited<ReturnType<typeof createDisposableDatabase>>;
let db: typeof import('../../src/lib/db');
let validate: typeof import('../../src/app/api/stock/import/route').POST;
let confirm: typeof import('../../src/app/api/stock/import/review/route').POST;
let commit: typeof import('../../src/app/api/stock/import/commit/route').POST;
let owner = '', otherOwner = '', supervisor = '';
let sequence = 0;
const req = (path: string, body: FormData | string, cookie = owner) => new NextRequest(`http://localhost/api/stock/import${path}`, {
  method: 'POST', headers: { cookie, ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}) }, body,
});

before(async () => {
  isolated = await createDisposableDatabase('importreview');
  process.env.DATABASE_URL = isolated.url;
  process.env.DB_QUIET = '1';
  process.env.API_RATE_LIMIT_STOCK_IMPORT = '1000';
  db = await import('../../src/lib/db');
  ({ POST: validate } = await import('../../src/app/api/stock/import/route'));
  ({ POST: confirm } = await import('../../src/app/api/stock/import/review/route'));
  ({ POST: commit } = await import('../../src/app/api/stock/import/commit/route'));
  const { createSession } = await import('../../src/lib/auth/session');
  await db.query("INSERT INTO users (id, name, role) VALUES ('review-owner', 'Owner', 'owner'), ('review-other', 'Other', 'owner'), ('review-supervisor', 'Supervisor', 'supervisor')");
  const cookie = async (id: string) => `tb_at=${(await createSession(db.query, id, 'client', req('', '{}'))).tokens.access}`;
  owner = await cookie('review-owner'); otherOwner = await cookie('review-other'); supervisor = await cookie('review-supervisor');
});
after(async () => { if (db) await db.default.end(); if (isolated) await isolated.cleanup(); });

async function fixture(codes: (string | null)[], sameLot = false) {
  const prefix = `REVIEW-${++sequence}`;
  const lots = codes.map((_, i) => `${prefix}-${sameLot ? 0 : i}`);
  const { recordIncoming } = await import('../../src/lib/ledger');
  for (const lot_id of new Set(lots)) await db.withTransaction((q) => recordIncoming(q, {
    lot_id, quality: 'Review cotton', design: 'Plain', finished_meters: 1000, mill_name: 'Test mill',
  }, { requireLotDetails: true }));
  const { newBook } = await import('../../src/lib/stock-import');
  const { OUTGOING_COLUMNS } = await import('../../src/lib/register-import');
  const wb = newBook('Import review');
  const ws = wb.addWorksheet('Outgoing register');
  ws.columns = OUTGOING_COLUMNS.map((c) => ({ header: c.header, key: c.key }));
  codes.forEach((code, i) => ws.addRow({ date: '2026-10-01', bno: `${prefix}-B${i}`, lot: lots[i], lots: code, qty: 10 }));
  const file = new File([new Uint8Array(await toBuffer(wb))], 'review.xlsx');
  const form = new FormData(); form.append('file', file);
  const response = await validate(req('', form));
  assert.equal(response.status, 200);
  const checked = await response.json() as ValidateResult;
  assert.equal(checked.ok, true, JSON.stringify(checked.problems));
  assert.ok(checked.reviewId);
  return { file, checked, lots };
}
function confirmFile(checked: ValidateResult, file: File, choices: unknown, cookie = owner) {
  const form = new FormData(); form.append('file', file); form.append('reviewId', checked.reviewId!); form.append('choices', JSON.stringify(choices));
  return confirm(req('/review', form, cookie));
}
function send(checked: ValidateResult, rows: unknown[], reviewId: string | undefined = checked.reviewId, cookie = owner) {
  return commit(req('/commit', JSON.stringify({ batch: checked.batch, rows, reviewId }), cookie));
}
const outgoingCount = async () => Number((await db.query("SELECT count(*) AS n FROM stock_movements WHERE direction = 'OUT'")).rows[0].n);

test('#28 blank, A and unknown statuses block both confirmation and direct commit without stock writes', async () => {
  for (const code of [null, 'A', 'XYZ']) {
    const before = await outgoingCount();
    const { file, checked, lots } = await fixture([code]);
    assert.equal(reviewStatuses(checked.rows as RegOutRow[])[0].status, null);
    assert.equal((await confirmFile(checked, file, {})).status, 400);
    assert.equal((await send(checked, checked.rows!)).status, 409);
    const withoutPlan = { batch: checked.batch, rows: [{ ...checked.rows![0], entry_status: 'running' }] };
    assert.equal((await commit(req('/commit', JSON.stringify(withoutPlan)))).status, 409);
    assert.equal(await outgoingCount(), before);
    assert.equal(Number((await db.query('SELECT bal_m FROM lots WHERE lot_id = $1', [lots[0]])).rows[0].bal_m), 1000);
  }
});

test('#28 known codes also require confirmation; every confirmed row gets the displayed status and replay writes nothing twice', async () => {
  const { file, checked, lots } = await fixture([null, 'A', 'XYZ', 'S', 'R', 'E']);
  assert.equal((await send(checked, checked.rows!)).status, 409);
  const choices = { [lots[0]]: 'running', [lots[1]]: 'end', [lots[2]]: 'running' };
  const response = await confirmFile(checked, file, choices);
  assert.equal(response.status, 200);
  const { rows } = await response.json();
  assert.deepEqual(rows.map((r: RegOutRow) => r.entry_status), ['running', 'end', 'running', 'running', 'running', 'end']);
  const result = await send(checked, rows);
  assert.equal(result.status, 200, JSON.stringify(await result.clone().json()));
  assert.equal((await result.json()).saved, 6);
  assert.equal((await (await send(checked, rows)).json()).skipped, 6);
  const saved = (await db.query("SELECT lot_id, entry_status, lot_status_code FROM stock_movements WHERE lot_id = ANY($1::text[]) AND kind = 'normal' AND direction = 'OUT' ORDER BY id", [lots])).rows;
  assert.deepEqual(saved.map((r) => r.entry_status), rows.map((r: RegOutRow) => r.entry_status));
  assert.deepEqual(saved.map((r) => r.lot_status_code), [null, 'A', 'XYZ', 'S', 'R', 'E']);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM lots WHERE lot_id = ANY($1::text[]) AND closed_at IS NOT NULL', [lots])).rows[0].n, 2);
  const form = new FormData(); form.append('file', file);
  const rechecked = await (await validate(req('', form))).json();
  assert.equal(rechecked.alreadySaved, 6); assert.deepEqual(rechecked.rows, []);
});

test('#28 changed file, modified rows, batch and chunk order are refused before writes', async () => {
  const { file, checked, lots } = await fixture(['R', 'E'], true);
  const before = await outgoingCount();
  const changed = new File([await file.arrayBuffer(), 'changed'], 'review.xlsx');
  assert.equal((await confirmFile(checked, changed, {})).status, 409);
  const { rows } = await (await confirmFile(checked, file, {})).json();
  for (const field of ['meters', 'ref', 'entry_status', 'lot_id', 'lot_status_code', 'fmt']) {
    const altered = rows.map((r: RegOutRow) => ({ ...r })); altered[0][field] = field === 'meters' ? 11 : 'changed';
    assert.equal((await send(checked, altered)).status, 409, field);
  }
  assert.equal((await send({ ...checked, batch: '0123456789abcdef' }, rows)).status, 409);
  assert.equal((await send(checked, [rows[1]])).status, 409);
  assert.equal((await send(checked, [...rows].reverse())).status, 409);
  assert.equal(await outgoingCount(), before);
  assert.equal(Number((await db.query('SELECT bal_m FROM lots WHERE lot_id = $1', [lots[0]])).rows[0].bal_m), 1000);
});

test('#28 review is owner-bound, expires, and cannot be changed after confirmation', async () => {
  const { file, checked, lots } = await fixture(['A']);
  const choices = { [lots[0]]: 'running' };
  assert.equal((await confirmFile({ ...checked, reviewId: '-'.repeat(36) }, file, choices)).status, 409);
  assert.equal((await confirmFile(checked, file, choices, supervisor)).status, 403);
  assert.equal((await confirmFile(checked, file, choices, otherOwner)).status, 409);
  assert.equal((await confirmFile(checked, file, { [lots[0]]: 'packed' })).status, 400);
  assert.equal((await confirmFile(checked, file, { ...choices, UNKNOWN: 'end' })).status, 400);
  const { rows } = await (await confirmFile(checked, file, choices)).json();
  assert.equal((await confirmFile(checked, file, choices)).status, 200); // lost confirmation response
  assert.equal((await confirmFile(checked, file, { [lots[0]]: 'end' })).status, 409);
  assert.equal((await send(checked, rows, checked.reviewId, otherOwner)).status, 409);
  await db.query("UPDATE stock_import_reviews SET expires_at = now() - interval '1 second' WHERE id = $1", [checked.reviewId]);
  assert.equal((await send(checked, rows)).status, 409);
});

test('#28 End with later sales is visible as Running; chunks resume and replay safely', async () => {
  const { file, checked, lots } = await fixture(['E', null, 'A'], true);
  const choices = { [lots[0]]: 'end' as const };
  const preview = reviewStatuses(checked.rows as RegOutRow[], choices);
  assert.deepEqual(preview.map((r) => r.status), ['running', 'running', 'end']);
  assert.deepEqual(preview.map((r) => r.deferredEnd), [true, true, false]);
  const { rows } = await (await confirmFile(checked, file, choices)).json();
  for (const row of rows) {
    const result = await send(checked, [row]); assert.equal(result.status, 200);
    assert.equal((await result.json()).saved, 1);
    assert.equal((await (await send(checked, [row])).json()).skipped, 1);
  }
  assert.equal((await db.query('SELECT count(*)::int AS n FROM lot_closures WHERE lot_id = $1', [lots[0]])).rows[0].n, 1);
  assert.equal(Number((await db.query('SELECT bal_m FROM lots WHERE lot_id = $1', [lots[0]])).rows[0].bal_m), 0);
});

test('#28 all uncertain lots must be resolved; review renders the original code and chosen result', async () => {
  const { checked, file, lots } = await fixture([null, 'A', 'ZZ', 'S']);
  assert.equal((await confirmFile(checked, file, { [lots[0]]: 'running' })).status, 400);
  const rows = checked.rows as RegOutRow[];
  const choices = Object.fromEntries(lots.slice(0, 3).map((lot) => [lot, 'running' as const]));
  assert.ok(resolveReview(rows, choices).every((r) => r.entry_status === 'running'));
  const html = renderToStaticMarkup(React.createElement(ImportStatusReview, { rows, choices: {}, onChange: () => {} }));
  for (const lot of lots) assert.ok(html.includes(lot));
  assert.match(html, /\(blank\)/); assert.match(html, /ZZ/); assert.match(html, /3 lot\(s\) still need a choice/);
  const resolved = renderToStaticMarkup(React.createElement(ImportStatusReview, { rows, choices, onChange: () => {} }));
  assert.match(resolved, /All statuses are set/);
});

test('#28 ledger failure rolls back the review cursor and the whole chunk', async () => {
  const { checked, file, lots } = await fixture(['R', 'R']);
  const { rows } = await (await confirmFile(checked, file, {})).json();
  const { closeLot } = await import('../../src/lib/ledger');
  await db.withTransaction((q) => closeLot(q, lots[1], { reason: 'manual', by: 'review-owner' }));
  assert.equal((await send(checked, rows)).status, 422);
  assert.equal((await db.query('SELECT committed_count FROM stock_import_reviews WHERE id = $1', [checked.reviewId])).rows[0].committed_count, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM stock_movements WHERE import_ref = ANY($1::text[])', [rows.map((r: RegOutRow) => r.ref)])).rows[0].n, 0);
});
