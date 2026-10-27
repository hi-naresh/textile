import { performance } from 'node:perf_hooks';
import type { ValidateResult } from '../../src/lib/stock-import';

export interface WorkloadUser { cookie: string; file: Uint8Array<ArrayBuffer>; lot: string }
export type Send = (path: string, init: RequestInit) => Promise<Response>;

export async function runImportWorkload(send: Send, users: WorkloadUser[], validationRuns: number) {
  const timings: Record<string, number[]> = {};
  const failures: { operation: string; message: string }[] = [];
  const statuses: Record<string, number> = {};
  async function measure<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try { return await fn(); }
    catch (error) {
      failures.push({ operation, message: error instanceof Error ? error.message : 'Failed' });
      throw error;
    } finally { (timings[operation] ??= []).push(performance.now() - start); }
  }
  async function request(path: string, init: RequestInit) {
    const response = await send(path, init);
    statuses[response.status] = (statuses[response.status] ?? 0) + 1;
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${path.split('?')[0]} returned HTTP ${response.status}`);
    }
    return response;
  }
  const read = (u: WorkloadUser, operation: string) => measure(operation, async () => {
    const response = await request(`/api/stock/ledger?limit=25&lot=${encodeURIComponent(u.lot)}`, { headers: { cookie: u.cookie } });
    await response.json();
  });
  const exportFile = (u: WorkloadUser) => measure('export', async () => {
    const response = await request(`/api/stock/export?kind=challans&lot=${encodeURIComponent(u.lot)}`, { headers: { cookie: u.cookie } });
    const reader = response.body!.getReader();
    let bytes = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
    }
    if (!bytes) throw new Error('Export returned an empty file.');
  });
  const started = performance.now();
  let imported = 0;
  const results = await Promise.allSettled(users.map(async (u) => {
    await read(u, 'read_before_import');
    let checked: ValidateResult | undefined;
    for (let i = 0; i < validationRuns; i++) {
      checked = await measure('validation', async () => {
        const form = new FormData();
        form.append('file', new File([u.file], 'workload.xlsx'));
        const response = await request('/api/stock/import', { method: 'POST', headers: { cookie: u.cookie }, body: form });
        const data = await response.json() as ValidateResult;
        if (!data.ok || !data.batch || !data.rows?.length) throw new Error('Workbook validation failed or has no unsaved rows. Use a fresh fixture.');
        return data;
      });
    }
    const { batch, rows } = checked!;
    for (let offset = 0; offset < rows!.length; offset += 500) {
      const chunk = rows!.slice(offset, offset + 500);
      // All probes start alongside the commit, so read latency includes import contention.
      const operations = [measure('commit', async () => {
        const response = await request('/api/stock/import/commit', {
          method: 'POST', headers: { cookie: u.cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ batch, rows: chunk }),
        });
        const result = await response.json();
        if (result.saved !== chunk.length || result.skipped !== 0) throw new Error('Unexpected commit counts.');
        imported += result.saved;
      }), read(u, 'read_during_import')];
      if (offset % 5000 === 0 || offset + 500 >= rows!.length) operations.push(exportFile(u));
      const outcomes = await Promise.allSettled(operations);
      const failure = outcomes.find((r) => r.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    }
  }));
  const duration = performance.now() - started;
  return {
    users: users.length, validation_runs_per_user: validationRuns, imported_rows: imported,
    elapsed_ms: Math.round(duration), rows_per_second_including_validation_and_probes: Math.round(imported * 1000 / duration),
    failed_users: results.filter((r) => r.status === 'rejected').length, failures, statuses,
    timings: Object.fromEntries(Object.entries(timings).map(([name, values]) => {
      values.sort((a, b) => a - b);
      const p = (q: number) => Math.round(values[Math.max(0, Math.ceil(values.length * q) - 1)]);
      return [name, { samples: values.length, p50_ms: p(0.5), p95_ms: p(0.95), max_ms: p(1) }];
    })),
  };
}
