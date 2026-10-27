'use client';

// Browser side of the Excel import: check the file, then send the checked rows in chunks with progress.
import type { AnyImportRow, FixFile, ValidateResult } from './stock-import';

export type { AnyImportRow, FixFile, ValidateResult };
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

const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 30_000;

async function postChunk(batch: string, rows: AnyImportRow[]) {
  const res = await fetch('/api/stock/import/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batch, rows }) });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function transientStatus(status: number) {
  return status === 429 || status >= 500;
}

function retryDelay(res: Response, retry: number) {
  const retryAfter = res.headers.get('Retry-After');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const requestedMs = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(requestedMs)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, requestedMs));
  }
  return Math.min(MAX_RETRY_AFTER_MS, 800 * 2 ** retry);
}

/**
 * Send rows in order, CHUNK_SIZE at a time; each chunk is saved all-or-nothing on the server.
 * Network failures, 429s and server errors are retried twice (safe: the server skips rows it already saved).
 * Stops at the first non-retryable or exhausted chunk failure.
 */
export async function commitImport(batch: string, rows: AnyImportRow[], onProgress: (p: ImportProgress) => void, shouldStop?: () => boolean): Promise<ImportOutcome> {
  const p: ImportProgress = { done: 0, total: rows.length, saved: 0, skipped: 0, in: 0, out: 0 };
  onProgress({ ...p });
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const range = { from: chunk[0].row, to: chunk[chunk.length - 1].row };
    if (shouldStop?.()) return { ...p, ok: false, error: 'Stopped. Rows already saved stay saved.', failedChunk: range };
    let retry = 0;
    for (;;) {
      let response: Awaited<ReturnType<typeof postChunk>>;
      try {
        response = await postChunk(batch, chunk);
      } catch {
        if (retry >= MAX_RETRIES) return { ...p, ok: false, error: 'Network problem. Check the connection and import the same file again — rows already saved will not be added twice.', failedChunk: range };
        await new Promise((resolve) => setTimeout(resolve, 800 * 2 ** retry));
        retry++;
        continue;
      }
      const { res, data } = response;
      if (res.ok) {
        p.saved += data.saved; p.skipped += data.skipped; p.in += data.in; p.out += data.out;
        break;
      }
      if (!transientStatus(res.status) || retry >= MAX_RETRIES) {
        return { ...p, ok: false, error: data?.error || 'This part of the file could not be saved.', failedRow: data?.row, failedChunk: range };
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelay(res, retry)));
      retry++;
    }
    p.done += chunk.length;
    onProgress({ ...p });
  }
  return { ...p, ok: true };
}

/** "Rows to fix": the skipped rows as an Excel file (same columns as the uploaded file + why each was skipped). */
export async function downloadFixFile(fileName: string, fix: FixFile) {
  const res = await fetch('/api/stock/import/fix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: fileName, ...fix }) });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || 'Could not make the file.');
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = `rows-to-fix-${fileName.replace(/\.xlsx$/i, '')}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
