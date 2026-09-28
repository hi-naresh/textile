'use client';

import React, { useState, useSyncExternalStore } from 'react';
import Icon, { Logo } from './Icon';
import { Sheet, initials } from './ui';
import type { Ctx } from './ctx';
import { MOBILE_PRIMARY, NAV, can, captureInScope, sectionName, type Role, activeSupervisor, owner, firm, withFirm } from '@/lib/access';
import type { Worker } from '@/lib/types';

export function shiftName(d = new Date()) {
  const h = d.getHours();
  return h >= 6 && h < 14 ? 'Morning shift' : h >= 14 && h < 22 ? 'Evening shift' : 'Night shift';
}

export function whoAmI(role: Role, me: Worker | null, name?: string) {
  if (role === 'owner') return { name: name ?? owner().name, title: 'Owner' };
  if (role === 'supervisor') return { name: name ?? activeSupervisor().name, title: activeSupervisor().sections.length ? `Supervisor · ${activeSupervisor().sections.join(' & ')}` : 'Supervisor · no sections yet' };
  return { name: name ?? me?.name ?? 'Worker', title: me ? `Worker · ${sectionName(me.section)}` : 'Worker' };
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
  openChat: () => void;
  children: React.ReactNode;
}

export default function Shell({ ctx, tab, openChat, children }: ShellProps) {
  const { role, d, go, me } = ctx;
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState('');
  const who = whoAmI(role, me, ctx.account.name);
  const nav = NAV[role];
  const pending = d.captures.filter((c) => c.status === 'pending' && captureInScope(role, c.type)).length;
  const groups = Array.from(new Set(nav.map((n) => n.group)));
  const primary = MOBILE_PRIMARY[role];
  const moreItems = nav.filter((n) => !primary.includes(n.tab));
  const minute = useMinute();
  const now = minute == null ? null : new Date(minute * 60_000);
  const today = now ? now.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : null;
  const chatOk = can(role, 'chat.use');

  return (
    <div className="shell">
      {/* ---------- Desktop sidebar ---------- */}
      <aside className="side">
        <div className="brand">
          <Logo />
          <div className="stack-0"><span className="brand-name">{firm().name}</span><span className="muted tiny">{firm().city}</span></div>
        </div>
        <button className="me-card" onClick={() => go('settings')} aria-label="Settings">
          <span className={`av ${role}`}>{initials(who.name)}</span>
          <div className="stack-0 min0"><span className="strong small ellipsis">{who.name}</span><span className="muted tiny ellipsis">{who.title}</span></div>
        </button>
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
      </aside>

      <div className="main-col">
        {/* ---------- Desktop top bar ---------- */}
        <header className="topbar">
          {role !== 'worker' ? (
            <form className="search" onSubmit={(e) => { e.preventDefault(); if (search.trim()) { d.ask(role, search.trim()); setSearch(''); openChat(); } }}>
              <Icon name="search" size={16} strokeWidth={2} />
              <input aria-label="Search or ask" placeholder="Ask: a lot, party, challan, worker…" value={search} onChange={(e) => setSearch(e.target.value)} />
              <kbd className="num">↵</kbd>
            </form>
          ) : <div />}
          <div className="grow" />
          {now && <span className="pill neutral tall hide-md"><Icon name="clock" size={14} strokeWidth={2} />{today} · {shiftName(now)}</span>}
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
            {chatOk && (
              <button className="ib m-chat" aria-label="Open chat" onClick={openChat}><Icon name="chat" size={20} strokeWidth={2} /></button>
            )}
            <button className={`av ${role} m-av`} aria-label="Settings" onClick={() => go('settings')}>{initials(who.name)}</button>
          </div>
        </header>

        <ViewAsBanner ctx={ctx} />

        {d.dbOk === false && (
          <div className="db-banner"><Icon name="alert" size={16} strokeWidth={2} />Something went wrong loading the latest data. Showing what was loaded before. <button className="linkbtn" onClick={() => d.refresh()}>Try again</button></div>
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
        </div>
      </Sheet>
    </div>
  );
}

/** Developer "View as": always visible while active, with a way back to the console. */
function ViewAsBanner({ ctx }: { ctx: Ctx }) {
  const s = ctx.session;
  if (s.kind !== 'developer' || !s.viewAs) return null;
  return (
    <div className="viewas-banner" role="alert">
      <Icon name="shield" size={16} strokeWidth={2} />
      <span className="grow">Viewing as <b>{s.viewAs.name}</b> ({s.viewAs.role}) · {s.viewAsWrite ? 'changes are allowed and logged' : 'read-only'}. Every screen you open is logged.</span>
      <button className="linkbtn" onClick={async () => { await fetch('/api/dev/view-as', { method: 'DELETE' }).catch(() => null); window.location.replace('/dev'); }}>Stop viewing</button>
    </div>
  );
}
