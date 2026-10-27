import { Writable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { closePool, pool } from './db';
import { ledgerExportRows } from '../../src/lib/ledger-query';
import { streamChallanWorkbook } from '../../src/lib/stock-import';

function runIdFromArgs(): string {
  const value = process.argv.find((arg) => arg.startsWith('--run-id='))?.slice('--run-id='.length);
  if (!value || !/^[a-zA-Z0-9-]{1,30}$/.test(value)) throw new Error('Pass --run-id=<1-30 letters, numbers, or hyphens>.');
  return value.toLowerCase();
}

async function main() {
  const runId = runIdFromArgs();
  const lotId = `STRESS-${runId}`.toUpperCase();
  const fixture = await pool.query(
    `SELECT COUNT(*)::int AS rows FROM stock_movements WHERE lot_id = $1 AND import_ref LIKE $2`,
    [lotId, `stress:${runId}:%`],
  );
  const expectedRows = Number(fixture.rows[0]?.rows ?? 0);
  if (!expectedRows) throw new Error(`No generated stress fixture found for ${runId}.`);

  const filters = { q: null, direction: null, status: null, quality: null, design: null, lot: lotId, party: null, from: null, to: null };
  let exportedRows = 0;
  let bytes = 0;
  let peakHeap = process.memoryUsage().heapUsed;
  const startHeap = peakHeap;
  const sampleHeap = setInterval(() => {
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }, 100);
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback();
    },
  });
  async function* rows() {
    for await (const row of ledgerExportRows((text, params) => pool.query(text, params), filters)) {
      exportedRows++;
      yield row;
    }
  }

  const started = performance.now();
  try {
    await streamChallanWorkbook('Stress test', sink, rows());
  } finally {
    clearInterval(sampleHeap);
  }
  const elapsedMs = performance.now() - started;
  console.log(JSON.stringify({
    run_id: runId,
    expected_rows: expectedRows,
    exported_rows: exportedRows,
    bytes,
    elapsed_ms: Math.round(elapsedMs),
    rows_per_second: Math.round(exportedRows * 1000 / elapsedMs),
    start_heap_bytes: startHeap,
    peak_heap_bytes: peakHeap,
    heap_growth_bytes: peakHeap - startHeap,
    complete: exportedRows === expectedRows,
  }, null, 2));
  if (exportedRows !== expectedRows || bytes === 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closePool);
