import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import pool, { query } from '../../src/lib/db';
import { createSession } from '../../src/lib/auth/session';
import { POST as validate } from '../../src/app/api/stock/import/route';
import { POST as commit } from '../../src/app/api/stock/import/commit/route';
import { GET as exportStock } from '../../src/app/api/stock/export/route';
import { GET as ledger } from '../../src/app/api/stock/ledger/route';
import { IMPORT_SHEET, TEMPLATE_COLUMNS, newBook } from '../../src/lib/stock-import';
import { toBuffer } from '../../src/lib/excel';
import { runImportWorkload, type WorkloadUser } from './import-workload';

const url = new URL(process.env.DATABASE_URL || 'postgresql://localhost/invalid');
if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname) || !url.pathname.endsWith('_test')) {
  throw new Error('Use a disposable local DATABASE_URL ending in _test. No .env files are loaded.');
}
process.env.DB_QUIET = '1';
function option(name: string, fallback: number, max: number) {
  const raw = process.argv.find((v) => v.startsWith(`--${name}=`))?.split('=')[1];
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name} must be 1..${max}`);
  return n;
}
async function main() {
  const count = option('users', 1, 20);
  const rows = option('rows', 1000, 20_000);
  const repetitions = option('validation-runs', 3, 20);
  const runId = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const lotIds: string[] = [];
  const users: WorkloadUser[] = [];
  let sampler: ReturnType<typeof setInterval> | undefined;
  try {
    for (let i = 0; i < count; i++) {
      const id = `load-${runId}-${i}`;
      userIds.push(id);
      await query("INSERT INTO users (id, name, role) VALUES ($1, 'Local workload owner', 'owner')", [id]);
      const cookie = `tb_at=${(await createSession(query, id, 'client', new NextRequest('http://localhost/'))).tokens.access}`;
      const lot = `LOAD-${runId}-${i}`.toUpperCase();
      lotIds.push(lot);
      const wb = newBook('Local workload');
      const ws = wb.addWorksheet(IMPORT_SHEET);
      ws.columns = TEMPLATE_COLUMNS.map((c) => ({ header: c.header, key: c.key }));
      for (let n = 0; n < rows; n++) ws.addRow({
        direction: 'IN', lot_id: lot, quality: 'Load test', design: 'Synthetic', finished_meters: 1, mill_name: 'Load test mill',
      });
      users.push({ cookie, lot, file: new Uint8Array(await toBuffer(wb)) });
    }
    const baselineHeap = process.memoryUsage().heapUsed;
    let peakHeap = baselineHeap, peakRss = process.memoryUsage().rss, peakConnections = 0, peakWaiting = 0;
    sampler = setInterval(() => {
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      peakConnections = Math.max(peakConnections, pool.totalCount);
      peakWaiting = Math.max(peakWaiting, pool.waitingCount);
    }, 20);
    const result = await runImportWorkload(async (path, init) => {
      const req = new NextRequest(`http://localhost${path}`, { ...init, signal: init.signal ?? undefined });
      if (path === '/api/stock/import') return validate(req);
      if (path === '/api/stock/import/commit') return commit(req);
      if (path.startsWith('/api/stock/export?')) return exportStock(req);
      return ledger(req);
    }, users, repetitions);
    const balances = await query(
      `SELECT l.lot_id, l.bal_m, COUNT(sm.id)::int AS movements,
              COALESCE(SUM(CASE WHEN sm.direction = 'IN' THEN sm.meters ELSE -sm.meters END), 0) AS actual
       FROM lots l LEFT JOIN stock_movements sm ON sm.lot_id = l.lot_id
       WHERE l.lot_id = ANY($1::text[]) GROUP BY l.lot_id`, [lotIds],
    );
    const reconciled = balances.rows.length === count && balances.rows.every((r) =>
      Number(r.bal_m) === rows && Number(r.actual) === rows && r.movements === rows);
    console.log(JSON.stringify({
      environment: 'local authenticated route handlers (no HTTP or hosted platform)', run_id: runId,
      rows_per_user: rows, ...result, reconciled,
      sampled: { baseline_heap_bytes: baselineHeap, peak_heap_bytes: peakHeap, peak_rss_bytes: peakRss, peak_pool_connections: peakConnections, peak_pool_waiting: peakWaiting },
    }, null, 2));
    if (result.failed_users || !reconciled) process.exitCode = 1;
  } finally {
    clearInterval(sampler);
    await query('DELETE FROM lot_locations WHERE lot_id = ANY($1::text[])', [lotIds]);
    await query('DELETE FROM stock_movements WHERE lot_id = ANY($1::text[])', [lotIds]);
    await query('DELETE FROM lots WHERE lot_id = ANY($1::text[])', [lotIds]);
    await query('DELETE FROM api_rate_limits WHERE user_id = ANY($1::text[])', [userIds]);
    await query('DELETE FROM auth_audit WHERE actor_id = ANY($1::text[])', [userIds]);
    await query('DELETE FROM auth_sessions WHERE user_id = ANY($1::text[])', [userIds]);
    await query('DELETE FROM users WHERE id = ANY($1::text[])', [userIds]);
    await pool.end();
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
