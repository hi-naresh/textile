import pool from './db';
import { LedgerError } from './ledger-error';

// Per-process admission control: long import transactions/export snapshots must
// not occupy the entire shared pool. Other requests still need auth/read queries.
const capacity = Math.max(1, Math.floor((pool.options.max ?? 10) / 2));
let active = 0;
const waiting: (() => void)[] = [];

export function acquireBulkSlot(signal?: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const i = waiting.indexOf(grant);
      if (i >= 0) waiting.splice(i, 1);
    };
    const abort = () => { cleanup(); reject(signal?.reason ?? new Error('Request cancelled.')); };
    const grant = () => {
      cleanup();
      active++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        active--;
        waiting[0]?.();
      });
    };
    if (signal?.aborted) { abort(); return; }
    if (active < capacity) { grant(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      reject(new LedgerError('Imports and exports are busy. Try again shortly.', 503));
    }, 60_000);
    timer.unref();
    waiting.push(grant);
  });
}

export async function withBulkOperation<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const release = await acquireBulkSlot(signal);
  try { return await fn(); } finally { release(); }
}
