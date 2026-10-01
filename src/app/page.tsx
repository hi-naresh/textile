'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Shell from '@/components/Shell';
import Icon from '@/components/Icon';
import { Sheet } from '@/components/ui';
import type { AttentionTab, Ctx, Density, Lang, LeaveGuard, SheetKind, ThemePref } from '@/components/ctx';
import ChatDock from '@/components/ChatDock';
import { People, Stock } from '@/components/screens/Owner';
import { Overview } from '@/components/screens/Overview';
import { Allot, AllotForm, JobCards, StockForm, StockImport } from '@/components/screens/Shared';
import { Floor } from '@/components/screens/Floor';
import { Capture } from '@/components/screens/Worker';
import { Orders } from '@/components/screens/Orders';
import { Dispatch } from '@/components/screens/Dispatch';
import { Money } from '@/components/screens/Money';
import { Reports } from '@/components/screens/Reports';
import { MyFirm } from '@/components/screens/MyFirm';
import { useAgentFeed } from '@/components/AgentInbox';
import { ForcePasswordScreen, PendingScreen } from '@/components/screens/Account';
import { HOME_TAB, can, setPreviewSupervisor, tabAllowed, type Role, type Tab } from '@/lib/access';
import { Settings } from '@/components/screens/Settings';
import { useTextileData } from '@/lib/useTextileData';
import { workerDay } from '@/lib/derive';
import type { CaptureType } from '@/lib/types';
import { fetchMe, installAuthFetch, type Me } from '@/lib/authClient';
import { useApi } from '@/lib/useApi';

const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string | null) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

// Who is signed in decides everything: not signed in → /login; developer → /dev (unless viewing as someone);
// pending sign up → waiting screen; starting password → choose a new one; otherwise the app for that role.
export default function TextileBrain() {
  const [session, setSession] = useState<Me | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    fetchMe()
      .then((m) => {
        if (!m) window.location.replace('/login');
        else if (m.kind === 'developer' && !m.viewAs) window.location.replace('/dev');
        else setSession(m);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    installAuthFetch();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial session load (state is set after the request resolves)
    load();
  }, [load]);

  if (failed) {
    return (
      <main className="auth-wrap"><div className="card pad stack-16 auth-card">
        <span className="t2">Something went wrong, try again.</span>
        <button className="btn primary" onClick={load}>Try again</button>
      </div></main>
    );
  }
  if (!session) return <div className="page"><div className="loading"><span className="spinner" />Loading…</div></div>;
  if (session.kind === 'client' && session.user.status === 'pending') return <PendingScreen me={session} onCheck={load} />;
  if (session.kind === 'client' && session.user.mustChangePassword) return <ForcePasswordScreen me={session} onDone={load} />;
  return <App session={session} />;
}

function App({ session }: { session: Me }) {
  const account = session.viewAs ?? session.user;
  const role = account.role as Role;

  const d = useTextileData();
  const [mounted, setMounted] = useState(false);
  const [tab, setTab] = useState<Tab>(HOME_TAB[role]);
  const [lang, setLangState] = useState<Lang>('en');
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [capType, setCapType] = useState<CaptureType>('job_card_folding');
  const [theme, setThemeState] = useState<ThemePref>('system');
  const [density, setDensityState] = useState<Density>('detailed');
  const [chatOpen, setChatOpen] = useState(false);
  const [attention, setAttention] = useState<AttentionTab | null>(null);
  const guard = React.useRef<LeaveGuard | null>(null);
  const setLeaveGuard = useCallback((g: LeaveGuard | null) => { guard.current = g; }, []);

  // Restore per-device preferences after hydration.
  useEffect(() => {
    // 'team' (Users & sign ups) moved into My firm.
    const saved = store.get('tb-tab');
    const t = (saved === 'team' ? 'firm' : saved) as Tab | null; // 'review' / 'access' are gone: fall back to home
    const l = store.get('tb-lang') as Lang | null;
    // Average ₹/m rate is gone (every party gets its own rate), so forget any saved one.
    store.set('tb-rate', null);
    // Supervisor screens scope to the signed-in supervisor's sections (screens render after `mounted`).
    setPreviewSupervisor(role === 'supervisor' ? account.id : null);
    /* eslint-disable react-hooks/set-state-in-effect */
    setTab(t && tabAllowed(role, t) ? t : HOME_TAB[role]);
    if (l === 'en' || l === 'hi' || l === 'gu') setLangState(l);
    const th = store.get('tb-theme');
    setThemeState(th === 'light' || th === 'dark' ? th : 'system');
    setDensityState(store.get('tb-density') === 'compact' ? 'compact' : 'detailed');
    setMounted(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [role, account.id]);

  const go = useCallback((t: Tab) => {
    // The review queue lives in the "Needs your attention" panel (bell), not in the menu.
    if (t === 'review') { setAttention('review'); return; }
    const move = () => {
      guard.current = null;
      setTab(t);
      store.set('tb-tab', t);
      if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    if (guard.current && !guard.current(move)) return; // screen asks to save / discard first
    move();
  }, []);

  const setLang = (l: Lang) => { setLangState(l); store.set('tb-lang', l); };

  const setTheme = (t: ThemePref) => {
    setThemeState(t);
    store.set('tb-theme', t === 'system' ? null : t);
    const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#111210' : '#F3F0E8');
  };
  const setDensity = (v: Density) => { setDensityState(v); store.set('tb-density', v); };

  // Browser tab title follows the firm name from Settings
  useEffect(() => {
    const f = d.config.firm;
    if (d.lastSync) document.title = f.city ? `${f.name} · ${f.city}` : f.name;
  }, [d.config, d.lastSync]);

  const agents = useAgentFeed(role, d.lastSync);
  // Sign ups waiting for approval (owner): shown on the bell and on My firm → Team.
  const signupFeed = useApi<{ users: { status: string }[] }>(role === 'owner' && can(role, 'users.manage') ? '/api/users' : null, d.lastSync);
  const signups = signupFeed.data?.users.filter((u) => u.status === 'pending').length ?? 0;
  const days = useMemo(() => d.workers.map((w) => workerDay(w, d.allotments, d.jobCards, d.cctv)), [d.workers, d.allotments, d.jobCards, d.cctv]);
  // A worker's own worker record (the server only sends that one to a worker).
  const me = useMemo(() => (account.workerId ? d.workers.find((w) => w.id === account.workerId) ?? null : null), [d.workers, account.workerId]);

  const ctx: Ctx = { role, d, go, days, me, session, account, lang, setLang, rate: null, setRate: () => {}, openSheet: setSheet, capType, setCapType, theme, setTheme, openChat: () => setChatOpen(true),
    density, setDensity, workerId: account.workerId, agents, attention, openAttention: setAttention, setLeaveGuard, signups };
  const compact = role === 'owner' && density === 'compact';
  const safeTab: Tab = tabAllowed(role, tab) ? tab : HOME_TAB[role];

  let screen: React.ReactNode = null;
  switch (safeTab) {
    case 'overview': screen = <Overview ctx={ctx} />; break;
    case 'stock': screen = <Stock ctx={ctx} />; break;
    case 'jobs': screen = <JobCards ctx={ctx} />; break;
    case 'people': screen = <People ctx={ctx} />; break;
    case 'firm': screen = <MyFirm ctx={ctx} />; break;
    case 'floor': screen = <Floor ctx={ctx} />; break;
    case 'allot': screen = <Allot ctx={ctx} />; break;
    case 'capture': screen = <Capture ctx={ctx} />; break;
    case 'settings': screen = <Settings ctx={ctx} />; break;
    case 'orders': screen = <Orders ctx={ctx} />; break;
    case 'dispatch': screen = <Dispatch ctx={ctx} />; break;
    case 'money': screen = <Money ctx={ctx} />; break;
    case 'reports': screen = <Reports ctx={ctx} />; break;
  }

  return (
    <>
      <Shell ctx={ctx} tab={safeTab} openChat={() => setChatOpen(true)}>
        {!mounted || (d.loading && !d.lastSync) ? (
          <div className="page"><div className="loading"><span className="spinner" />Loading floor data…</div></div>
        ) : (
          <div key={`${role}-${safeTab}`} className={compact ? 'compact' : 'detailed'}>{screen}</div>
        )}
      </Shell>

      <Sheet open={sheet === 'stock' && can(role, 'ledger.edit')} title="Manual stock entry" onClose={() => setSheet(null)}>
        <StockForm ctx={ctx} onDone={() => setSheet(null)} />
      </Sheet>
      <Sheet open={sheet === 'import' && can(role, 'ledger.edit')} title="Import stock from Excel" onClose={() => setSheet(null)}>
        <StockImport ctx={ctx} onDone={() => setSheet(null)} />
      </Sheet>
      <Sheet open={sheet === 'job' && can(role, 'jobs.manage')} title="New job card" onClose={() => setSheet(null)}>
        <AllotForm ctx={ctx} onDone={() => setSheet(null)} />
      </Sheet>

      {mounted && <ChatDock ctx={ctx} open={chatOpen} setOpen={setChatOpen} />}

      {d.toast && (
        <div className={`toast ${d.toast.tone}`} role="status">
          <Icon name={d.toast.tone === 'success' ? 'check' : 'alert'} size={16} strokeWidth={2.2} />
          <span>{d.toast.text}</span>
        </div>
      )}
    </>
  );
}
