import type { Q } from '../db';

/** Data the agents read has changed: the next suggestions request re-scans instead of waiting out the throttle. */
export async function markAgentsStale(q: Q): Promise<void> {
  await q(`UPDATE app_settings SET agents_ran_at = NULL WHERE id = 1 AND agents_ran_at IS NOT NULL`);
}
