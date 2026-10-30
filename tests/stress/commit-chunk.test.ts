import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Client } from 'pg';
import pool, { query, withTransaction, type Q } from '../../src/lib/db';
import { recordIncoming } from '../../src/lib/ledger';
import { ChunkRowError, commitChunk } from '../../src/lib/stock-import';

const databaseUrl = new URL(process.env.DATABASE_URL || 'postgresql://localhost/invalid');
if (!['localhost', '127.0.0.1', '::1'].includes(databaseUrl.hostname) || !databaseUrl.pathname.endsWith('_test')) {
  throw new Error('Use a disposable local DATABASE_URL ending in _test.');
}
process.env.DB_QUIET = '1';

const suffix = randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
const lotId = `STRESS-CHUNK-${suffix}`;
const batch = randomUUID().replace(/-/g, '').slice(0, 16);
const row = { row: 2, direction: 'OUT', lot_id: lotId, meters: 10, party: `Stress ${suffix}` };

before(async () => {
  await withTransaction((q) => recordIncoming(q, {
    lot_id: lotId, quality: 'Stress test', design: 'Synthetic', finished_meters: 1000, mill_name: 'Stress test mill',
  }, { requireLotDetails: true }));
});

after(async () => {
  await query('DELETE FROM stock_movements WHERE import_ref LIKE $1', [`${batch}:%`]);
  await query('DELETE FROM lot_locations WHERE lot_id = $1', [lotId]);
  await query('DELETE FROM stock_movements WHERE lot_id = $1', [lotId]);
  await query('DELETE FROM lots WHERE lot_id = $1', [lotId]);
  await pool.end();
});

test('concurrent retries of the same import chunk save each row once', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () =>
    withTransaction((q) => commitChunk(q, batch, [row], null))));
  assert.deepEqual([
    results.reduce((sum, result) => sum + result.saved, 0),
    results.reduce((sum, result) => sum + result.skipped, 0),
  ], [1, 19]);
  assert.equal(Number((await query('SELECT COUNT(*)::int AS n FROM stock_movements WHERE import_ref = $1', [`${batch}:2`])).rows[0].n), 1);
  assert.equal(Number((await query('SELECT bal_m FROM lots WHERE lot_id = $1', [lotId])).rows[0].bal_m), 990);
});

test('a failed chunk rolls back rows that were processed earlier in that chunk', async () => {
  const failedBatch = randomUUID().replace(/-/g, '').slice(0, 16);
  await assert.rejects(
    withTransaction((q) => commitChunk(q, failedBatch, [
      { ...row, row: 2 },
      { ...row, row: 3, lot_id: `${lotId}-MISSING` },
    ], null)),
    (error: unknown) => error instanceof ChunkRowError && error.row === 3,
  );
  assert.equal(Number((await query('SELECT COUNT(*)::int AS n FROM stock_movements WHERE import_ref LIKE $1', [`${failedBatch}:%`])).rows[0].n), 0);
  assert.equal(Number((await query('SELECT bal_m FROM lots WHERE lot_id = $1', [lotId])).rows[0].bal_m), 990);
});

test('an injected database failure after a write rolls back the entire chunk', async () => {
  const failedBatch = randomUUID().replace(/-/g, '').slice(0, 16);
  await assert.rejects(withTransaction((tx) => {
    let writes = 0;
    const failSecondMovement: Q = async (text, params) => {
      if (text.includes('INSERT INTO stock_movements')) {
        writes++;
        if (writes === 2) throw new Error('Injected database failure.');
      }
      return tx(text, params);
    };
    return commitChunk(failSecondMovement, failedBatch, [
      { ...row, row: 2 },
      { ...row, row: 3 },
    ], null);
  }), /Injected database failure/);
  assert.equal(Number((await query('SELECT COUNT(*)::int AS n FROM stock_movements WHERE import_ref LIKE $1', [`${failedBatch}:%`])).rows[0].n), 0);
  assert.equal(Number((await query('SELECT bal_m FROM lots WHERE lot_id = $1', [lotId])).rows[0].bal_m), 990);
});

test('terminating the actual database connection mid-chunk rolls back writes and permits an idempotent retry', { timeout: 10000 }, async () => {
  const lostBatch = randomUUID().replace(/-/g, '').slice(0, 16);
  const rows = [{ ...row, row: 2 }, { ...row, row: 3 }];
  const victim = new Client({ connectionString: databaseUrl.toString() });
  const disconnected = new Promise<void>((resolve) => victim.once('error', () => resolve()));
  victim.on('error', () => {});
  try {
    await victim.connect();
    const pid = Number((await victim.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    await victim.query('BEGIN');
    let terminated = false;
    const q: Q = async (sql, params) => {
      const result = await victim.query(sql, params);
      if (!terminated && sql.includes('INSERT INTO stock_movements')) {
        terminated = true;
        assert.equal((await query('SELECT pg_terminate_backend($1) AS killed', [pid])).rows[0].killed, true);
        await disconnected;
      }
      return result;
    };
    await assert.rejects(commitChunk(q, lostBatch, rows, null));
    assert.equal(terminated, true);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM stock_movements WHERE import_ref LIKE $1', [`${lostBatch}:%`])).rows[0].n, 0);
    assert.equal(Number((await query('SELECT bal_m FROM lots WHERE lot_id = $1', [lotId])).rows[0].bal_m), 990);
    assert.equal((await withTransaction((tx) => commitChunk(tx, lostBatch, rows, null))).saved, 2);
    assert.equal((await withTransaction((tx) => commitChunk(tx, lostBatch, rows, null))).skipped, 2);
    assert.equal(Number((await query('SELECT bal_m FROM lots WHERE lot_id = $1', [lotId])).rows[0].bal_m), 970);
  } finally { await victim.end(); }
});
