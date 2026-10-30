import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { NextRequest } from 'next/server';
import { createDisposableDatabase } from './disposable-database';

async function main() {
  const raw = process.argv.find((a) => a.startsWith('--rows='))?.slice(7);
  const rows = Number(raw);
  if (!raw || !/^\d+$/.test(raw) || rows < 1 || rows > 1_000_000) throw new Error('Pass --rows=1..1000000.');
  const isolated = await createDisposableDatabase('resetbench');
  process.env.DATABASE_URL = isolated.url;
  process.env.DB_QUIET = '1';
  const db = await import('../../src/lib/db');
  const route = await import('../../src/app/api/reset/route');
  const { hashPassword } = await import('../../src/lib/auth/password');
  const { createSession } = await import('../../src/lib/auth/session');
  let sampler: ReturnType<typeof setInterval> | undefined;
  try {
    const password = 'Disposable-reset-benchmark-52819';
    const lot = 'STRESS-RESET-BENCH';
    await db.query("INSERT INTO users (id, name, role, password_hash) VALUES ('benchmark-owner', 'Benchmark owner', 'owner', $1)", [await hashPassword(password)]);
    const cookie = `tb_at=${(await createSession(db.query, 'benchmark-owner', 'client', new NextRequest('http://localhost/'))).tokens.access}`;
    await db.query("INSERT INTO lots (lot_id, quality, design) VALUES ($1, 'Benchmark', 'Synthetic')", [lot]);
    const generateStart = performance.now();
    for (let start = 1; start <= rows; start += 10000) {
      await db.query(`INSERT INTO stock_movements (lot_id, direction, meters, mill_name, party)
        SELECT $1, CASE WHEN n % 3 = 0 THEN 'OUT' ELSE 'IN' END, 1,
        CASE WHEN n % 3 <> 0 THEN 'Benchmark mill' ELSE NULL END,
        CASE WHEN n % 3 = 0 THEN 'Benchmark party' ELSE NULL END
        FROM generate_series($2::int, $3::int) n`, [lot, start, Math.min(rows, start + 9999)]);
    }
    await db.query("INSERT INTO lot_closures (lot_id, action, reason) VALUES ($1, 'reopen', 'manual')", [lot]);
    const generatedMs = performance.now() - generateStart;
    const expectedBalance = rows - 2 * Math.floor(rows / 3);
    const actual = (await db.query(`SELECT l.bal_m, COUNT(sm.id)::int AS n,
      SUM(CASE WHEN direction = 'IN' THEN meters ELSE -meters END) AS calculated
      FROM lots l JOIN stock_movements sm ON sm.lot_id = l.lot_id WHERE l.lot_id = $1 GROUP BY l.lot_id`, [lot])).rows[0];
    assert.equal(actual.n, rows);
    assert.equal(Number(actual.bal_m), expectedBalance);
    assert.equal(Number(actual.calculated), expectedBalance);
    let peakHeap = process.memoryUsage().heapUsed, peakRss = process.memoryUsage().rss;
    sampler = setInterval(() => {
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 20);
    const backupStart = performance.now();
    const backup = await route.GET(new NextRequest('http://localhost/api/reset?backup=stock', { headers: { cookie } }));
    assert.equal(backup.status, 200);
    const reader = backup.body!.getReader();
    let bytes = 0, seenLotRows = 0, carry = '', ending = '';
    const needle = `"lot_id":"${lot}"`;
    const decoder = new TextDecoder();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      const text = carry + decoder.decode(next.value, { stream: true });
      seenLotRows += text.split(needle).length - 1;
      carry = text.slice(-(needle.length - 1));
      ending = text.slice(-20);
    }
    assert.ok(ending.endsWith('}}'));
    // One lot, all movements, and one closure; count without retaining the JSON.
    assert.equal(seenLotRows, rows + 2);
    const backupMs = performance.now() - backupStart;
    const resetStart = performance.now();
    const response = await route.POST(new NextRequest('http://localhost/api/reset', {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts: ['stock'], confirm: 'RESET', password }),
    }));
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.removed.stock, rows + 2);
    const resetMs = performance.now() - resetStart;
    for (const table of ['stock_movements', 'lots', 'lot_closures', 'lot_locations', 'job_cards', 'allocations', 'known_names', 'lot_facets']) {
      assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n, 0);
    }
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM auth_audit WHERE event = 'data.reset'")).rows[0].n, 1);
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM users WHERE id = 'benchmark-owner'")).rows[0].n, 1);
    console.log(JSON.stringify({ environment: 'new disposable local database; authenticated route handlers, no HTTP',
      rows, generated_ms: Math.round(generatedMs), balance_before: expectedBalance, reconciled_before: true,
      backup_ms: Math.round(backupMs), backup_bytes: bytes, backup_lot_rows: seenLotRows,
      reset_ms: Math.round(resetMs), removed_stock_records: result.removed.stock,
      reconciled_after: true, audit_records: 1, peak_heap_bytes: peakHeap, peak_rss_bytes: peakRss }, null, 2));
  } finally {
    clearInterval(sampler);
    await db.default.end();
    await isolated.cleanup();
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
