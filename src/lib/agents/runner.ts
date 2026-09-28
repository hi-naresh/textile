// Runs every agent's scan, at most once every few minutes (called when the app loads the
// attention list, and daily by Vercel Cron). Each agent runs in its own transaction so one
// failing agent never blocks the others.
import { query, withTransaction } from '../db';
import { AGENTS } from './registry';
import type { AgentKey } from './types';

const MIN_GAP_MS = 5 * 60 * 1000;

export async function runAgents(force = false): Promise<{ ran: boolean; results: Record<string, string> }> {
  // Claim the run atomically so parallel requests don't all scan.
  const claim = await query(
    `UPDATE app_settings SET agents_ran_at = NOW()
     WHERE id = 1 AND ($1::boolean OR agents_ran_at IS NULL OR agents_ran_at < NOW() - ($2::int * interval '1 millisecond'))
     RETURNING id`,
    [force, MIN_GAP_MS],
  );
  if (!claim.rowCount) return { ran: false, results: {} };
  const results: Record<string, string> = {};
  for (const [key, mod] of Object.entries(AGENTS) as [AgentKey, (typeof AGENTS)[AgentKey]][]) {
    if (!mod.scan) continue;
    const t0 = Date.now();
    try {
      await withTransaction((q) => mod.scan!(q));
      results[key] = `ok ${Date.now() - t0}ms`;
    } catch (e) {
      console.error(`[agents] ${key} scan failed`, e);
      results[key] = `failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
    }
  }
  return { ran: true, results };
}
