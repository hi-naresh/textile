import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pool, { query, withTransaction } from '../../src/lib/db';
import { recordIncoming } from '../../src/lib/ledger';
import { MAX_CHANGES, applyLedgerEdits } from '../../src/lib/ledger-edit';
import { commitChunk } from '../../src/lib/stock-import';

const databaseUrl = new URL(process.env.DATABASE_URL || 'postgresql://localhost/invalid');
if (!['localhost', '127.0.0.1', '::1'].includes(databaseUrl.hostname) || !databaseUrl.pathname.endsWith('_test')) {
  throw new Error('Use a disposable local DATABASE_URL ending in _test.');
}
process.env.DB_QUIET = '1';

const suffix = randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
const lotId = `STRESS-BULK-${suffix}`;
const batch = randomUUID().replace(/-/g, '').slice(0, 16);
let movementIds: number[] = [];

before(async () => {
  await withTransaction((q) => recordIncoming(q, {
    lot_id: lotId, quality: 'Stress bulk', design: 'Synthetic', finished_meters: 1000, mill_name: 'Stress test mill',
  }, { requireLotDetails: true }));
  const rows = Array.from({ length: MAX_CHANGES }, (_, i) => ({
    row: i + 2, direction: 'OUT', lot_id: lotId, meters: 1, party: 'Stress bulk update',
  }));
  await withTransaction((q) => commitChunk(q, batch, rows, null));
  const r = await query('SELECT id FROM stock_movements WHERE import_ref LIKE $1 ORDER BY id', [`${batch}:%`]);
  movementIds = r.rows.map((row) => Number(row.id));
});

after(async () => {
  if (movementIds.length) {
    await query(
      `DELETE FROM ledger_edits WHERE target = 'movement' AND target_id = ANY($1::text[])`,
      [movementIds.map(String)],
    );
  }
  await query('DELETE FROM stock_movements WHERE lot_id = $1', [lotId]);
  await query('DELETE FROM lot_locations WHERE lot_id = $1', [lotId]);
  await query('DELETE FROM lots WHERE lot_id = $1', [lotId]);
  await pool.end();
});

test('a maximum-size ledger edit is atomic, audited, and preserves the stock balance', async () => {
  assert.equal(movementIds.length, MAX_CHANGES);
  const edits = movementIds.map((id) => ({ target: 'movement' as const, id, field: 'meters' as const, value: 0.5 }));
  const result = await withTransaction((q) => applyLedgerEdits(q, edits, null));
  assert.equal(result.saved, MAX_CHANGES);
  assert.equal(Number((await query('SELECT bal_m FROM lots WHERE lot_id = $1', [lotId])).rows[0].bal_m), 750);
  assert.equal(Number((await query(
    `SELECT COUNT(*)::int AS n FROM ledger_edits WHERE target = 'movement' AND target_id = ANY($1::text[]) AND field = 'meters'`,
    [movementIds.map(String)],
  )).rows[0].n), MAX_CHANGES);
});
