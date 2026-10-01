import { NextRequest, NextResponse } from 'next/server';
import { query, withTransaction } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { readObject, requireDeveloper } from '@/lib/apiAuth';
import { audit } from '@/lib/auth/audit';
import { AGENT_CATALOG, AGENT_INFO, isAgentKey } from '@/lib/agents/catalog';
import { AGENTS } from '@/lib/agents/registry';
import { runAgents } from '@/lib/agents/runner';
import { agentSettings, setAgentSetting } from '@/lib/agents/settings';
import { markAgentsStale } from '@/lib/agents/stale';
import { resolveAgent } from '@/lib/agents/suggest';

// Developer console → Agents. Times: agent_suggestions / app_settings use `timestamp without time zone` (written in the
// database session's zone), so they are turned into real instants in SQL — otherwise a server whose own zone differs
// (e.g. Europe/London) shifts them by an hour. agent_runs is timestamptz already.
// Developer console → Agents.
// GET → { agents: [catalog info + on/off + max open + last run + run stats + card stats (7 / 30 days) + recent cards], ran_at }
// PUT { agent, enabled?: boolean, max_open?: 1–50 } → switch an agent on / off, or change how many cards it may show.
//     Switching off closes its open cards at once; switching on runs it straight away.
// POST { agent? } → run now (one agent, or all when omitted). → { results }
export async function GET(req: NextRequest) {
  try {
    await requireDeveloper(req);
    const [settings, stats, runs, last, recent, ranAt] = await Promise.all([
      agentSettings(),
      query(
        `SELECT agent,
                count(*) FILTER (WHERE created_at > now() - interval '7 days') AS raised_7,
                count(*) FILTER (WHERE created_at > now() - interval '30 days') AS raised_30,
                count(*) FILTER (WHERE status = 'accepted' AND decided_at > now() - interval '7 days') AS accepted_7,
                count(*) FILTER (WHERE status = 'accepted' AND decided_at > now() - interval '30 days') AS accepted_30,
                count(*) FILTER (WHERE status = 'rejected' AND decided_at > now() - interval '7 days') AS dismissed_7,
                count(*) FILTER (WHERE status = 'rejected' AND decided_at > now() - interval '30 days') AS dismissed_30,
                count(*) FILTER (WHERE status = 'resolved' AND updated_at > now() - interval '7 days') AS resolved_7,
                count(*) FILTER (WHERE status = 'resolved' AND updated_at > now() - interval '30 days') AS resolved_30,
                count(*) FILTER (WHERE status = 'open') AS open,
                count(*) FILTER (WHERE status = 'open' AND action_label IS NOT NULL) AS open_actions,
                count(*) AS total
         FROM agent_suggestions GROUP BY agent`,
      ),
      query(
        `SELECT agent, count(*) AS runs, count(*) FILTER (WHERE NOT ok) AS errors, round(avg(duration_ms)) AS avg_ms, max(duration_ms) AS max_ms
         FROM agent_runs WHERE started_at > now() - interval '7 days' GROUP BY agent`,
      ).catch(() => ({ rows: [] as Record<string, unknown>[] })),
      query(
        `SELECT DISTINCT ON (agent) agent, started_at, duration_ms, ok, error, trigger, open_after
         FROM agent_runs ORDER BY agent, started_at DESC`,
      ).catch(() => ({ rows: [] as Record<string, unknown>[] })),
      query(
        `SELECT id, agent, kind, severity, status, title, detail, action_label, owner_only,
                (created_at AT TIME ZONE current_setting('TimeZone')) AS created_at, (decided_at AT TIME ZONE current_setting('TimeZone')) AS decided_at, (updated_at AT TIME ZONE current_setting('TimeZone')) AS updated_at
         FROM (SELECT s.*, row_number() OVER (PARTITION BY agent ORDER BY GREATEST(created_at, updated_at) DESC, id DESC) AS rn FROM agent_suggestions s) x
         WHERE rn <= 8 ORDER BY agent, GREATEST(created_at, updated_at) DESC`,
      ),
      query(`SELECT (agents_ran_at AT TIME ZONE current_setting('TimeZone')) AS agents_ran_at FROM app_settings WHERE id = 1`),
    ]);
    const n = (v: unknown) => Number(v ?? 0);
    const byAgent = <T extends Record<string, unknown>>(rows: T[]) => new Map(rows.map((r) => [String(r.agent), r]));
    const st = byAgent(stats.rows);
    const rn = byAgent(runs.rows);
    const ls = byAgent(last.rows);
    const agents = AGENT_CATALOG.map((a) => {
      const s = st.get(a.key) ?? {};
      const r = rn.get(a.key);
      const l = ls.get(a.key);
      const decided30 = n(s.accepted_30) + n(s.dismissed_30);
      const hasAction = a.kinds.some((k) => !k.retired && !k.button.startsWith('—'));
      return {
        ...a,
        implemented: !!AGENTS[a.key]?.scan,
        has_action: hasAction,
        enabled: settings[a.key].enabled,
        max_open: settings[a.key].maxOpen,
        setting_default: settings[a.key].isDefault,
        updated_at: settings[a.key].updatedAt,
        updated_by: settings[a.key].updatedBy,
        last_run: l ? { at: l.started_at, ms: n(l.duration_ms), ok: !!l.ok, error: l.error ?? null, trigger: l.trigger, open_after: l.open_after == null ? null : n(l.open_after) } : null,
        runs_7d: r ? { runs: n(r.runs), errors: n(r.errors), avg_ms: n(r.avg_ms), max_ms: n(r.max_ms) } : { runs: 0, errors: 0, avg_ms: 0, max_ms: 0 },
        stats: {
          open: n(s.open), open_actions: n(s.open_actions), total: n(s.total),
          d7: { raised: n(s.raised_7), accepted: n(s.accepted_7), dismissed: n(s.dismissed_7), resolved: n(s.resolved_7) },
          d30: { raised: n(s.raised_30), accepted: n(s.accepted_30), dismissed: n(s.dismissed_30), resolved: n(s.resolved_30) },
          // Of the cards someone decided on in 30 days, how many were accepted (only meaningful when there is a button).
          acceptance_pct: hasAction && decided30 > 0 ? Math.round((n(s.accepted_30) / decided30) * 100) : null,
        },
        recent: recent.rows.filter((x) => x.agent === a.key).map((x) => ({ ...x, id: Number(x.id) })),
      };
    });
    return NextResponse.json({ agents, ran_at: ranAt.rows[0]?.agents_ran_at ?? null }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const s = await requireDeveloper(req);
    const b = await readObject(req);
    if (!isAgentKey(b.agent)) throw new LedgerError('Unknown agent.');
    const agent = b.agent;
    const change: { enabled?: boolean; maxOpen?: number } = {};
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== 'boolean') throw new LedgerError('Send enabled: true or false.');
      change.enabled = b.enabled;
    }
    if (b.max_open !== undefined) {
      const m = Number(b.max_open);
      if (!Number.isInteger(m) || m < 1 || m > 50) throw new LedgerError('Cards shown must be a whole number from 1 to 50.');
      change.maxOpen = m;
    }
    if (change.enabled === undefined && change.maxOpen === undefined) throw new LedgerError('Nothing to change.');
    const closed = await withTransaction(async (q) => {
      await setAgentSetting(q, agent, change, s.user.email ?? s.user.id);
      await audit(q, { event: 'agent.settings', actorId: s.user.id, sessionId: s.id, req, detail: { agent, ...change } });
      if (change.enabled === false) return resolveAgent(q, agent);
      if (change.enabled === true) await markAgentsStale(q);
      return 0;
    });
    let ran: string | null = null;
    if (change.enabled === true) ran = (await runAgents({ only: agent, trigger: 'manual' })).results[agent] ?? null;
    const label = AGENT_INFO[agent].label;
    const message = change.enabled === undefined
      ? `${label}: shows up to ${change.maxOpen} cards`
      : change.enabled
        ? `${label} switched on${ran ? ` and ran (${ran})` : ''}`
        : `${label} switched off${closed ? ` — ${closed} open card${closed === 1 ? '' : 's'} closed` : ''}`;
    return NextResponse.json({ success: true, message });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireDeveloper(req);
    const b = await readObject(req);
    if (b.agent !== undefined && b.agent !== null && !isAgentKey(b.agent)) throw new LedgerError('Unknown agent.');
    const only = isAgentKey(b.agent) ? b.agent : undefined;
    const t0 = Date.now();
    const res = await runAgents({ force: true, only, trigger: 'manual' });
    return NextResponse.json({ success: true, results: res.results, ms: Date.now() - t0, message: only ? `${AGENT_INFO[only].label}: ${res.results[only] ?? 'did not run'}` : `Ran all agents in ${Date.now() - t0} ms` });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
