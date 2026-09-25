'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Shell from '@/components/Shell';
import Icon from '@/components/Icon';
import { Sheet } from '@/components/ui';
import type { Ctx, Lang, SheetKind } from '@/components/ctx';
import { Access, Overview, People, Stock } from '@/components/screens/Owner';
import { Allot, AllotForm, Ask, JobCards, Review, StockForm } from '@/components/screens/Shared';
import { Floor } from '@/components/screens/Floor';
import { Capture, History, Shift } from '@/components/screens/Worker';
import { HOME_TAB, can, sectionName, tabAllowed, type Role, type Tab } from '@/lib/access';
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
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [capType, setCapType] = useState<CaptureType>('job_card_folding');
  const [dark, setDark] = useState(false);

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
    setDark(document.documentElement.dataset.theme === 'dark');
    setMounted(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  const go = useCallback((t: Tab) => {
    setTab(t);
    store.set('tb-tab', t);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const setRole = (r: Role) => {
    setRoleState(r);
    store.set('tb-role', r);
    setTab(HOME_TAB[r]);
    store.set('tb-tab', HOME_TAB[r]);
    setSheet(null);
  };
  const setLang = (l: Lang) => { setLangState(l); store.set('tb-lang', l); };
  const setRate = (r: number | null) => { setRateState(r); store.set('tb-rate', r == null ? null : String(r)); };
  const setWorkerId = (id: string) => { setWorkerIdState(id); store.set('tb-worker', id); };

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? 'dark' : 'light';
    store.set('tb-theme', next ? 'dark' : 'light');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next ? '#111210' : '#F3F0E8');
  };

  const days = useMemo(() => d.workers.map((w) => workerDay(w, d.allotments, d.jobCards, d.cctv)), [d.workers, d.allotments, d.jobCards, d.cctv]);
  const me = useMemo(() => {
    if (!d.workers.length) return null;
    return d.workers.find((w) => w.id === workerId)
      ?? d.workers.find((w) => sectionName(w.section) === 'Folding')
      ?? d.workers[0];
  }, [d.workers, workerId]);

  const ctx: Ctx = { role, d, go, days, me, lang, setLang, rate: role === 'owner' ? rate : null, setRate, openSheet: setSheet, capType, setCapType };
  const safeTab: Tab = tabAllowed(role, tab) ? tab : HOME_TAB[role];

  let screen: React.ReactNode = null;
  switch (safeTab) {
    case 'overview': screen = <Overview ctx={ctx} />; break;
    case 'stock': screen = <Stock ctx={ctx} />; break;
    case 'jobs': screen = <JobCards ctx={ctx} />; break;
    case 'review': screen = <Review ctx={ctx} />; break;
    case 'ask': screen = <Ask ctx={ctx} />; break;
    case 'people': screen = <People ctx={ctx} />; break;
    case 'access': screen = <Access ctx={ctx} />; break;
    case 'floor': screen = <Floor ctx={ctx} />; break;
    case 'allot': screen = <Allot ctx={ctx} />; break;
    case 'shift': screen = <Shift ctx={ctx} />; break;
    case 'capture': screen = <Capture ctx={ctx} />; break;
    case 'history': screen = <History ctx={ctx} />; break;
  }

  return (
    <>
      <Shell ctx={ctx} tab={safeTab} dark={dark} toggleTheme={toggleTheme} setRole={setRole} workerId={me?.id ?? null} setWorkerId={setWorkerId}>
        {!mounted || (d.loading && !d.lastSync) ? (
          <div className="page"><div className="loading"><span className="spinner" />Loading floor data…</div></div>
        ) : (
          <div key={`${role}-${safeTab}`}>{screen}</div>
        )}
      </Shell>

      <Sheet open={sheet === 'stock' && can(role, 'ledger.edit')} title="Manual stock entry" onClose={() => setSheet(null)}>
        <StockForm ctx={ctx} onDone={() => setSheet(null)} />
      </Sheet>
      <Sheet open={sheet === 'job' && can(role, 'jobs.manage')} title="New job card" onClose={() => setSheet(null)}>
        <AllotForm ctx={ctx} onDone={() => setSheet(null)} />
      </Sheet>

      {d.toast && (
        <div className={`toast ${d.toast.tone}`} role="status">
          <Icon name={d.toast.tone === 'success' ? 'check' : 'alert'} size={16} strokeWidth={2.2} />
          <span>{d.toast.text}</span>
        </div>
      )}
    </>
  );
}
