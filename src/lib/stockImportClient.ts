'use client';

// Browser side of the Excel import: check the file, then send the checked rows in chunks with progress.
import type { ImportRow, ValidateResult } from './stock-import';

export type { ImportRow, ValidateResult };
export const CHUNK_SIZE = 500;

export async function checkImportFile(file: File): Promise<ValidateResult> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/stock/import', { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Could not check the file.');
  return data as ValidateResult;
}

export interface ImportProgress { done: number; total: number; saved: number; skipped: number; in: number; out: number }
export interface ImportOutcome extends ImportProgress { ok: boolean; error?: string; failedRow?: number; failedChunk?: { from: number; to: number } }

async function postChunk(batch: string, rows: ImportRow[]) {
  const res = await fetch('/api/stock/import/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batch, rows }) });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

/**
 * Send rows in order, CHUNK_SIZE at a time; each chunk is saved all-or-nothing on the server.
 * A network failure is retried twice (safe: the server skips rows it already saved). Stops at the first failing chunk.
 */
export async function commitImport(batch: string, rows: ImportRow[], onProgress: (p: ImportProgress) => void, shouldStop?: () => boolean): Promise<ImportOutcome> {
  const p: ImportProgress = { done: 0, total: rows.length, saved: 0, skipped: 0, in: 0, out: 0 };
  onProgress({ ...p });
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const range = { from: chunk[0].row, to: chunk[chunk.length - 1].row };
    if (shouldStop?.()) return { ...p, ok: false, error: 'Stopped. Rows already saved stay saved.', failedChunk: range };
    let attempt = 0;
    for (;;) {
      try {
        const { res, data } = await postChunk(batch, chunk);
        if (!res.ok) return { ...p, ok: false, error: data?.error || 'This part of the file could not be saved.', failedRow: data?.row, failedChunk: range };
        p.saved += data.saved; p.skipped += data.skipped; p.in += data.in; p.out += data.out;
        break;
      } catch {
        if (++attempt > 2) return { ...p, ok: false, error: 'Network problem. Check the connection and import the same file again — rows already saved will not be added twice.', failedChunk: range };
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
    p.done += chunk.length;
    onProgress({ ...p });
  }
  return { ...p, ok: true };
}
