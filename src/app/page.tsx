'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Shell from '@/components/Shell';
import Icon from '@/components/Icon';
import { Sheet } from '@/components/ui';
import type { Ctx, Density, Lang, SheetKind, ThemePref } from '@/components/ctx';
import ChatDock from '@/components/ChatDock';
import { Access, Overview, People, Stock } from '@/components/screens/Owner';
import { Allot, AllotForm, JobCards, Review, StockForm, StockImport } from '@/components/screens/Shared';
import { Floor } from '@/components/screens/Floor';
import { Capture } from '@/components/screens/Worker';
import { Orders } from '@/components/screens/Orders';
import { Dispatch } from '@/components/screens/Dispatch';
import { Money } from '@/components/screens/Money';
import { Reports } from '@/components/screens/Reports';
import { HOME_TAB, can, sectionName, setPreviewSupervisor, tabAllowed, type Role, type Tab } from '@/lib/access';
import { Settings } from '@/components/screens/Settings';
import { useTextileData } from '@/lib/useTextileData';
import { workerDay } from '@/lib/derive';
import type { CaptureType } from '@/lib/types';

const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string | null) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

export default function TextileBrain() {
  const d = useTextileData();
  const [mounted, setMounted] = useState(false);
  const [role, setRoleState] = useState<Role>('owner');
  const [tab, setTab] = useState<Tab>('overview');
  const [lang, setLangState] = useState<Lang>('en');
  const [rate, setRateState] = useState<number | null>(null);
  const [workerId, setWorkerIdState] = useState<string | null>(null);
  const [supervisorId, setSupervisorIdState] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [capType, setCapType] = useState<CaptureType>('job_card_folding');
  const [theme, setThemeState] = useState<ThemePref>('system');
  const [density, setDensityState] = useState<Density>('detailed');
  const [chatOpen, setChatOpen] = useState(false);

  // Restore per-device preferences after hydration.
  useEffect(() => {
    const r = store.get('tb-role') as Role | null;
    const role0: Role = r === 'owner' || r === 'supervisor' || r === 'worker' ? r : 'owner';
    const t = store.get('tb-tab') as Tab | null;
    const l = store.get('tb-lang') as Lang | null;
    const rt = parseFloat(store.get('tb-rate') ?? '');
    /* eslint-disable react-hooks/set-state-in-effect */
    setRoleState(role0);
    setTab(t && tabAllowed(role0, t) ? t : HOME_TAB[role0]);
    if (l === 'en' || l === 'hi' || l === 'gu') setLangState(l);
    if (Number.isFinite(rt) && rt > 0) setRateState(rt);
    setWorkerIdState(store.get('tb-worker'));
    const sup = store.get('tb-sup');
    setPreviewSupervisor(sup);
    setSupervisorIdState(sup);
    const th = store.get('tb-theme');
    setThemeState(th === 'light' || th === 'dark' ? th : 'system');
    setDensityState(store.get('tb-density') === 'compact' ? 'compact' : 'detailed');
    setMounted(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  const go = useCallback((t: Tab) => {
    setTab(t);
    store.set('tb-tab', t);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // From Settings → View the screen stays on Settings (every role has it).
  const setRole = (r: Role) => {
    setRoleState(r);
    store.set('tb-role', r);
    const next: Tab = tab === 'settings' ? 'settings' : HOME_TAB[r];
    setTab(next);
    store.set('tb-tab', next);
    setSheet(null);
    setChatOpen(false);
  };
  const setLang = (l: Lang) => { setLangState(l); store.set('tb-lang', l); };
  const setRate = (r: number | null) => { setRateState(r); store.set('tb-rate', r == null ? null : String(r)); };
  const setWorkerId = (id: string) => { setWorkerIdState(id); store.set('tb-worker', id); };
  const setSupervisorId = (id: string) => { setPreviewSupervisor(id); setSupervisorIdState(id); store.set('tb-sup', id); };

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

  const days = useMemo(() => d.workers.map((w) => workerDay(w, d.allotments, d.jobCards, d.cctv)), [d.workers, d.allotments, d.jobCards, d.cctv]);
  const me = useMemo(() => {
    if (!d.workers.length) return null;
    return d.workers.find((w) => w.id === workerId)
      ?? d.workers.find((w) => sectionName(w.section) === 'Folding')
      ?? d.workers[0];
  }, [d.workers, workerId]);

  const ctx: Ctx = { role, d, go, days, me, lang, setLang, rate: role === 'owner' ? rate : null, setRate, openSheet: setSheet, capType, setCapType, theme, setTheme, openChat: () => setChatOpen(true),
    setRole, density, setDensity, workerId: me?.id ?? null, setWorkerId, supervisorId, setSupervisorId };
  const compact = role === 'owner' && density === 'compact';
  const safeTab: Tab = tabAllowed(role, tab) ? tab : HOME_TAB[role];

  let screen: React.ReactNode = null;
  switch (safeTab) {
    case 'overview': screen = <Overview ctx={ctx} />; break;
    case 'stock': screen = <Stock ctx={ctx} />; break;
    case 'jobs': screen = <JobCards ctx={ctx} />; break;
    case 'review': screen = <Review ctx={ctx} />; break;
    case 'people': screen = <People ctx={ctx} />; break;
    case 'access': screen = <Access ctx={ctx} />; break;
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
