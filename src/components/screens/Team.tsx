'use client';

import React, { useState } from 'react';
import Icon from '../Icon';
import { PageHead, Pill, Segmented, dayTime } from '../ui';
import type { Ctx } from '../ctx';
import { apiSend, useApi } from '@/lib/useApi';
import { formatPhone } from '@/lib/auth/phone';

// Owner: approve / reject sign ups (and give the role), switch people off, change role,
// reset a forgotten password, see and end the devices someone is signed in on.

interface Account {
  id: string; name: string; phone: string | null; role: 'owner' | 'supervisor' | 'worker' | null;
  status: 'pending' | 'approved' | 'rejected'; requested_role: 'supervisor' | 'worker' | null; active: boolean;
  worker_id: string | null; worker_name: string | null; worker_section: string | null; sections: string[];
  must_change_password: boolean; rejected_count: number; last_login_at: string | null; created_at: string; live_sessions: number;
}
interface WorkerRec { id: string; name: string; section: string }
interface SessionRow { id: string; created_at: string; last_seen_at: string; expires_at: string; ip: string | null; user_agent: string | null }

const ROLE: Record<string, string> = { owner: 'Owner', supervisor: 'Supervisor', worker: 'Worker' };

/** "Mozilla/5.0 (iPhone; …) … Safari" → "iPhone · Safari" */
function device(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${br}`;
}

export function Team({ ctx }: { ctx: Ctx }) {
  const { d } = ctx;
  const [tick, setTick] = useState(0);
  const { data, error, loading } = useApi<{ users: Account[]; unlinkedWorkers: WorkerRec[] }>('/api/users', `${d.lastSync}-${tick}`);
  const users = data?.users ?? [];
  const pending = users.filter((u) => u.status === 'pending');
  const people = users.filter((u) => u.status === 'approved');
  const rejected = users.filter((u) => u.status === 'rejected');

  const [issued, setIssued] = useState<{ message: string; password: string } | null>(null);
  const act = async (id: string, action: string, body: Record<string, unknown> = {}) => {
    try {
      const r = await apiSend<{ message: string; temp_password?: string }>(`/api/users/${encodeURIComponent(id)}`, 'POST', { action, ...body });
      if (r.temp_password) setIssued({ message: r.message, password: r.temp_password });
      else d.showToast(r.message);
      setTick((t) => t + 1);
      d.refresh();
      return true;
    } catch (e) {
      d.showToast(e instanceof Error ? e.message : 'Something went wrong, try again.', 'danger');
      return false;
    }
  };

  return (
    <div className="page fade settings">
      <PageHead title="Users & sign ups" sub="Supervisors and workers sign up with their phone number. Approve them here and choose their role." />
      {error && <div className="alert bad" role="alert">{error}</div>}
      {issued && <StartingPassword issued={issued} onClose={() => setIssued(null)} />}
      {loading && !data && <div className="loading"><span className="spinner" />Loading…</div>}

      {data && (
        <section className="card pad stack-16">
          <div className="card-head"><h2 className="h2">Waiting for approval</h2>{pending.length > 0 && <Pill tone="warn">{pending.length}</Pill>}</div>
          {!pending.length && <span className="muted small">No new sign ups.</span>}
          {pending.map((u) => <PendingRow key={u.id} ctx={ctx} u={u} workers={data.unlinkedWorkers} act={act} />)}
        </section>
      )}

      {data && (
        <section className="card pad stack-16">
          <div className="stack-4"><h2 className="h2">People who can sign in</h2><span className="muted small">Switching someone off or changing their role signs them out on every device straight away.</span></div>
          <div className="list">
            {people.map((u) => <PersonRow key={u.id} ctx={ctx} u={u} workers={data.unlinkedWorkers} act={act} />)}
          </div>
        </section>
      )}

      {rejected.length > 0 && (
        <section className="card pad stack-12">
          <h2 className="h2">Rejected sign ups</h2>
          <div className="list">
            {rejected.map((u) => (
              <div key={u.id} className="list-row off">
                <div className="stack-2 grow min0"><span className="strong">{u.name}</span><span className="muted small">{formatPhone(u.phone)} · rejected {u.rejected_count}×</span></div>
                <span className="muted small">{u.rejected_count <= 3 ? 'Can sign up again' : 'Can’t sign up again'}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

type Act = (id: string, action: string, body?: Record<string, unknown>) => Promise<boolean>;

/** Role + what goes with it: supervisor → sections; worker → an existing worker record or a new one in a section. */
function RolePicker({ ctx, initial, workers, busy, submitLabel, onSubmit }: {
  ctx: Ctx; initial: 'supervisor' | 'worker'; workers: WorkerRec[]; busy: boolean; submitLabel: string;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const sections = ctx.d.config.sections.filter((s) => s.active);
  const [role, setRole] = useState<'supervisor' | 'worker'>(initial);
  const [secs, setSecs] = useState<number[]>([]);
  const [workerId, setWorkerId] = useState('');
  const [section, setSection] = useState(sections[0]?.name ?? '');
  const body = role === 'supervisor' ? { role, sections: secs } : workerId ? { role, worker_id: workerId } : { role, section };
  return (
    <div className="stack-12">
      <Segmented label="Role" value={role} onChange={setRole} className="fit" options={[{ value: 'worker', label: 'Worker' }, { value: 'supervisor', label: 'Supervisor' }]} />
      {role === 'supervisor' ? (
        <div className="fld">Sections they look after
          <div className="chips" role="group" aria-label="Sections">
            {sections.map((s) => {
              const on = secs.includes(s.id);
              return <button key={s.id} type="button" className={`chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => setSecs(on ? secs.filter((x) => x !== s.id) : [...secs, s.id])}>{on && <Icon name="check" size={13} strokeWidth={2.4} />}{s.name}</button>;
            })}
          </div>
        </div>
      ) : (
        <div className="two-col">
          <label className="fld">Worker record
            <select value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
              <option value="">New worker</option>
              {workers.map((w) => <option key={w.id} value={w.id}>{w.name} · {w.section}</option>)}
            </select>
          </label>
          {!workerId && (
            <label className="fld">Section
              <select value={section} onChange={(e) => setSection(e.target.value)}>
                {sections.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
              </select>
            </label>
          )}
        </div>
      )}
      <div className="row-8"><button className="btn primary" disabled={busy || (role === 'worker' && !workerId && !section)} onClick={() => onSubmit(body)}><Icon name="check" size={16} strokeWidth={2} />{submitLabel}</button></div>
    </div>
  );
}

function PendingRow({ ctx, u, workers, act }: { ctx: Ctx; u: Account; workers: WorkerRec[]; act: Act }) {
  const [busy, setBusy] = useState(false);
  const run = async (action: string, body?: Record<string, unknown>) => { setBusy(true); await act(u.id, action, body); setBusy(false); };
  return (
    <div className="card flat pad stack-12">
      <div className="row-10" style={{ flexWrap: 'wrap' }}>
        <div className="stack-2 grow min0">
          <span className="strong">{u.name}</span>
          <span className="muted small">{formatPhone(u.phone)} · signed up {dayTime(u.created_at)}{u.requested_role ? ` · says ${ROLE[u.requested_role].toLowerCase()}` : ''}{u.rejected_count ? ` · rejected before ${u.rejected_count}×` : ''}</span>
        </div>
        <button className="btn danger sm" disabled={busy} onClick={() => { if (window.confirm(`Reject ${u.name}’s sign up?`)) run('reject'); }}>Reject</button>
      </div>
      <RolePicker ctx={ctx} initial={u.requested_role ?? 'worker'} workers={workers} busy={busy} submitLabel="Approve" onSubmit={(b) => run('approve', b)} />
    </div>
  );
}

function PersonRow({ ctx, u, workers, act }: { ctx: Ctx; u: Account; workers: WorkerRec[]; act: Act }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState('');
  const [changing, setChanging] = useState(false);
  const isOwner = u.role === 'owner';
  const run = async (action: string, body?: Record<string, unknown>) => { setBusy(true); const ok = await act(u.id, action, body); setBusy(false); return ok; };
  const sub = [
    u.phone ? formatPhone(u.phone) : 'No phone yet — can’t sign in',
    u.role === 'supervisor' ? (u.sections.length ? u.sections.join(', ') : 'no sections') : u.role === 'worker' ? (u.worker_section ?? '') : '',
    u.last_login_at ? `last sign in ${dayTime(u.last_login_at)}` : '',
  ].filter(Boolean).join(' · ');
  return (
    <div className={`list-row wrap ${u.active ? '' : 'off'}`} style={{ alignItems: 'flex-start' }}>
      <span className={`av ${u.role ?? 'worker'} sm`}>{u.name.slice(0, 1).toUpperCase()}</span>
      <div className="stack-2 grow min0">
        <span className="strong">{u.name}</span>
        <span className="muted small">{sub}</span>
        {open && (
          <div className="stack-12" style={{ marginTop: 10 }}>
            {isOwner && <span className="muted small">The owner account (phone, password) is managed by the developer.</span>}
            {!isOwner && !u.phone && (
              <form className="add-row" onSubmit={async (e) => { e.preventDefault(); if (await run('set_phone', { phone })) setPhone(''); }}>
                <input className="input" type="tel" inputMode="numeric" placeholder="Phone number" aria-label="Phone number" value={phone} onChange={(e) => setPhone(e.target.value)} />
                <button className="btn" type="submit" disabled={busy || !phone.trim()}>Save phone</button>
              </form>
            )}
            {!isOwner && u.phone && <span className="muted small">Forgot the password? Reset it: you get a one-time starting password to give them; they choose a new one when they sign in.</span>}
            {changing && !isOwner && (
              <RolePicker ctx={ctx} initial={u.role === 'supervisor' ? 'worker' : 'supervisor'} workers={workers} busy={busy} submitLabel="Change role"
                onSubmit={async (b) => { if (await run('set_role', b)) setChanging(false); }} />
            )}
            <div className="row-8" style={{ flexWrap: 'wrap' }}>
              {!isOwner && u.phone && <button className="btn sm" disabled={busy} onClick={() => { if (window.confirm(`Reset ${u.name}’s password? They will be signed out and get a new starting password.`)) run('reset_password'); }}>Reset password</button>}
              {!isOwner && u.active && !changing && <button className="btn sm" disabled={busy} onClick={() => setChanging(true)}>Change role</button>}
              {!isOwner && (u.active
                ? <button className="btn sm danger" disabled={busy} onClick={() => { if (window.confirm(`Switch ${u.name} off? They are signed out everywhere and can’t sign in.`)) run('deactivate'); }}>Switch off</button>
                : <button className="btn sm" disabled={busy} onClick={() => run('reactivate')}>Switch on</button>)}
            </div>
            <Sessions u={u} busy={busy} run={run} />
          </div>
        )}
      </div>
      <div className="row-8">
        {!u.active && <Pill>Off</Pill>}
        {u.must_change_password && u.active && <Pill tone="warn">Starting password</Pill>}
        <Pill tone={isOwner ? 'good' : 'info'}>{u.role ? ROLE[u.role] : '—'}</Pill>
        <button className="ib sm-ib" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} options for ${u.name}`} onClick={() => setOpen(!open)}><Icon name={open ? 'x' : 'more'} size={16} /></button>
      </div>
    </div>
  );
}

function Sessions({ u, busy, run }: { u: Account; busy: boolean; run: (action: string, body?: Record<string, unknown>) => Promise<boolean> }) {
  const [tick, setTick] = useState(0);
  const { data } = useApi<{ sessions: SessionRow[] }>(`/api/users/${encodeURIComponent(u.id)}`, tick);
  const list = data?.sessions ?? [];
  const end = async (body?: Record<string, unknown>) => { if (await run('revoke_sessions', body)) setTick((t) => t + 1); };
  return (
    <div className="stack-6">
      <span className="eyebrow">Signed in on</span>
      {!data && <span className="muted small">Loading…</span>}
      {data && !list.length && <span className="muted small">Not signed in anywhere.</span>}
      {list.map((s) => (
        <div key={s.id} className="sess-row">
          <div className="stack-2 grow min0"><span className="small strong">{device(s.user_agent)}</span><span className="muted tiny">Since {dayTime(s.created_at)} · last used {dayTime(s.last_seen_at)}</span></div>
          <button className="btn sm" disabled={busy} onClick={() => end({ session_id: s.id })}>Sign out</button>
        </div>
      ))}
      {list.length > 1 && <div className="row-8"><button className="btn sm danger" disabled={busy} onClick={() => end()}>Sign out everywhere</button></div>}
    </div>
  );
}

/** A newly issued starting password: shown once, with a copy button. */
export function StartingPassword({ issued, onClose }: { issued: { message: string; password: string }; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="card pad stack-10" role="status" style={{ borderColor: 'var(--accent)' }}>
      <strong>{issued.message}</strong>
      <span className="muted small">Starting password — shown only once. Give it to them now; they must choose their own when they first sign in.</span>
      <code className="temp-pw">{issued.password}</code>
      <div className="row-8">
        <button type="button" className="btn sm" onClick={() => { navigator.clipboard?.writeText(issued.password).then(() => setCopied(true)).catch(() => {}); }}>{copied ? 'Copied' : 'Copy'}</button>
        <button type="button" className="btn sm primary" onClick={onClose}>Done</button>
      </div>
    </section>
  );
}
