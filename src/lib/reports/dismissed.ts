// Shared by the Inventory and Reports agents: which alerts a person dismissed recently, so a scan
// every few minutes doesn't put back an alert someone just closed.
import type { Q } from '../db';

/** Dedupe keys among `keys` that were accepted / rejected within the last `days` days. */
export async function recentlyDecided(q: Q, keys: string[], days: number): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const r = await q(
    `SELECT DISTINCT dedupe_key FROM agent_suggestions
     WHERE dedupe_key = ANY($1::text[]) AND status IN ('accepted', 'rejected') AND decided_at > NOW() - ($2::int * interval '1 day')`,
    [keys, days],
  );
  return new Set(r.rows.map((x) => String(x.dedupe_key)));
}
