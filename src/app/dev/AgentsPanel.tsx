'use client';

// Developer console → Agents: every agent with its purpose in plain words, what it watches, when it runs, what
// its button does, status (implemented / on / off) with a switch, last run, card stats (7 / 30 days), acceptance
// rate, errors, "Run now", and its recent cards. Data: GET/PUT/POST /api/dev/agents (+ src/lib/agents/catalog.ts).
import React, { useState } from 'react';
import Icon from '@/components/Icon';
import { Pill, Segmented, dayTime, fmt } from '@/components/ui';
import { Toggle } from '@/components/screens/MyFirm';
import { apiSend, useApi } from '@/lib/useApi';
import type { AgentInfo } from '@/lib/agents/catalog';

type Counts = { raised: number; accepted: number; dismissed: number; resolved: number };
interface AgentRow extends AgentInfo {
  implemented: boolean; has_action: boolean; enabled: boolean; max_open: number; setting_default: boolean;
  updated_at: string | null; updated_by: string | null;
  last_run: { at: string; ms: number; ok: boolean; error: string | null; trigger: string; open_after: number | null } | null;
  runs_7d: { runs: number; errors: number; avg_ms: number; max_ms: number };
  stats: { open: number; open_actions: number; total: number; d7: Counts; d30: Counts; acceptance_pct: number | null };
  recent: { id: number; kind: string; severity: string; status: string; title: string; detail: string | null; action_label: string | null; owner_only: boolean; created_at: string; decided_at: string | null; updated_at: string }[];
}

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = { open: 'warn', accepted: 'good', rejected: 'neutral', resolved: 'info' };
const STATUS_WORD: Record<string, string> = { open: 'open', accepted: 'accepted', rejected: 'dismissed', resolved: 'closed itself' };

export function AgentsPanel() {
  const [tick, setTick] = useState(0);
  const { data, error } = useApi<{ agents: AgentRow[]; ran_at: string | null }>('/api/dev/agents', tick);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [period, setPeriod] = useState<'d7' | 'd30'>('d7');
  const [openKey, setOpenKey] = useState<string | null>(null);

  const call = async (key: string, method: 'PUT' | 'POST', body: Record<string, unknown>) => {
    setBusy(key);
    setMsg(null);
    try {
      const r = await apiSend<{ message: string }>('/api/dev/agents', method, body);
      setMsg({ ok: true, text: r.message });
      setTick((t) => t + 1);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed.' });
    } finally {
      setBusy(null);
    }
  };

  const agents = data?.agents ?? [];
  const on = agents.filter((a) => a.enabled).length;
  const openCards = agents.reduce((s, a) => s + (a.enabled ? a.stats.open : 0), 0);

  return (
    <div className="stack-16">
      <section className="card pad stack-12">
        <div className="card-head wrap-head">
          <div className="stack-4 min0">
            <h2 className="h2">Agents</h2>
            <span className="muted small">Small helpers that watch the firm&apos;s data and raise a card in &quot;Needs your attention&quot; when a person should act, with one button that does exactly what it says. No AI: fixed rules. They run in the background (never slowing the app), at most every 5 minutes and right after a change, plus daily at 07:00 IST.</span>
          </div>
          <div className="row-8 flexwrap">
            <Segmented label="Stats period" value={period} onChange={setPeriod} className="fit" options={[{ value: 'd7', label: '7 days' }, { value: 'd30', label: '30 days' }]} />
            <button className="btn sm" disabled={busy != null} onClick={() => call('all', 'POST', {})}><Icon name="refresh" size={14} />Run all now</button>
          </div>
        </div>
        {data && <span className="small">{on} of {agents.length} switched on · {openCards} open card{openCards === 1 ? '' : 's'} · last scan {data.ran_at ? dayTime(data.ran_at) : 'never (or due now)'}</span>}
        {msg && <div className={`alert ${msg.ok ? 'good' : 'bad'}`} role="status">{msg.text}</div>}
        {error && <div className="alert bad" role="alert">{error}</div>}
        {!data && !error && <div className="loading"><span className="spinner" />Loading…</div>}
      </section>

      {agents.map((a) => {
        const c = a.stats[period];
        const expanded = openKey === a.key;
        return (
          <section key={a.key} className={`card pad stack-12 agent-card${a.enabled ? '' : ' agent-off'}`}>
            <div className="agent-head">
              <div className="stack-4 grow min0">
                <div className="row-8 flexwrap">
                  <span className="strong">{a.label}</span>
                  <span className="muted tiny">({a.key})</span>
                  <Pill tone={a.implemented ? 'good' : 'bad'}>{a.implemented ? 'Implemented' : 'Not built'}</Pill>
                  <Pill tone={a.enabled ? 'good' : 'neutral'}>{a.enabled ? 'On' : 'Off'}</Pill>
                  {a.status === 'paused' && <Pill tone="warn">Paused by design</Pill>}
                </div>
                <span className="small">{a.purpose}</span>
              </div>
              <div className="row-8 agent-controls">
                <Toggle on={a.enabled} label={`${a.label} on or off`} onChange={(v) => { if (!busy) void call(a.key, 'PUT', { agent: a.key, enabled: v }); }} />
                <button className="btn sm" disabled={busy != null || !a.enabled} onClick={() => call(a.key, 'POST', { agent: a.key })}>{busy === a.key ? 'Running…' : 'Run now'}</button>
              </div>
            </div>
            {a.statusNote && <div className="alert warn small">{a.statusNote}</div>}

            <div className="agent-stats">
              <Stat label="Open now" value={a.enabled ? a.stats.open : 0} sub={a.enabled && a.stats.open_actions ? `${a.stats.open_actions} with a button` : undefined} />
              <Stat label="Raised" value={c.raised} />
              <Stat label="Accepted" value={c.accepted} />
              <Stat label="Dismissed" value={c.dismissed} />
              <Stat label="Closed itself" value={c.resolved} />
              <Stat label="Acceptance (30 d)" value={a.stats.acceptance_pct == null ? '—' : `${a.stats.acceptance_pct}%`} sub={a.has_action ? undefined : 'info cards only'} />
              <Stat label="Last run" value={a.last_run ? `${fmt(a.last_run.ms)} ms` : '—'} sub={a.last_run ? `${dayTime(a.last_run.at)} · ${a.last_run.trigger}` : 'not yet'} tone={a.last_run && !a.last_run.ok ? 'bad' : undefined} />
              <Stat label="Runs (7 d)" value={a.runs_7d.runs} sub={`${a.runs_7d.errors} error${a.runs_7d.errors === 1 ? '' : 's'} · avg ${fmt(a.runs_7d.avg_ms)} ms`} tone={a.runs_7d.errors ? 'bad' : undefined} />
            </div>
            {a.last_run && !a.last_run.ok && <div className="alert bad small">Last run failed: {a.last_run.error}</div>}

            <button className="linkbtn left small" aria-expanded={expanded} onClick={() => setOpenKey(expanded ? null : a.key)}>{expanded ? 'Hide details' : 'What it does, cards and recent items'}</button>
            {expanded && (
              <div className="stack-12">
                <dl className="agent-dl">
                  <dt>Why it helps</dt><dd>{a.value}</dd>
                  <dt>Watches</dt><dd>{a.watches}</dd>
                  <dt>Runs</dt><dd>{a.trigger}</dd>
                  <dt>Review verdict</dt><dd>{a.verdict}</dd>
                  <dt>Cards shown</dt>
                  <dd>
                    <span className="row-8 flexwrap">up to
                      <select className="input sel sm" aria-label={`Most cards shown for ${a.label}`} value={a.max_open} disabled={busy != null}
                        onChange={(e) => void call(a.key, 'PUT', { agent: a.key, max_open: Number(e.target.value) })}>
                        {[1, 2, 3, 5, 8, 10, 15, 20, 30, 50].map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                      at a time (most urgent first){a.setting_default ? ' · default setting' : a.updated_at ? ` · changed ${dayTime(a.updated_at)}${a.updated_by ? ` by ${a.updated_by}` : ''}` : ''}</span>
                  </dd>
                  <dt>Code</dt><dd className="mono tiny">{a.code.join(' · ')}</dd>
                </dl>
                <div className="dev-scroll"><table className="dev-table">
                  <thead><tr><th>Card</th><th>Raised when</th><th>Button</th><th>Quiet after dismiss</th><th>Who sees it</th></tr></thead>
                  <tbody>{a.kinds.map((k) => (
                    <tr key={k.kind} className={k.retired ? 'muted' : ''}>
                      <td><span className="strong">{k.label}</span><div className="muted tiny">{k.kind}{k.retired ? ' · retired' : ''}</div></td>
                      <td>{k.when}</td>
                      <td>{k.button}</td>
                      <td>{k.quietDays >= 3650 ? 'for good' : `${k.quietDays} day${k.quietDays === 1 ? '' : 's'}`}</td>
                      <td>{k.ownerOnly ? 'Owner (₹)' : 'Owner + supervisor'}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
                <div className="stack-8">
                  <span className="strong small">Recent cards</span>
                  {!a.recent.length && <span className="muted small">None yet.</span>}
                  {a.recent.map((r) => (
                    <div key={r.id} className="agent-recent">
                      <div className="stack-2 grow min0">
                        <span className="small strong">{r.title}</span>
                        {r.detail && <span className="muted tiny">{r.detail}</span>}
                        <span className="muted tiny">#{r.id} · {r.kind} · raised {dayTime(r.created_at)}{r.decided_at ? ` · decided ${dayTime(r.decided_at)}` : ''}{r.action_label ? ` · button "${r.action_label}"` : ''}{r.owner_only ? ' · owner only' : ''}</span>
                      </div>
                      <Pill tone={STATUS_TONE[r.status] ?? 'neutral'}>{STATUS_WORD[r.status] ?? r.status}</Pill>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: 'bad' }) {
  return (
    <div className="agent-stat">
      <span className="muted tiny">{label}</span>
      <span className={`num strong${tone === 'bad' ? ' text-bad' : ''}`}>{value}</span>
      {sub && <span className="muted tiny">{sub}</span>}
    </div>
  );
}
