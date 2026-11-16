import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Q } from './db';
import type { ValidateResult } from './stock-import';
import type { RegOutRow } from './register-import';
import { resolveReview } from './import-status-review';
import { LedgerError } from './ledger-error';

const fileHash = (file: Buffer) => createHash('sha256').update(file).digest('hex');

export async function createImportReview(q: Q, userId: string, file: Buffer, result: ValidateResult) {
  if (!result.ok || result.format !== 'outgoing' || !result.rows?.length) return;
  const id = randomUUID();
  await q('DELETE FROM stock_import_reviews WHERE expires_at < now()');
  await q('INSERT INTO stock_import_reviews (id, user_id, batch, file_hash, rows) VALUES ($1, $2, $3, $4, $5::jsonb)',
    [id, userId, result.batch, fileHash(file), JSON.stringify(result.rows)]);
  return id;
}

async function getReview(q: Q, id: unknown, userId: string) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new LedgerError('Review and confirm the file before importing.', 409);
  const result = await q('SELECT * FROM stock_import_reviews WHERE id = $1 AND user_id = $2 AND expires_at > now() FOR UPDATE', [id, userId]);
  if (!result.rows.length) throw new LedgerError('This review has expired or is unavailable. Check the file again.', 409);
  return result.rows[0];
}

// Caller supplies a transaction so concurrent confirmation/commit cannot change the plan.
export async function confirmImportReview(q: Q, id: unknown, userId: string, file: Buffer, choices: unknown) {
  const review = await getReview(q, id, userId);
  if (fileHash(file) !== review.file_hash) throw new LedgerError('The file changed after review. Upload it again and review the new statuses.', 409);
  const rows = resolveReview(review.rows as RegOutRow[], choices);
  if (review.confirmed_rows && !isDeepStrictEqual(rows, review.confirmed_rows)) throw new LedgerError('This import was already confirmed with different statuses. Check the file again.', 409);
  await q('UPDATE stock_import_reviews SET confirmed_rows = $2::jsonb WHERE id = $1', [id, JSON.stringify(rows)]);
  return { batch: review.batch as string, rows };
}

export async function verifyImportChunk(q: Q, id: unknown, userId: string, batch: string, rows: unknown[]) {
  const review = await getReview(q, id, userId);
  const confirmed = review.confirmed_rows as RegOutRow[] | null;
  if (!confirmed || review.batch !== batch) throw new LedgerError('Review and confirm this file before importing.', 409);
  const first = rows[0] as Partial<RegOutRow> | null;
  const start = confirmed.findIndex((r) => r.row === first?.row);
  if (start < 0 || start > review.committed_count || !isDeepStrictEqual(confirmed.slice(start, start + rows.length), rows)) {
    throw new LedgerError('The rows changed or are out of order after review. Check the file again.', 409);
  }
  // Updated in the same transaction as the ledger: a failed chunk also rolls this back.
  await q('UPDATE stock_import_reviews SET committed_count = GREATEST(committed_count, $2) WHERE id = $1', [id, start + rows.length]);
}
