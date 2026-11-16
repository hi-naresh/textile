import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { NextRequest } from 'next/server';
import { createDisposableDatabase } from '../../scripts/stress/disposable-database';
let isolated: Awaited<ReturnType<typeof createDisposableDatabase>>;
let db: typeof import('../../src/lib/db');
let ledger: typeof import('../../src/lib/ledger');
let edits: typeof import('../../src/lib/ledger-edit');
let dispatch: typeof import('../../src/lib/dispatch/dispatches');
let correction: typeof import('../../src/lib/dispatch/edit');
let invoices: typeof import('../../src/lib/dispatch/invoices');
let owner = '', supervisor = '', serial = 0;
const request = (path: string, body: unknown, cookie = owner, method = 'PATCH') => new NextRequest(`http://localhost/api/${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
before(async () => {
  isolated = await createDisposableDatabase('corrections');
  process.env.DATABASE_URL = isolated.url; process.env.DB_QUIET = '1';
  db = await import('../../src/lib/db'); ledger = await import('../../src/lib/ledger'); edits = await import('../../src/lib/ledger-edit');
  dispatch = await import('../../src/lib/dispatch/dispatches'); correction = await import('../../src/lib/dispatch/edit'); invoices = await import('../../src/lib/dispatch/invoices');
  const { createSession } = await import('../../src/lib/auth/session');
  await db.query("INSERT INTO users (id, name, role) VALUES ('cor-owner', 'Correction Owner', 'owner'), ('cor-super', 'Correction Supervisor', 'supervisor')");
  owner = `tb_at=${(await createSession(db.query, 'cor-owner', 'client', request('', {}))).tokens.access}`;
  supervisor = `tb_at=${(await createSession(db.query, 'cor-super', 'client', request('', {}))).tokens.access}`;
});
after(async () => { if (db) await db.default.end(); if (isolated) await isolated.cleanup(); });
async function lot(extra = {}) {
  const lot_id = `COR-${++serial}`;
  const incoming = await db.withTransaction((q) => ledger.recordIncoming(q, { lot_id, quality: 'Cotton', design: 'Plain', finished_meters: 100, ...extra }, { requireLotDetails: true }));
  return { lot_id, incoming };
}
async function shipped(extra = {}) {
  const l = await lot();
  const d = await db.withTransaction((q) => dispatch.createDispatch(q, { party: 'Correction Party', lines: [{ lot_id: l.lot_id, meters: 40, bill_pct: 98 }], ...extra }, 'cor-owner'));
  return { ...l, ...await dispatch.getDispatch(db.query, d.id, true) };
}
const correct = (id: number, body: Record<string, unknown>) => db.withTransaction((q) => correction.editDispatch(q, id, body, 'cor-owner'));
const amount = (id: number, meters: number) => db.withTransaction((q) => edits.applyLedgerEdits(q, [{ target: 'movement', id, field: 'meters', value: meters }], 'cor-owner'));
const balance = async (lot: string) => Number((await db.query('SELECT bal_m FROM lots WHERE lot_id = $1', [lot])).rows[0].bal_m);

test('#4 concurrent End/OUT waits for the lot lock, then rejects writes after closure or includes the earlier OUT', async () => {
  for (const endFirst of [true, false]) {
    const l = await lot();
    const first = await db.default.connect(), second = await db.default.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await first.query('BEGIN'); await second.query('BEGIN');
      await first.query("SET LOCAL statement_timeout = '5s'"); await second.query("SET LOCAL statement_timeout = '5s'");
      const pid = Number((await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      const write = (client: typeof first, end: boolean) => ledger.recordOutgoing((sql, args) => client.query(sql, args), { lot_id: l.lot_id, meters: end ? 30 : 20, party: 'Concurrency Party', entry_status: end ? 'end' : 'running' }, { endAllowed: true });
      await write(first, endFirst);
      pending = write(second, !endFirst).then((value) => ({ value, error: null }), (error) => ({ value: null, error }));
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const x = await db.query('SELECT cardinality(pg_blocking_pids($1)) AS n', [pid]);
        if (Number(x.rows[0].n)) { blocked = true; break; }
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(blocked, 'second writer must wait on the uncommitted first writer');
      await first.query('COMMIT');
      const result = await pending as { error: Error | null };
      if (endFirst) { assert.match(result.error!.message, /closed/i); await second.query('ROLLBACK'); }
      else { assert.equal(result.error, null); await second.query('COMMIT'); }
      assert.equal(await balance(l.lot_id), 0);
      const state = (await db.query("SELECT COUNT(*) AS n, SUM(adjustment_m) AS adjustment FROM lot_closures WHERE lot_id = $1 AND action = 'close'", [l.lot_id])).rows[0];
      assert.equal(Number(state.n), 1); assert.equal(Number(state.adjustment), endFirst ? 70 : 50);
    } finally {
      await first.query('ROLLBACK'); await pending; await second.query('ROLLBACK'); first.release(); second.release();
    }
  }
});

test('#20 header/line correction is atomic, audited, synchronizes dates and challans, and never queues messages', async () => {
  const d = await shipped();
  const out = await correct(d.dispatch.id, { transporter: 'Updated Transport', lr_no: 'LR-456', vehicle_no: 'gj05ab1234', packages: 5, challan_no: `FIX-${d.dispatch.id}`, date: '29102026', lines: [{ movement_id: d.lines[0].movement_id, meters: 50 }] });
  assert.equal(out.dispatch.meters, 50); assert.equal(out.dispatch.vehicle_no, 'GJ05AB1234');
  assert.equal(out.dispatch.challan_no, `FIX-${d.dispatch.id}`); assert.equal(out.edits.length, 1);
  assert.equal(out.edits[0].edited_by, 'Correction Owner');
  const m = (await db.query("SELECT source_doc_id, to_char(ts, 'YYYY-MM-DD') AS date, billed_meters::float FROM stock_movements WHERE id = $1", [d.lines[0].movement_id])).rows[0];
  assert.equal(m.date, '2026-10-29'); assert.equal(m.source_doc_id, `FIX-${d.dispatch.id}`); assert.equal(m.billed_meters, 49);
  assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM whatsapp_messages WHERE dispatch_id = $1', [d.dispatch.id])).rows[0].n), 0);
  await assert.rejects(correct(d.dispatch.id, { transporter: 'Must Roll Back', lines: [{ movement_id: d.lines[0].movement_id, meters: -1 }] }));
  assert.equal((await dispatch.getDispatch(db.query, d.dispatch.id, true)).dispatch.transporter, 'Updated Transport');
  const other = await shipped();
  await assert.rejects(correct(other.dispatch.id, { challan_no: `FIX-${d.dispatch.id}` }), /already used/);
  await assert.rejects(correct(other.dispatch.id, { lines: [{ movement_id: d.lines[0].movement_id, meters: 1 }] }), /existing/);
  const route = await import('../../src/app/api/dispatches/[id]/route');
  assert.equal((await route.PATCH(request(`dispatches/${d.dispatch.id}`, { transporter: 'Denied' }, supervisor), { params: Promise.resolve({ id: String(d.dispatch.id) }) })).status, 403);
  assert.equal((await route.PATCH(request(`dispatches/${d.dispatch.id}`, { transporter: 'Owner Edited' }), { params: Promise.resolve({ id: String(d.dispatch.id) }) })).status, 200);
  await assert.rejects(db.withTransaction((q) => edits.applyLedgerEdits(q, [{ target: 'movement', id: d.lines[0].movement_id, field: 'source_doc_id', value: 'DIVERGED' }], 'cor-owner')), /Dispatch & documents/);
});

test('#22 invoice copies are protected, cancelled invoices allow corrections, transport metadata stays editable', async () => {
  const d = await shipped();
  const inv = await db.withTransaction((q) => invoices.createInvoiceForDispatch(q, d.dispatch.id, { rates: { Cotton: 10 }, actor: 'cor-owner' }));
  await assert.rejects(amount(d.lines[0].movement_id, 50), /Cancel invoice/);
  await assert.rejects(correct(d.dispatch.id, { party: 'Another Party' }), /Cancel invoice/);
  await assert.rejects(correct(d.dispatch.id, { date: '29102026' }), /Cancel invoice/);
  await correct(d.dispatch.id, { transporter: 'New Transport' });
  assert.equal((await invoices.getInvoice(db.query, inv.invoice.id)).lines[0].meters, 40);
  await db.withTransaction((q) => invoices.cancelInvoice(q, inv.invoice.id));
  await amount(d.lines[0].movement_id, 50);
  assert.equal((await dispatch.getDispatch(db.query, d.dispatch.id, true)).dispatch.meters, 50);
});

test('#22 incoming grey/finished corrections derive stock and shortage, audit source and reject conflicts', async () => {
  const l = await lot({ grey_meters: 110 });
  const id = Number(l.incoming.id);
  await db.withTransaction((q) => edits.applyLedgerEdits(q, [{ target: 'movement', id, field: 'finished_meters', value: 90 }], 'cor-owner'));
  assert.equal(await balance(l.lot_id), 90);
  const m = (await db.query('SELECT meters::float, finished_meters::float, register_pct::float FROM stock_movements WHERE id = $1', [id])).rows[0];
  assert.deepEqual(m, { meters: 90, finished_meters: 90, register_pct: 18.18 });
  await amount(id, 80);
  assert.equal(Number((await db.query('SELECT finished_meters FROM stock_movements WHERE id = $1', [id])).rows[0].finished_meters), 80);
  await assert.rejects(db.withTransaction((q) => edits.applyLedgerEdits(q, [{ target: 'movement', id, field: 'meters', value: 70 }, { target: 'movement', id, field: 'finished_meters', value: 75 }], 'cor-owner')), /must agree/);
  assert.equal(await balance(l.lot_id), 80);
  assert.ok((await db.query("SELECT id FROM ledger_edits WHERE target_id = $1 AND field = 'finished_meters'", [String(id)])).rows.length >= 2);
});

test('#22 order status and allocations follow changed meters; negative stock warns and trims reservations', async () => {
  const { createOrder } = await import('../../src/lib/sales/orders');
  const { manualAllocate } = await import('../../src/lib/sales/allocate');
  const l = await lot();
  const { order } = await db.withTransaction((q) => createOrder(q, { party: 'Order Correction', quality: 'Cotton', meters: 80, rate_per_m: 10 }, 'cor-owner'));
  await db.withTransaction((q) => manualAllocate(q, order.id, l.lot_id, 80, 'cor-owner'));
  const d = await db.withTransaction((q) => dispatch.createDispatch(q, { order_id: order.id, lines: [{ lot_id: l.lot_id, meters: 80 }] }, 'cor-owner'));
  const m = (await dispatch.getDispatch(db.query, d.id, true)).lines[0];
  await amount(m.movement_id, 40);
  assert.equal((await db.query('SELECT status FROM orders WHERE id = $1', [order.id])).rows[0].status, 'partly_dispatched');
  assert.equal(Number((await db.query('SELECT dispatched_m FROM allocations WHERE order_id = $1', [order.id])).rows[0].dispatched_m), 40);
  const out = await amount(Number(l.incoming.id), 20);
  assert.equal(out.warnings.length, 1); assert.equal(await balance(l.lot_id), -20);
  const a = (await db.query('SELECT meters::float, dispatched_m::float, status FROM allocations WHERE order_id = $1', [order.id])).rows[0];
  assert.equal(a.meters - a.dispatched_m, 0);
  await correct(d.id, { party: 'Corrected Buyer' });
  assert.equal((await db.query('SELECT status FROM orders WHERE id = $1', [order.id])).rows[0].status, 'open');
  assert.equal((await dispatch.getDispatch(db.query, d.id, true)).lines[0].order_id, null);
});

test('#19 stock save and ledger correction return phase timings', async () => {
  const l = await lot();
  const { POST } = await import('../../src/app/api/stock/route');
  const { PATCH } = await import('../../src/app/api/stock/edit/route');
  const post = await POST(request('stock', { direction: 'OUT', lot_id: l.lot_id, meters: 10, party: 'Timing Party' }, owner, 'POST'));
  assert.equal(post.status, 200); assert.match(post.headers.get('server-timing')!, /auth;dur=.*write;dur=.*total;dur=/);
  const data = await post.json();
  const patch = await PATCH(request('stock/edit', { changes: [{ target: 'movement', id: data.movement.id, field: 'meters', value: 12 }] }));
  assert.equal(patch.status, 200); assert.match(patch.headers.get('server-timing')!, /auth;dur=.*write;dur=.*total;dur=/);
});

test('#22 invoice creation and meter correction serialize on the dispatch', async () => {
  for (const invoiceFirst of [true, false]) {
    const d = await shipped();
    const first = await db.default.connect(), second = await db.default.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await first.query('BEGIN'); await second.query('BEGIN');
      await first.query("SET LOCAL statement_timeout = '5s'"); await second.query("SET LOCAL statement_timeout = '5s'");
      const pid = Number((await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      const write = (client: typeof first, invoice: boolean) => invoice
        ? invoices.createInvoiceForDispatch((sql, args) => client.query(sql, args), d.dispatch.id, { rates: { Cotton: 10 }, actor: 'cor-owner' })
        : edits.applyLedgerEdits((sql, args) => client.query(sql, args), [{ target: 'movement', id: d.lines[0].movement_id, field: 'meters', value: 50 }], 'cor-owner');
      await write(first, invoiceFirst);
      pending = write(second, !invoiceFirst).then((value) => ({ value, error: null }), (error) => ({ value: null, error }));
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        if (Number((await db.query('SELECT cardinality(pg_blocking_pids($1)) AS n', [pid])).rows[0].n)) { blocked = true; break; }
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(blocked);
      await first.query('COMMIT');
      const result = await pending as { error: Error | null };
      if (invoiceFirst) { assert.match(result.error!.message, /Cancel invoice/); await second.query('ROLLBACK'); }
      else { assert.equal(result.error, null); await second.query('COMMIT'); }
      const current = await dispatch.getDispatch(db.query, d.dispatch.id, true);
      const inv = await invoices.getInvoice(db.query, current.dispatch.invoice_id!);
      assert.equal(current.lines[0].meters, invoiceFirst ? 40 : 50);
      assert.equal(inv.lines[0].meters, current.lines[0].meters);
    } finally {
      await first.query('ROLLBACK'); await pending; await second.query('ROLLBACK'); first.release(); second.release();
    }
  }
});

test('#20 regenerated challan and packing PDFs contain corrected shipment details and meters', async () => {
  const d = await shipped();
  await correct(d.dispatch.id, { transporter: 'Corrected Transport', lr_no: 'LR-NEW', lines: [{ movement_id: d.lines[0].movement_id, meters: 55.25 }] });
  const { PDFDocument, PDFRawStream, decodePDFRawStream } = await import('pdf-lib');
  for (const kind of ['challan', 'packing-list']) {
    const route = kind === 'challan' ? await import('../../src/app/api/docs/challan/route') : await import('../../src/app/api/docs/packing-list/route');
    const response = await route.GET(new NextRequest(`http://localhost/api/docs/${kind}?dispatch_id=${d.dispatch.id}`, { headers: { cookie: owner } }));
    assert.equal(response.status, 200);
    const document = await PDFDocument.load(await response.arrayBuffer());
    const content = document.context.enumerateIndirectObjects().flatMap(([, obj]) => {
      if (!(obj instanceof PDFRawStream)) return [];
      const operators = Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1');
      return [...operators.matchAll(/<([0-9a-f]+)>\s*Tj/gi)].map((m) => Buffer.from(m[1], 'hex').toString('latin1'));
    }).join('\n');
    assert.match(content, /Corrected Transport/); assert.match(content, /LR-NEW/); assert.match(content, /55\.25/);
  }
});
