// Runs the agents' scans. Triggers:
//   auto   — GET /api/agents/suggestions, at most every MIN_GAP_MS (or right after a change marked them stale);
//            runs in the background, never holding up the request for more than a short budget.
//   cron   — Vercel cron, daily (vercel.json → GET /api/agents/run with CRON_SECRET).
//   manual — "Run now" in the developer console (all agents or one) / POST /api/agents/run (owner).
// Each agent runs in its own transaction so one failing agent never blocks the others; every run is logged in
// agent_runs (time, duration, error, open cards after). Switched-off agents don't scan and their open cards close.
import { query, withTransaction } from '../db';
import { AGENTS } from './registry';
import { agentSettings } from './settings';
import { resolveAgent } from './suggest';
import type { AgentKey } from './types';

const MIN_GAP_MS = 5 * 60 * 1000;

export type RunTrigger = 'auto' | 'cron' | 'manual';
export interface RunResult { ran: boolean; results: Record<string, string> }

let inFlight: Promise<RunResult> | null = null;

async function logRun(agent: AgentKey, trigger: RunTrigger, ms: number, error: string | null): Promise<void> {
  try {
    await query(
      `INSERT INTO agent_runs (agent, trigger, started_at, duration_ms, ok, error, open_after)
       VALUES ($1, $2, now() - ($3::int * interval '1 millisecond'), $3, $4, $5,
               (SELECT count(*) FROM agent_suggestions WHERE agent = $6 AND status = 'open'))`,
      [agent, trigger, ms, !error, error, agent],
    );
  } catch (e) {
    console.error('[agents] could not log run', e);
  }
}

async function runOnce(opts: { force: boolean; only?: AgentKey; trigger: RunTrigger }): Promise<RunResult> {
  if (!opts.only) {
    // Claim the run atomically so parallel requests / server instances don't all scan.
    const claim = await query(
      `UPDATE app_settings SET agents_ran_at = NOW()
       WHERE id = 1 AND ($1::boolean OR agents_ran_at IS NULL OR agents_ran_at < NOW() - ($2::int * interval '1 millisecond'))
       RETURNING id`,
      [opts.force, MIN_GAP_MS],
    );
    if (!claim.rowCount) return { ran: false, results: {} };
  }
  const settings = await agentSettings();
  const results: Record<string, string> = {};
  for (const [key, mod] of Object.entries(AGENTS) as [AgentKey, (typeof AGENTS)[AgentKey]][]) {
    if (opts.only && key !== opts.only) continue;
    if (!mod.scan) continue;
    if (!settings[key].enabled) {
      const closed = await resolveAgent(query, key).catch(() => 0);
      results[key] = `off${closed ? ` (closed ${closed} open card${closed === 1 ? '' : 's'})` : ''}`;
      continue;
    }
    const t0 = Date.now();
    try {
      await withTransaction((q) => mod.scan!(q));
      results[key] = `ok ${Date.now() - t0}ms`;
      await logRun(key, opts.trigger, Date.now() - t0, null);
    } catch (e) {
      console.error(`[agents] ${key} scan failed`, e);
      const msg = `${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
      results[key] = `failed: ${msg}`.slice(0, 200);
      await logRun(key, opts.trigger, Date.now() - t0, msg);
    }
  }
  if (opts.trigger === 'cron') await query(`DELETE FROM agent_runs WHERE started_at < now() - interval '90 days'`).catch(() => {});
  return { ran: true, results };
}

/**
 * Run the scans. `force` ignores the 5-minute gap; `only` runs one agent (always, no claim).
 * Calls made while a full run is already going in this server share it instead of starting a second one.
 */
export function runAgents(opts: { force?: boolean; only?: AgentKey; trigger?: RunTrigger } = {}): Promise<RunResult> {
  const o = { force: !!opts.force, only: opts.only, trigger: opts.trigger ?? 'auto' };
  if (o.only) return runOnce(o);
  if (inFlight) return inFlight;
  inFlight = runOnce(o).finally(() => { inFlight = null; });
  return inFlight;
}

/** True when a scan is due (never ran, marked stale by a change, or older than the gap). One tiny query. */
export async function agentsDue(): Promise<boolean> {
  const r = await query(
    `SELECT (agents_ran_at IS NULL OR agents_ran_at < NOW() - ($1::int * interval '1 millisecond')) AS due FROM app_settings WHERE id = 1`,
    [MIN_GAP_MS],
  );
  return !!r.rows[0]?.due;
}
