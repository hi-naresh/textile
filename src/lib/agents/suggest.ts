// Raise / resolve agent suggestions (alerts + suggested actions). Idempotent by dedupe_key:
// raising the same open problem again only refreshes its text; fixing it resolves it.
import type { Q } from '../db';
import type { AgentKey, SuggestionInput } from './types';

/** Don't bring back something a person accepted or dismissed in the last day (agents may snooze longer themselves). */
const QUIET_HOURS = 24;

export async function suggest(q: Q, s: SuggestionInput): Promise<void> {
  const decided = await q(
    `SELECT 1 FROM agent_suggestions WHERE dedupe_key = $1 AND status IN ('accepted', 'rejected') AND decided_at > NOW() - ($2::int * interval '1 hour') LIMIT 1`,
    [s.dedupeKey, QUIET_HOURS],
  );
  if (decided.rowCount) return;
  await q(
    `INSERT INTO agent_suggestions (agent, kind, severity, title, detail, payload, target_type, target_id, action_label, owner_only, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (dedupe_key) WHERE status = 'open'
     DO UPDATE SET severity = EXCLUDED.severity, title = EXCLUDED.title, detail = EXCLUDED.detail, payload = EXCLUDED.payload,
                   action_label = EXCLUDED.action_label, owner_only = EXCLUDED.owner_only, updated_at = CURRENT_TIMESTAMP`,
    [s.agent, s.kind, s.severity ?? 'info', s.title, s.detail ?? null, s.payload ? JSON.stringify(s.payload) : null,
     s.target?.type ?? null, s.target ? String(s.target.id) : null, s.actionLabel ?? null, !!s.ownerOnly, s.dedupeKey],
  );
}

/** Mark one problem as fixed. */
export async function resolve(q: Q, dedupeKey: string): Promise<void> {
  await q(`UPDATE agent_suggestions SET status = 'resolved', updated_at = CURRENT_TIMESTAMP WHERE dedupe_key = $1 AND status = 'open'`, [dedupeKey]);
}

/**
 * After a scan: resolve this agent's open suggestions of `kind` that the scan no longer raised.
 * Call with the dedupe keys the scan just raised.
 */
export async function resolveMissing(q: Q, agent: AgentKey, kind: string, stillOpen: string[]): Promise<void> {
  await q(
    `UPDATE agent_suggestions SET status = 'resolved', updated_at = CURRENT_TIMESTAMP
     WHERE agent = $1 AND kind = $2 AND status = 'open' AND NOT (dedupe_key = ANY($3::text[]))`,
    [agent, kind, stillOpen],
  );
}
