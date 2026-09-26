'use client';

import React, { useState, useSyncExternalStore } from 'react';
import Icon, { Logo } from './Icon';
import { Segmented, Sheet, initials } from './ui';
import type { Ctx } from './ctx';
import { MOBILE_PRIMARY, NAV, ROLE_LABEL, captureInScope, sectionName, type Role, activeSupervisor, activeSupervisors, scopeText, owner, firm, withFirm } from '@/lib/access';
import type { Worker } from '@/lib/types';

export function shiftName(d = new Date()) {
  const h = d.getHours();
  return h >= 6 && h < 14 ? 'Morning shift' : h >= 14 && h < 22 ? 'Evening shift' : 'Night shift';
}

export function whoAmI(role: Role, me: Worker | null) {
  if (role === 'owner') return { name: owner().name, title: 'Owner' };
  if (role === 'supervisor') return { name: activeSupervisor().name, title: activeSupervisor().sections.length ? `Supervisor · ${activeSupervisor().sections.join(' & ')}` : activeSupervisor().id ? 'Supervisor · no sections yet' : 'No supervisors yet — add in Settings' };
  return { name: me?.name ?? 'Worker', title: `Worker · ${sectionName(me?.section)}` };
}

// Current minute on the client, null during server render. Keeps the
// date/shift chip out of SSR so server and browser locale/timezone can't
// cause a hydration mismatch; ticks every minute.
const subscribeMinute = (cb: () => void) => { const id = setInterval(cb, 60_000); return () => clearInterval(id); };
function useMinute(): number | null {
  return useSyncExternalStore(subscribeMinute, () => Math.floor(Date.now() / 60_000), () => null);
}

interface ShellProps {
  ctx: Ctx;
  tab: string;
  dark: boolean;
  toggleTheme: () => void;
  setRole: (r: Role) => void;
  workerId: string | null;
  setWorkerId: (id: string) => void;
  supervisorId: string | null;
  setSupervisorId: (id: string) => void;
  children: React.ReactNode;
}

export default function Shell({ ctx, tab, dark, toggleTheme, setRole, workerId, setWorkerId, supervisorId, setSupervisorId, children }: ShellProps) {
  const { role, d, go, me } = ctx;
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState('');
  const who = whoAmI(role, me);
  const nav = NAV[role];
  const pending = d.captures.filter((c) => c.status === 'pending' && captureInScope(role, c.type)).length;
  const groups = Array.from(new Set(nav.map((n) => n.group)));
  const primary = MOBILE_PRIMARY[role];
  const moreItems = nav.filter((n) => !primary.includes(n.tab));
  const minute = useMinute();
  const now = minute == null ? null : new Date(minute * 60_000);
  const today = now ? now.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : null;

  const roleSwitch = (
    <Segmented label="Preview as role" value={role} onChange={setRole} options={(['owner', 'supervisor', 'worker'] as Role[]).map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
  );
  const sups = activeSupervisors();
  const supervisorPick = role === 'supervisor' && sups.length > 1 && (
    <label className="worker-pick">
      <span className="sr-only">Preview which supervisor</span>
      <select value={supervisorId ?? sups[0].id} onChange={(e) => setSupervisorId(e.target.value)} aria-label="Preview which supervisor">
        {sups.map((s) => <option key={s.id} value={s.id}>{s.name}{s.sections.length ? ` · ${s.sections.join(', ')}` : ''}</option>)}
      </select>
    </label>
  );
  const workerPick = role === 'worker' && d.workers.length > 0 && (
    <label className="worker-pick">
      <span className="sr-only">Preview which worker</span>
      <select value={workerId ?? ''} onChange={(e) => setWorkerId(e.target.value)} aria-label="Preview which worker">
        {d.workers.map((w) => <option key={w.id} value={w.id}>{w.name} · {sectionName(w.section)}</option>)}
      </select>
    </label>
  );
  const themeBtn = (
    <button className="ib" onClick={toggleTheme} aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} title={dark ? 'Light mode' : 'Dark mode'}>
      <Icon name={dark ? 'sun' : 'moon'} />
    </button>
  );

  return (
    <div className="shell">
      {/* ---------- Desktop sidebar ---------- */}
      <aside className="side">
        <div className="brand">
          <Logo />
          <div className="stack-0"><span className="brand-name">{firm().name}</span><span className="muted tiny">{firm().city}</span></div>
        </div>
        <div className="me-card">
          <span className={`av ${role}`}>{initials(who.name)}</span>
          <div className="stack-0 min0"><span className="strong small ellipsis">{who.name}</span><span className="muted tiny ellipsis">{who.title}</span></div>
        </div>
        <nav aria-label="Main" className="side-nav">
          {groups.map((g) => (
            <div key={g} className="stack-4">
              <span className="eyebrow side-eyebrow">{g}</span>
              {nav.filter((n) => n.group === g).map((n) => (
                <button key={n.tab} className={`nav ${tab === n.tab ? 'on' : ''}`} aria-current={tab === n.tab ? 'page' : undefined} onClick={() => go(n.tab)}>
                  <Icon name={n.icon} />
                  <span className="grow">{withFirm(n.label)}</span>
                  {n.tab === 'review' && pending > 0 && <span className="pill warn num">{pending}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="scope-card">
          <div className="scope-title"><Icon name="lock" size={14} strokeWidth={2} />{scopeText(role).scope}</div>
          <span className="muted tiny lh">{scopeText(role).line}</span>
        </div>
      </aside>

      <div className="main-col">
        {/* ---------- Desktop top bar ---------- */}
        <header className="topbar">
          {role !== 'worker' ? (
            <form className="search" onSubmit={(e) => { e.preventDefault(); if (search.trim()) { d.ask(role, search.trim()); setSearch(''); go('ask'); } }}>
              <Icon name="search" size={16} strokeWidth={2} />
              <input aria-label="Search or ask" placeholder={role === 'owner' ? 'Search or ask: lots, parties, challans, workers…' : 'Search or ask about my lots, cards, workers…'} value={search} onChange={(e) => setSearch(e.target.value)} />
              <kbd className="num">↵</kbd>
            </form>
          ) : <div />}
          <div className="grow" />
          <div className="preview-group">
            <span className="muted tiny">Preview as</span>
            {roleSwitch}
          </div>
          {workerPick}
          {supervisorPick}
          {now && <span className="pill neutral tall hide-md"><Icon name="clock" size={14} strokeWidth={2} />{today} · {shiftName(now)}</span>}
          {themeBtn}
          {role !== 'worker' && (
            <button className="ib bell" aria-label={`${pending} reads waiting for review`} onClick={() => go('review')}>
              <Icon name="bell" />
              {pending > 0 && <span className="bell-dot" />}
            </button>
          )}
        </header>

        {/* ---------- Mobile header ---------- */}
        <header className="m-head">
          <div className="m-row">
            <Logo size={30} />
            <div className="stack-0 grow min0"><span className="brand-name">{firm().name}</span><span className="muted tiny ellipsis">{who.name} · {who.title}</span></div>
            {themeBtn}
            <span className={`av ${role} m-av`}>{initials(who.name)}</span>
          </div>
          <div className="m-role">{roleSwitch}</div>
          {workerPick && <div className="m-role">{workerPick}</div>}
          {supervisorPick && <div className="m-role">{supervisorPick}</div>}
        </header>

        <SystemBanner ctx={ctx} onOpenSettings={() => go('settings')} />

        {d.dbOk === false && (
          <div className="db-banner"><Icon name="alert" size={16} strokeWidth={2} />Can’t reach the database. Showing the last data loaded. <button className="linkbtn" onClick={() => d.refresh()}>Retry</button></div>
        )}

        <main className="content">{children}</main>

        {/* ---------- Mobile bottom tabs ---------- */}
        <nav aria-label="Main" className="tabbar">
          {primary.map((t) => {
            const n = nav.find((x) => x.tab === t)!;
            return (
              <button key={t} className={`tab ${tab === t ? 'on' : ''}`} aria-current={tab === t ? 'page' : undefined} onClick={() => go(t)}>
                <span className="tab-dot"><Icon name={n.icon} size={20} />{t === 'review' && pending > 0 && <span className="tab-badge num">{pending}</span>}</span>
                {n.short}
              </button>
            );
          })}
          {moreItems.length > 0 && (
            <button className={`tab ${moreItems.some((m) => m.tab === tab) ? 'on' : ''}`} onClick={() => setMore(true)}>
              <span className="tab-dot"><Icon name="more" size={20} strokeWidth={2.4} /></span>More
            </button>
          )}
        </nav>
      </div>

      <Sheet open={more} title="More" onClose={() => setMore(false)}>
        <div className="stack-4">
          {moreItems.map((n) => (
            <button key={n.tab} className={`nav big-nav ${tab === n.tab ? 'on' : ''}`} onClick={() => { go(n.tab); setMore(false); }}>
              <Icon name={n.icon} /><span className="grow">{withFirm(n.label)}</span><Icon name="arrow" size={16} />
            </button>
          ))}
          <div className="scope-card" style={{ marginTop: 12 }}>
            <div className="scope-title"><Icon name="lock" size={14} strokeWidth={2} />{scopeText(role).scope}</div>
            <span className="muted tiny lh">{scopeText(role).line}</span>
          </div>
        </div>
      </Sheet>
    </div>
  );
}

/** Warns when AI photo reading or photo storage isn't working. Stays until fixed; can be hidden per session. */
function SystemBanner({ ctx, onOpenSettings }: { ctx: Ctx; onOpenSettings: () => void }) {
  const { d, role } = ctx;
  const [hidden, setHidden] = useState<string | null>(null);
  const st = d.status;
  if (!st) return null;
  const aiOk = st.ai.state === 'connected';
  const photosOk = st.photos.state !== 'missing';
  if (aiOk && photosOk) return null;

  const key = `${st.ai.state}|${st.photos.state}`;
  if (hidden === key) return null;
  const demo = st.ai.state === 'demo' && photosOk;
  let text: string;
  if (role === 'worker') {
    text = !photosOk || (!aiOk && !demo)
      ? 'Photo reading is switched off right now. Tell your supervisor, and give them the paper challan or job card.'
      : 'Demo mode: photo reads are not real.';
  } else {
    const parts = [!aiOk ? st.ai.message : '', !photosOk ? st.photos.message : ''].filter(Boolean);
    text = parts.join(' ') + (!demo ? ' Enter stock and job cards manually until it is fixed.' : '');
  }
  return (
    <div className={`sys-banner ${demo ? 'info' : 'warn'}`} role="alert">
      <Icon name="alert" size={16} strokeWidth={2} />
      <span className="grow">{text}</span>
      {role === 'owner' && <button className="linkbtn" onClick={onOpenSettings}>Details</button>}
      <button className="ib sm-ib" aria-label="Hide this message" onClick={() => setHidden(key)}><Icon name="x" size={14} /></button>
    </div>
  );
}
