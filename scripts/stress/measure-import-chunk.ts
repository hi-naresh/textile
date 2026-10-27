import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pool, { query, withTransaction } from '../../src/lib/db';
import { recordIncoming } from '../../src/lib/ledger';
import { CHUNK_MAX, commitChunk } from '../../src/lib/stock-import';

const databaseUrl = new URL(process.env.DATABASE_URL || 'postgresql://localhost/invalid');
if (!['localhost', '127.0.0.1', '::1'].includes(databaseUrl.hostname) || !databaseUrl.pathname.endsWith('_test')) {
  throw new Error('Stress tooling only runs against a local database ending in _test.');
}
process.env.DB_QUIET = '1';

function rowCountFromArgs() {
  const value = process.argv.find((arg) => arg.startsWith('--rows='))?.slice('--rows='.length);
  if (!value || !/^\d+$/.test(value)) throw new Error(`Pass --rows=<count>, between 1 and ${CHUNK_MAX}.`);
  const rows = Number(value);
  if (!Number.isSafeInteger(rows) || rows < 1 || rows > CHUNK_MAX) throw new Error(`Pass --rows=<count>, between 1 and ${CHUNK_MAX}.`);
  return rows;
}

async function main() {
  const count = rowCountFromArgs();
  const runId = randomUUID().replace(/-/g, '').slice(0, 16);
  const lotId = `STRESS-IMPORT-${runId}`.toUpperCase();
  const batch = randomUUID().replace(/-/g, '').slice(0, 16);
  const rows = Array.from({ length: count }, (_, i) => ({
    row: i + 2, direction: 'OUT', lot_id: lotId, meters: 1, party: `Stress import ${runId}`,
  }));
  let created = false;
  try {
    await withTransaction((q) => recordIncoming(q, {
      lot_id: lotId, quality: 'Stress test', design: 'Synthetic', finished_meters: count + 1, mill_name: 'Stress test mill',
    }, { requireLotDetails: true }));
    created = true;

    const started = performance.now();
    const result = await withTransaction((q) => commitChunk(q, batch, rows, null));
    const elapsedMs = performance.now() - started;
    if (result.saved !== count) throw new Error(`Expected ${count} rows saved; got ${result.saved}.`);
    const retry = await withTransaction((q) => commitChunk(q, batch, rows, null));
    if (retry.skipped !== count || retry.saved !== 0) throw new Error('Retry did not skip all previously saved rows.');
    const balance = Number((await query('SELECT bal_m FROM lots WHERE lot_id = $1', [lotId])).rows[0].bal_m);

    console.log(JSON.stringify({
      run_id: runId,
      batch_rows: count,
      saved: result.saved,
      elapsed_ms: Math.round(elapsedMs),
      rows_per_second: Math.round(count * 1000 / elapsedMs),
      retry_skipped: retry.skipped,
      final_balance_m: balance,
      consistent: balance === 1,
    }, null, 2));
    if (balance !== 1) process.exitCode = 1;
  } finally {
    if (created) {
      await query('DELETE FROM lot_locations WHERE lot_id = $1', [lotId]);
      await query('DELETE FROM stock_movements WHERE lot_id = $1', [lotId]);
      await query('DELETE FROM lots WHERE lot_id = $1', [lotId]);
    }
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
