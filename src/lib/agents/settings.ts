// Per-agent on/off switch and settings (agent_settings, migration 011). No row = the catalog default.
// Read by the runner (a switched-off agent doesn't scan and its open cards are closed), by
// GET /api/agents/suggestions (cards of switched-off agents are never listed; max cards per agent) and
// by the developer console (Agents tab).
import { query, type Q } from '../db';
import type { AgentKey } from './types';
import { AGENT_CATALOG, DEFAULT_MAX_OPEN } from './catalog';

export interface AgentSetting { enabled: boolean; maxOpen: number; updatedAt: string | null; updatedBy: string | null; isDefault: boolean }

export async function agentSettings(q: Q = query): Promise<Record<AgentKey, AgentSetting>> {
  let rows: Record<string, unknown>[] = [];
  try {
    rows = (await q(`SELECT agent, enabled, settings, updated_at, updated_by FROM agent_settings`)).rows;
  } catch {
    rows = []; // before migration 011: defaults
  }
  const by = new Map(rows.map((r) => [String(r.agent), r]));
  const out = {} as Record<AgentKey, AgentSetting>;
  for (const a of AGENT_CATALOG) {
    const r = by.get(a.key);
    const st = (r?.settings ?? {}) as Record<string, unknown>;
    const max = Number(st.max_open);
    out[a.key] = {
      enabled: r ? !!r.enabled : a.defaultEnabled,
      maxOpen: Number.isInteger(max) && max >= 1 && max <= 50 ? max : DEFAULT_MAX_OPEN,
      updatedAt: r?.updated_at ? new Date(r.updated_at as string).toISOString() : null,
      updatedBy: (r?.updated_by as string) ?? null,
      isDefault: !r,
    };
  }
  return out;
}

export async function setAgentSetting(q: Q, agent: AgentKey, change: { enabled?: boolean; maxOpen?: number }, by: string): Promise<void> {
  const cur = (await agentSettings(q))[agent];
  const enabled = change.enabled ?? cur.enabled;
  const maxOpen = change.maxOpen ?? cur.maxOpen;
  await q(
    `INSERT INTO agent_settings (agent, enabled, settings, updated_at, updated_by) VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (agent) DO UPDATE SET enabled = EXCLUDED.enabled, settings = agent_settings.settings || EXCLUDED.settings,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [agent, enabled, JSON.stringify({ max_open: maxOpen }), by.slice(0, 80)],
  );
}
