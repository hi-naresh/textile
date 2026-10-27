import { closePool, pool } from './db';
import { performance } from 'node:perf_hooks';

const BATCH_SIZE = 10_000;
const MAX_ROWS = 1_000_000;

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function parseRows(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw new Error('Pass --rows=<count>, between 1 and 1,000,000.');
  const rows = Number(value);
  if (!Number.isSafeInteger(rows) || rows < 1 || rows > MAX_ROWS) throw new Error('Pass --rows=<count>, between 1 and 1,000,000.');
  return rows;
}

function parseRunId(value: string | undefined): string {
  if (!value || !/^[a-zA-Z0-9-]{1,30}$/.test(value)) throw new Error('Pass --run-id=<1-30 letters, numbers, or hyphens>.');
  return value.toLowerCase();
}

async function generate(runId: string, rows: number) {
  const lotId = `STRESS-${runId}`.toUpperCase();
  const existing = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM lots WHERE lot_id = $1) OR EXISTS (SELECT 1 FROM stock_movements WHERE import_ref LIKE $2) AS exists`,
    [lotId, `stress:${runId}:%`],
  );
  if (existing.rows[0].exists) throw new Error(`Stress fixture ${runId} already exists. Use --cleanup=${runId} first.`);

  await pool.query(
    `INSERT INTO lots (lot_id, quality, design) VALUES ($1, 'Stress test', 'Synthetic')`,
    [lotId],
  );

  const started = performance.now();
  for (let start = 1; start <= rows; start += BATCH_SIZE) {
    const end = Math.min(rows, start + BATCH_SIZE - 1);
    const batchStarted = performance.now();
    await pool.query(
      `INSERT INTO stock_movements
         (lot_id, direction, meters, mill_name, party, source_doc_id, import_ref, entry_status)
       SELECT $1,
              CASE WHEN n % 3 = 0 THEN 'OUT' ELSE 'IN' END,
              1,
              CASE WHEN n % 3 = 0 THEN NULL ELSE 'Stress test mill' END,
              CASE WHEN n % 3 = 0 THEN 'Stress test party' ELSE NULL END,
              'STRESS-' || n::text,
              'stress:' || $2 || ':' || n::text,
              CASE WHEN n % 3 = 0 THEN 'running' ELSE NULL END
         FROM generate_series($3::int, $4::int) AS n`,
      [lotId, runId, start, end],
    );
    const elapsedMs = performance.now() - batchStarted;
    console.log(JSON.stringify({
      run_id: runId,
      completed_rows: end,
      total_rows: rows,
      batch_rows: end - start + 1,
      batch_ms: Math.round(elapsedMs),
      batch_rows_per_second: Math.round((end - start + 1) * 1000 / elapsedMs),
    }));
  }

  const expectedBalance = rows - 2 * Math.floor(rows / 3);
  const elapsedMs = performance.now() - started;
  console.log(JSON.stringify({
    completed: true,
    run_id: runId,
    lot_id: lotId,
    rows,
    elapsed_ms: Math.round(elapsedMs),
    rows_per_second: Math.round(rows * 1000 / elapsedMs),
    expected_balance_m: expectedBalance,
  }));
}

async function cleanup(runId: string) {
  const lotId = `STRESS-${runId}`.toUpperCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM stock_movements WHERE import_ref LIKE $1`, [`stress:${runId}:%`]);
    await client.query(`DELETE FROM lots WHERE lot_id = $1`, [lotId]);
    await client.query('COMMIT');
    console.log(`Removed stress fixture ${runId} (${lotId}).`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const cleanupId = option('cleanup');
  if (cleanupId) {
    await cleanup(parseRunId(cleanupId));
    return;
  }
  if (!process.argv.includes('--apply')) {
    throw new Error('No data was written. Re-run with --apply and explicit --rows and --run-id after reviewing the target.');
  }
  await generate(parseRunId(option('run-id')), parseRows(option('rows')));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closePool);
