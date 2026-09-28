// Technical error details go to app_errors (developer console → Errors), never to the client.
// Clients only ever see a plain message such as "Something went wrong, try again."
import { query } from './db';

export const PLAIN_ERROR = 'Something went wrong, try again.';

/** Records an unexpected error. Never throws. */
export function logError(source: string, err: unknown, detail?: Record<string, unknown>): void {
  console.error(`[${source}]`, err);
  const e = err instanceof Error ? err : new Error(String(err));
  query(`INSERT INTO app_errors (source, message, stack, detail) VALUES ($1, $2, $3, $4)`, [
    source.slice(0, 100),
    e.message.slice(0, 2000) || 'Unknown error',
    e.stack?.slice(0, 8000) ?? null,
    detail ? JSON.stringify(detail).slice(0, 8000) : null,
  ]).catch(() => { /* the database itself may be what failed */ });
}
