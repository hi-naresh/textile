'use client';

// Developer console → Docs: everything built, from src/lib/docs/catalog.ts (screens & features by role, APIs,
// migrations, cron jobs, env vars) and src/lib/agents/catalog.ts (agents), with search and filters.
// Live parts (migrations applied, env set / not set, routes on disk vs documented) come from GET /api/dev/docs.
import React, { useMemo, useState } from 'react';
import { Pill, Segmented, dayTime } from '@/components/ui';
import { useApi } from '@/lib/useApi';
import { APIS, CRONS, ENV_VARS, FEATURES, MIGRATIONS, type DocRole } from '@/lib/docs/catalog';
import { AGENT_CATALOG } from '@/lib/agents/catalog';

type Section = 'features' | 'agents' | 'apis' | 'data' | 'setup';
interface Live {
  migrations: { name: string; applied_at: string }[];
  env: { name: string; set: boolean }[];
  routes: { found: number; undocumented: string[]; missing: string[] } | null;
}

const ROLE_WORD: Record<DocRole, string> = { owner: 'Owner', supervisor: 'Supervisor', worker: 'Worker', developer: 'Developer' };
const has = (q: string, ...parts: (string | undefined | null)[]) => !q || parts.some((p) => p && p.toLowerCase().includes(q));

export function DocsPanel() {
  const { data: live, error } = useApi<Live>('/api/dev/docs');
  const [section, setSection] = useState<Section>('features');
  const [role, setRole] = useState<'all' | DocRole>('all');
  const [text, setText] = useState('');
  const q = text.trim().toLowerCase();

  const features = useMemo(() => FEATURES.filter((f) => (role === 'all' || f.roles.includes(role))
    && has(q, f.title, f.area, f.what, f.data, f.where, f.unsure, ...f.rules, ...f.apis, ...f.code)), [role, q]);
  const areas = [...new Set(features.map((f) => f.area))];
  const apis = APIS.filter((a) => has(q, a.path, a.methods, a.who, a.what) && (role === 'all' || role === 'developer' ? true : a.who.includes(role) || a.who.includes('signed in') || a.who.includes('public')));
  const agents = AGENT_CATALOG.filter((a) => has(q, a.label, a.key, a.purpose, a.value, a.watches, a.verdict, ...a.kinds.map((k) => `${k.label} ${k.when} ${k.button}`)));
  const applied = new Map((live?.migrations ?? []).map((m) => [m.name, m.applied_at]));
  const migNames = [...new Set([...MIGRATIONS.map((m) => m.name), ...applied.keys()])].sort();
  const envSet = new Map((live?.env ?? []).map((e) => [e.name, e.set]));

  return (
    <div className="stack-16">
      <section className="card pad stack-12">
        <div className="stack-4">
          <h2 className="h2">Docs</h2>
          <span className="muted small">What has been built, who uses it, where the data comes from and the rules it keeps. Written from the code; lines marked &quot;Not sure&quot; were not checked end to end. Edit src/lib/docs/catalog.ts (and src/lib/agents/catalog.ts for agents) when something changes.</span>
        </div>
        <div className="docs-bar">
          <input className="input" type="search" placeholder="Search docs (e.g. SR no., import, reminder, 410)" aria-label="Search docs" value={text} onChange={(e) => setText(e.target.value)} />
          <select className="input sel" aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as 'all' | DocRole)}>
            <option value="all">All roles</option>
            {(Object.keys(ROLE_WORD) as DocRole[]).map((r) => <option key={r} value={r}>{ROLE_WORD[r]}</option>)}
          </select>
        </div>
        <Segmented label="Docs section" value={section} onChange={setSection} className="fit docs-tabs"
          options={[{ value: 'features', label: `Screens & features (${features.length})` }, { value: 'agents', label: `Agents (${agents.length})` }, { value: 'apis', label: `APIs (${apis.length})` }, { value: 'data', label: 'Migrations' }, { value: 'setup', label: 'Cron & env' }]} />
        {error && <div className="alert bad">{error}</div>}
      </section>

      {section === 'features' && (
        <>
          {!features.length && <span className="muted small">Nothing matches.</span>}
          {areas.map((area) => (
            <section key={area} className="card pad stack-12">
              <h2 className="h2">{area}</h2>
              {features.filter((f) => f.area === area).map((f) => (
                <details key={f.id} className="doc-item">
                  <summary>
                    <span className="strong">{f.title}</span>
                    <span className="row-8 flexwrap doc-roles">{f.roles.map((r) => <Pill key={r} tone={r === 'owner' ? 'good' : r === 'developer' ? 'info' : 'warn'}>{ROLE_WORD[r]}</Pill>)}</span>
                  </summary>
                  <dl className="agent-dl">
                    <dt>Where</dt><dd>{f.where}</dd>
                    <dt>What it does</dt><dd>{f.what}</dd>
                    <dt>Data</dt><dd>{f.data}</dd>
                    {f.rules.length > 0 && <><dt>Rules</dt><dd><ul className="doc-list">{f.rules.map((r, i) => <li key={i}>{r}</li>)}</ul></dd></>}
                    {f.apis.length > 0 && <><dt>APIs</dt><dd className="mono tiny">{f.apis.join(' · ')}</dd></>}
                    <dt>Code</dt><dd className="mono tiny">{f.code.join(' · ')}</dd>
                    {f.unsure && <><dt>Not sure</dt><dd className="t-warn">{f.unsure}</dd></>}
                  </dl>
                </details>
              ))}
            </section>
          ))}
        </>
      )}

      {section === 'agents' && (
        <section className="card pad stack-12">
          <span className="muted small">On/off switches, run stats and recent cards are in the Agents tab.</span>
          {agents.map((a) => (
            <details key={a.key} className="doc-item">
              <summary><span className="strong">{a.label}</span><span className="row-8 flexwrap doc-roles"><Pill tone={a.status === 'active' ? 'good' : 'warn'}>{a.status === 'active' ? 'Active' : 'Paused'}</Pill><Pill tone="neutral">{a.defaultEnabled ? 'On by default' : 'Off by default'}</Pill></span></summary>
              <dl className="agent-dl">
                <dt>Purpose</dt><dd>{a.purpose}</dd>
                <dt>Why it helps</dt><dd>{a.value}</dd>
                <dt>Watches</dt><dd>{a.watches}</dd>
                <dt>Runs</dt><dd>{a.trigger}</dd>
                <dt>Cards</dt><dd><ul className="doc-list">{a.kinds.map((k) => <li key={k.kind}><b>{k.label}</b>{k.retired ? ' (retired)' : ''}: {k.when} Button: {k.button}</li>)}</ul></dd>
                <dt>Verdict</dt><dd>{a.verdict}</dd>
                <dt>Code</dt><dd className="mono tiny">{a.code.join(' · ')}</dd>
              </dl>
            </details>
          ))}
        </section>
      )}

      {section === 'apis' && (
        <section className="card pad stack-12">
          <span className="muted small">Every route calls requireUser / requireCap / requireRole / requireDeveloper (checked by scripts/check-route-auth.js). Supervisors never receive ₹; /api/dev/* answers 404 to non-developers.</span>
          {live?.routes && (live.routes.undocumented.length > 0 || live.routes.missing.length > 0) && (
            <div className="alert warn small">
              {live.routes.undocumented.length > 0 && <div>On disk but not documented: {live.routes.undocumented.join(', ')}</div>}
              {live.routes.missing.length > 0 && <div>Documented but not on disk: {live.routes.missing.join(', ')}</div>}
            </div>
          )}
          {live?.routes && !live.routes.undocumented.length && !live.routes.missing.length && <span className="small">All {live.routes.found} routes on disk are documented.</span>}
          <div className="dev-scroll"><table className="dev-table">
            <thead><tr><th>Route</th><th>Methods</th><th>Who</th><th>What</th></tr></thead>
            <tbody>{apis.map((a) => <tr key={a.path}><td className="mono tiny">{a.path}</td><td>{a.methods}</td><td>{a.who}</td><td>{a.what}</td></tr>)}</tbody>
          </table></div>
        </section>
      )}

      {section === 'data' && (
        <section className="card pad stack-12">
          <h2 className="h2">Migrations</h2>
          <span className="muted small">scripts/migrations/*.sql, applied in name order once each (schema_migrations) by `npm run db:migrate` / the build. All idempotent.</span>
          <div className="dev-scroll"><table className="dev-table">
            <thead><tr><th>File</th><th>What it adds</th><th>Applied</th></tr></thead>
            <tbody>{migNames.filter((n) => has(q, n, MIGRATIONS.find((m) => m.name === n)?.what)).map((n) => (
              <tr key={n}><td className="mono tiny">{n}</td><td>{MIGRATIONS.find((m) => m.name === n)?.what ?? <span className="t-warn">Not documented yet</span>}</td>
                <td>{live ? (applied.has(n) ? dayTime(applied.get(n)!) : <Pill tone="bad">Not applied</Pill>) : '…'}</td></tr>
            ))}</tbody>
          </table></div>
        </section>
      )}

      {section === 'setup' && (
        <>
          <section className="card pad stack-12">
            <h2 className="h2">Cron jobs</h2>
            <span className="muted small">From vercel.json. Times are UTC in the schedule.</span>
            <div className="dev-scroll"><table className="dev-table">
              <thead><tr><th>Route</th><th>Schedule</th><th>What</th><th>Protection</th></tr></thead>
              <tbody>{CRONS.map((c) => <tr key={c.path}><td className="mono tiny">{c.path}</td><td>{c.schedule}<div className="muted tiny">{c.ist}</div></td><td>{c.what}</td><td>{c.auth}{live && <div><Pill tone={envSet.get('CRON_SECRET') ? 'good' : 'bad'}>CRON_SECRET {envSet.get('CRON_SECRET') ? 'set' : 'not set'}</Pill></div>}</td></tr>)}</tbody>
            </table></div>
          </section>
          <section className="card pad stack-12">
            <h2 className="h2">Environment variables</h2>
            <span className="muted small">Names only — values are never shown. &quot;Set&quot; is checked on this server right now.</span>
            <div className="dev-scroll"><table className="dev-table">
              <thead><tr><th>Name</th><th>Needed</th><th>What for</th><th>Here</th></tr></thead>
              <tbody>{ENV_VARS.filter((v) => has(q, v.name, v.purpose)).map((v) => (
                <tr key={v.name}><td className="mono tiny">{v.name}{v.secret ? <div className="muted tiny">secret</div> : null}</td><td>{v.need}</td><td>{v.purpose}</td>
                  <td>{live ? <Pill tone={envSet.get(v.name) ? 'good' : v.need === 'required' ? 'bad' : v.need === 'recommended' ? 'warn' : 'neutral'}>{envSet.get(v.name) ? 'Set' : 'Not set'}</Pill> : '…'}</td></tr>
              ))}</tbody>
            </table></div>
          </section>
        </>
      )}
    </div>
  );
}
