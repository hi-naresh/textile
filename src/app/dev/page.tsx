'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { StartingPassword } from '@/components/screens/Team';
import Icon, { Logo } from '@/components/Icon';
import { Pill, Segmented, dayTime, fmt } from '@/components/ui';
import { fetchMe, installAuthFetch, logout, type Me } from '@/lib/authClient';
import { apiSend, useApi } from '@/lib/useApi';
import { formatPhone } from '@/lib/auth/phone';
import type { SystemStatus } from '@/lib/types';
import { Toggle } from '@/components/screens/MyFirm';
import { levelTone, type Capability } from '@/lib/access';
import { AgentsPanel } from './AgentsPanel';
import { DocsPanel } from './DocsPanel';

// Developer console: everything technical lives here and nowhere in the client app —
// service health, agents (what each is for, on/off, stats, run now), docs of everything built,
// connections, AI usage + cost, technical errors, accounts, "View as", audit trail.
type Tab = 'health' | 'agents' | 'docs' | 'usage' | 'errors' | 'users' | 'access' | 'audit';

export default function DevConsole() {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<Tab>('health');
  useEffect(() => {
    installAuthFetch();
    fetchMe()
      .then((m) => { if (!m || m.kind !== 'developer') window.location.replace('/dev/login'); else setMe(m); })
      .catch(() => window.location.replace('/dev/login'));
  }, []);
  if (!me) return <div className="page"><div className="loading"><span className="spinner" />Loading…</div></div>;
  return (
    <div className="page dev-page">
      <div className="row-10" style={{ flexWrap: 'wrap' }}>
        <Logo size={32} />
        <div className="stack-0 grow"><span className="brand-name">Developer console</span><span className="muted tiny">{me.user.name} · {me.user.email}</span></div>
        {me.viewAs && <button className="btn sm" onClick={() => window.location.assign('/')}>Open app as {me.viewAs.name}</button>}
        <button className="btn sm" onClick={() => logout('/dev/login')}>Sign out</button>
      </div>
      {me.viewAs && (
        <div className="viewas-banner" style={{ borderRadius: 10 }}>
          <Icon name="shield" size={16} strokeWidth={2} />
          <span className="grow">Viewing as <b>{me.viewAs.name}</b> ({me.viewAs.role}) since {me.viewAsSince ? dayTime(me.viewAsSince) : '—'} · {me.viewAsWrite ? 'writes allowed (DEV_VIEW_AS_WRITE=1)' : 'read-only'}</span>
          <button className="linkbtn" onClick={async () => { await apiSend('/api/dev/view-as', 'DELETE'); setMe(await fetchMe()); }}>Stop</button>
        </div>
      )}
      <Segmented label="Section" value={tab} onChange={setTab} className="fit"
        options={[{ value: 'health', label: 'Health' }, { value: 'agents', label: 'Agents' }, { value: 'docs', label: 'Docs' }, { value: 'usage', label: 'AI usage & cost' }, { value: 'errors', label: 'Errors' }, { value: 'users', label: 'Users & view as' }, { value: 'access', label: 'Access & roles' }, { value: 'audit', label: 'Audit trail' }]} />
      {tab === 'health' && <Health />}
      {tab === 'agents' && <AgentsPanel />}
      {tab === 'docs' && <DocsPanel />}
      {tab === 'usage' && <Usage />}
      {tab === 'errors' && <Errors />}
      {tab === 'users' && <Users onViewAs={() => window.location.assign('/')} />}
      {tab === 'access' && <AccessRoles />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

const TONE: Record<string, 'good' | 'warn' | 'bad' | 'info'> = { connected: 'good', demo: 'info', local: 'info', missing: 'bad', invalid_key: 'bad', model_unavailable: 'bad', unreachable: 'warn' };

interface HealthData {
  services: SystemStatus;
  database: { ok: boolean; error?: string; time?: string; version?: string; migrations?: { name: string; applied_at: string }[]; counts?: Record<string, number | null> };
  connections: { name: string; set: boolean; note: string }[];
  runtime: { node: string; vercel: boolean; region: string | null; commit: string | null };
  auth: { accessMinutes: number; clientSessionDays: number; developerSessionHours: number; viewAsWrite: boolean };
}

function Health() {
  const [tick, setTick] = useState(0);
  const [recheck, setRecheck] = useState(false);
  const { data, error, loading } = useApi<HealthData>(`/api/dev/health${recheck ? '?recheck=1' : ''}`, tick);
  const st = data?.services;
  const svc = (name: string, state: string, message: string, fix?: string, extra?: string) => (
    <div className="list-row wrap" key={name}>
      <div className="stack-2 grow min0"><span className="strong">{name}</span><span className="muted small">{message}{extra ? ` ${extra}` : ''}</span>{fix && <span className="t2 small">Fix: {fix}</span>}</div>
      <Pill tone={TONE[state] ?? 'warn'}>{state}</Pill>
    </div>
  );
  return (
    <div className="settings-grid">
      <section className="card pad stack-14">
        <div className="card-head"><h2 className="h2">Services</h2>
          <button className="btn sm" disabled={loading} onClick={() => { setRecheck(true); setTick((t) => t + 1); }}><Icon name="refresh" size={14} />Check again</button></div>
        {error && <div className="alert bad">{error}</div>}
        {st && (
          <div className="list">
            {svc('AI (Gemini)', st.ai.state, st.ai.message, st.ai.fix, st.models ? `Low: ${st.models.low} · High: ${st.models.high}.` : '')}
            {st.ocr && svc('OCR (Google Cloud Vision)', st.ocr.state, st.ocr.message, st.ocr.fix)}
            {svc('Photo storage', st.photos.state, st.photos.message, st.photos.fix)}
            {data && svc('Database', data.database.ok ? 'connected' : 'unreachable', data.database.ok ? `${data.database.version ?? ''} · ${data.database.migrations?.length ?? 0} migrations applied` : data.database.error ?? '')}
          </div>
        )}
      </section>
      <section className="card pad stack-14">
        <h2 className="h2">Connections & settings</h2>
        {data && (
          <div className="list">
            {data.connections.map((c) => (
              <div className="list-row" key={c.name}>
                <div className="stack-2 grow min0"><span className="strong">{c.name}</span><span className="muted tiny">{c.note}</span></div>
                <Pill tone={c.set ? 'good' : 'warn'}>{c.set ? 'Set' : 'Not set'}</Pill>
              </div>
            ))}
          </div>
        )}
        {data && <span className="muted small">Node {data.runtime.node}{data.runtime.vercel ? ` · Vercel ${data.runtime.region ?? ''}` : ' · local'}{data.runtime.commit ? ` · ${data.runtime.commit}` : ''} · access token {data.auth.accessMinutes} min · client sessions {data.auth.clientSessionDays} days · developer {data.auth.developerSessionHours} h</span>}
      </section>
      {data?.database.counts && (
        <section className="card pad stack-12">
          <h2 className="h2">Tables</h2>
          <div className="dev-scroll"><table className="dev-table"><tbody>
            {Object.entries(data.database.counts).map(([t, n]) => <tr key={t}><td>{t}</td><td className="num">{n == null ? 'missing' : fmt(n)}</td></tr>)}
          </tbody></table></div>
        </section>
      )}
      {data?.database.migrations && (
        <section className="card pad stack-12">
          <h2 className="h2">Migrations</h2>
          <div className="dev-scroll"><table className="dev-table"><tbody>
            {data.database.migrations.map((m) => <tr key={m.name}><td>{m.name}</td><td className="muted">{dayTime(m.applied_at)}</td></tr>)}
          </tbody></table></div>
        </section>
      )}
    </div>
  );
}

interface UsageData {
  days: number; totalCostUsd: number;
  byFeature: { feature: string; model: string; tier: string; calls: string; failures: string; tokens_in: string; tokens_out: string; avg_latency_ms: string; cost_usd: string }[];
  byDay: { day: string; calls: string; cost_usd: string }[];
  captureEngines: { engine: string; reads: string; avg_confidence: string; corrected: string }[];
  recent: { id: number; ts: string; feature: string; model: string; tokens_in: number; tokens_out: number; latency_ms: number; cost_usd: string; success: boolean; error: string | null }[];
}

function Usage() {
  const [days, setDays] = useState('30');
  const { data, error } = useApi<UsageData>(`/api/dev/usage?days=${days}`);
  return (
    <div className="stack-16">
      <div className="row-10"><Segmented label="Period" value={days} onChange={setDays} className="fit" options={[{ value: '1', label: 'Today' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
        {data && <Pill tone="info">Total ${Number(data.totalCostUsd).toFixed(4)}</Pill>}</div>
      {error && <div className="alert bad">{error}</div>}
      {data && (
        <>
          <section className="card pad stack-12"><h2 className="h2">By feature</h2>
            <div className="dev-scroll"><table className="dev-table">
              <thead><tr><th>Feature</th><th>Model</th><th>Calls</th><th>Failed</th><th>Tokens in / out</th><th>Avg ms</th><th>Cost $</th></tr></thead>
              <tbody>{data.byFeature.map((r, i) => <tr key={i}><td>{r.feature}</td><td>{r.model} ({r.tier})</td><td>{r.calls}</td><td>{r.failures}</td><td>{fmt(Number(r.tokens_in))} / {fmt(Number(r.tokens_out))}</td><td>{r.avg_latency_ms}</td><td>{r.cost_usd}</td></tr>)}</tbody>
            </table></div>
          </section>
          <div className="settings-grid">
            <section className="card pad stack-12"><h2 className="h2">By day</h2>
              <div className="dev-scroll"><table className="dev-table"><tbody>{data.byDay.map((r) => <tr key={r.day}><td>{String(r.day).slice(0, 10)}</td><td>{r.calls} calls</td><td>${r.cost_usd}</td></tr>)}</tbody></table></div>
            </section>
            <section className="card pad stack-12"><h2 className="h2">Photo read engines</h2>
              <div className="dev-scroll"><table className="dev-table"><thead><tr><th>Engine</th><th>Reads</th><th>Avg conf.</th><th>Corrected</th></tr></thead>
                <tbody>{data.captureEngines.map((r) => <tr key={r.engine}><td>{r.engine}</td><td>{r.reads}</td><td>{r.avg_confidence}</td><td>{r.corrected}</td></tr>)}</tbody></table></div>
            </section>
          </div>
          <section className="card pad stack-12"><h2 className="h2">Last 100 calls</h2>
            <div className="dev-scroll"><table className="dev-table">
              <thead><tr><th>When</th><th>Feature</th><th>Model</th><th>Tokens</th><th>ms</th><th>$</th><th>Result</th></tr></thead>
              <tbody>{data.recent.map((r) => <tr key={r.id}><td>{dayTime(r.ts)}</td><td>{r.feature}</td><td>{r.model}</td><td>{r.tokens_in}/{r.tokens_out}</td><td>{r.latency_ms}</td><td>{r.cost_usd}</td><td>{r.success ? 'ok' : <span style={{ color: 'var(--bad)' }}>{r.error ?? 'failed'}</span>}</td></tr>)}</tbody>
            </table></div>
          </section>
        </>
      )}
    </div>
  );
}

function Errors() {
  const [days, setDays] = useState('7');
  const [open, setOpen] = useState<number | null>(null);
  const { data, error } = useApi<{ errors: { id: number; ts: string; source: string; message: string; stack: string | null; user_id: string | null; detail: unknown }[] }>(`/api/dev/errors?days=${days}`);
  return (
    <section className="card pad stack-14">
      <div className="card-head"><h2 className="h2">Technical errors</h2>
        <Segmented label="Period" value={days} onChange={setDays} className="fit" options={[{ value: '1', label: '1 day' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }]} /></div>
      {error && <div className="alert bad">{error}</div>}
      {data && !data.errors.length && <span className="muted small">No errors logged.</span>}
      <div className="list">
        {data?.errors.map((e) => (
          <div key={e.id} className="list-row wrap" style={{ alignItems: 'flex-start' }}>
            <div className="stack-2 grow min0">
              <button className="linkbtn left strong" onClick={() => setOpen(open === e.id ? null : e.id)}>{e.message}</button>
              <span className="muted tiny">{dayTime(e.ts)} · {e.source}{e.user_id ? ` · ${e.user_id}` : ''}</span>
              {open === e.id && <pre className="dev-pre">{[e.stack, e.detail ? JSON.stringify(e.detail, null, 2) : ''].filter(Boolean).join('\n\n')}</pre>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

interface DevUser {
  id: string; name: string; phone: string | null; role: string | null; status: string; active: boolean;
  must_change_password: boolean; last_login_at: string | null; live_sessions: number; worker_section: string | null; sections: string[];
}

function Users({ onViewAs }: { onViewAs: () => void }) {
  const [tick, setTick] = useState(0);
  const { data, error } = useApi<{ users: DevUser[]; developers: { id: string; name: string; email: string; last_login_at: string | null; live_sessions: number }[] }>('/api/dev/users', tick);
  const [msg, setMsg] = useState<{ tone: 'bad' | 'good'; text: string } | null>(null);
  const [issued, setIssued] = useState<{ message: string; password: string } | null>(null);
  const [ownerName, setOwnerName] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  const owner = data?.users.find((u) => u.role === 'owner');

  const call = useCallback(async (body: Record<string, unknown>) => {
    setMsg(null);
    try {
      const r = await apiSend<{ message: string; temp_password?: string }>('/api/dev/users', 'POST', body);
      if (r.temp_password) setIssued({ message: r.message, password: r.temp_password });
      else setMsg({ tone: 'good', text: r.message });
      setTick((t) => t + 1);
    } catch (e) {
      setMsg({ tone: 'bad', text: e instanceof Error ? e.message : 'Failed.' });
    }
  }, []);
  const viewAs = async (id: string) => {
    try { await apiSend('/api/dev/view-as', 'POST', { user_id: id }); onViewAs(); } catch (e) { setMsg({ tone: 'bad', text: e instanceof Error ? e.message : 'Failed.' }); }
  };

  return (
    <div className="stack-16">
      {error && <div className="alert bad">{error}</div>}
      {msg && <div className={`alert ${msg.tone === 'bad' ? 'bad' : ''}`}>{msg.text}</div>}
      {issued && <StartingPassword issued={issued} onClose={() => setIssued(null)} />}
      <section className="card pad stack-14">
        <div className="stack-4"><h2 className="h2">Owner account</h2>
          <span className="muted small">Only the developer creates the owner. You get a one-time starting password to give the owner; they sign in with this phone and must then choose their own.</span></div>
        {owner && <span className="small">Now: <b>{owner.name}</b> · {owner.phone ? formatPhone(owner.phone) : 'no phone (can’t sign in)'}{owner.must_change_password ? ' · starting password' : ''}</span>}
        <form className="add-row" onSubmit={(e) => { e.preventDefault(); call({ action: 'setup_owner', name: ownerName || owner?.name, phone: ownerPhone }); }}>
          <input className="input" placeholder={owner?.name ?? 'Owner name'} aria-label="Owner name" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
          <input className="input" type="tel" placeholder="Owner phone" aria-label="Owner phone" value={ownerPhone} onChange={(e) => setOwnerPhone(e.target.value)} />
          <button className="btn primary" type="submit" disabled={!ownerPhone.trim()}>Set up owner</button>
        </form>
      </section>

      <section className="card pad stack-12">
        <h2 className="h2">Client accounts</h2>
        <div className="dev-scroll"><table className="dev-table">
          <thead><tr><th>Name</th><th>Phone</th><th>Role</th><th>Status</th><th>Last sign in</th><th>Devices</th><th /></tr></thead>
          <tbody>
            {data?.users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}<div className="muted tiny">{u.id}</div></td>
                <td>{formatPhone(u.phone) || '—'}</td>
                <td>{u.role ?? '—'}{u.role === 'supervisor' && u.sections.length ? <div className="muted tiny">{u.sections.join(', ')}</div> : null}</td>
                <td>{u.status}{!u.active ? ' · off' : ''}{u.must_change_password ? ' · starting pw' : ''}</td>
                <td>{u.last_login_at ? dayTime(u.last_login_at) : '—'}</td>
                <td>{u.live_sessions}</td>
                <td>
                  <div className="row-8" style={{ flexWrap: 'wrap' }}>
                    {u.status === 'approved' && u.active && u.role && <button className="btn sm" onClick={() => viewAs(u.id)}>View as</button>}
                    {u.phone && <button className="btn sm" onClick={() => { if (window.confirm(`Reset ${u.name}’s password? They get a new one-time starting password.`)) call({ action: 'reset_password', id: u.id }); }}>Reset password</button>}
                    {u.live_sessions > 0 && <button className="btn sm danger" onClick={() => call({ action: 'revoke_sessions', id: u.id })}>Sign out all</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>

      <section className="card pad stack-12">
        <div className="stack-4"><h2 className="h2">Developers</h2><span className="muted small">Created only from DEV_ADMIN_EMAIL / DEV_ADMIN_PASSWORD or `npm run dev:create`. No sign up.</span></div>
        <div className="list">
          {data?.developers.map((d) => (
            <div key={d.id} className="list-row"><div className="stack-2 grow"><span className="strong">{d.name}</span><span className="muted small">{d.email} · {d.live_sessions} device(s){d.last_login_at ? ` · last ${dayTime(d.last_login_at)}` : ''}</span></div></div>
          ))}
        </div>
      </section>
    </div>
  );
}

interface AuditRow { id: number; ts: string; event: string; actor_name: string | null; actor_id: string | null; target_name: string | null; target_user_id: string | null; login: string | null; ip: string | null; user_agent: string | null; detail: unknown }

function Audit() {
  const [event, setEvent] = useState('');
  const { data, error } = useApi<{ entries: AuditRow[] }>(`/api/dev/audit?limit=300${event ? `&event=${encodeURIComponent(event)}` : ''}`);
  return (
    <section className="card pad stack-14">
      <div className="card-head"><h2 className="h2">Audit trail</h2>
        <select className="input sel" aria-label="Event" value={event} onChange={(e) => setEvent(e.target.value)}>
          <option value="">All events</option>
          {['login', 'login.failed', 'signup', 'user', 'password', 'session', 'view_as', 'access', 'agent', 'dev.client_data', 'logout'].map((x) => <option key={x} value={x}>{x}</option>)}
        </select></div>
      {error && <div className="alert bad">{error}</div>}
      <div className="dev-scroll"><table className="dev-table">
        <thead><tr><th>When</th><th>Event</th><th>By</th><th>About</th><th>Details</th></tr></thead>
        <tbody>
          {data?.entries.map((a) => (
            <tr key={a.id}>
              <td>{dayTime(a.ts)}</td>
              <td>{a.event}</td>
              <td>{a.actor_name ?? a.actor_id ?? '—'}</td>
              <td>{a.target_name ?? a.target_user_id ?? a.login ?? '—'}</td>
              <td className="muted tiny">{a.detail ? JSON.stringify(a.detail) : ''}{a.ip ? ` · ${a.ip}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </section>
  );
}

// ---------- Access & roles: who sees what; switch capabilities off / on for supervisors and workers ----------
type Lvl = string;
interface AccessData {
  matrix: { layer: string; cap: Capability; label: string; owner: Lvl; supervisor: Lvl; worker: Lvl }[];
  off: { supervisor?: string[]; worker?: string[] };
  locked: { supervisor?: string[]; worker?: string[] };
}

function AccessRoles() {
  const [tick, setTick] = useState(0);
  const { data, error } = useApi<AccessData>('/api/dev/access', tick);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const flip = async (role: 'supervisor' | 'worker', cap: Capability, on: boolean) => {
    setBusy(`${role}:${cap}`);
    try {
      const r = await apiSend<{ message: string }>('/api/dev/access', 'PUT', { role, cap, on });
      setMsg({ ok: true, text: r.message });
      setTick((t) => t + 1);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not save.' });
    } finally {
      setBusy(null);
    }
  };
  const cell = (m: AccessData['matrix'][number], role: 'supervisor' | 'worker') => {
    const level = m[role];
    if (level === '—') return <span className="muted">—</span>;
    const off = (data?.off[role] ?? []).includes(m.cap);
    const locked = (data?.locked[role] ?? []).includes(m.cap);
    return (
      <div className="row-8 access-cell">
        <Pill tone={off ? 'neutral' : levelTone(level)}>{off ? 'Off' : level}</Pill>
        {locked ? <span className="muted tiny" title="Needed for this role's app to work">always on</span>
          : <Toggle on={!off} label={`${m.label} for ${role}s`} onChange={(v) => { if (!busy) void flip(role, m.cap, v); }} />}
      </div>
    );
  };
  return (
    <section className="card pad stack-14">
      <div className="stack-4">
        <h2 className="h2">Access & roles</h2>
        <span className="muted small">Who sees what. Switch a capability off for supervisors or workers and their menus, screens and APIs follow within about 30 seconds (their app picks it up on its next refresh). The owner always has full access; nothing can be given beyond these levels.</span>
      </div>
      {msg && <div className={`alert ${msg.ok ? 'good' : 'bad'}`} role="status">{msg.text}</div>}
      {error && <div className="alert bad" role="alert">{error}</div>}
      {!data && !error && <div className="loading"><span className="spinner" />Loading…</div>}
      {data && (
        <div className="dev-scroll"><table className="dev-table access-table">
          <thead><tr><th>Layer</th><th>Capability</th><th>Owner</th><th>Supervisor</th><th>Worker</th></tr></thead>
          <tbody>
            {data.matrix.map((m) => (
              <tr key={m.cap}>
                <td className="muted">{m.layer}</td>
                <td className="strong">{m.label}</td>
                <td><Pill tone={levelTone(m.owner)}>{m.owner}</Pill></td>
                <td>{cell(m, 'supervisor')}</td>
                <td>{cell(m, 'worker')}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}
