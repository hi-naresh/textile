'use client';

// "Needs your attention": floor items (shortage, photo reads, idle workers, low stock) + alerts and
// suggested actions raised by the Phase 2 agents. Shown on the owner's Overview, on the supervisor's
// Floor screen and in the bell panel (Shell). The agent list is loaded once in page.tsx (ctx.agents)
// so every place shows the same items and a dismiss in one place updates the others.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from './Icon';
import { Pill, Segmented, Sheet, fmtM } from './ui';
import { ReviewQueue } from './screens/Shared';
import type { Ctx } from './ctx';
import { captureInScope, inSupervisorScope, jobInScope, rules, type Role, type Tab } from '@/lib/access';
import { apiSend, openLink } from '@/lib/useApi';
import { actorId } from '@/lib/useTextileData';

export interface Suggestion {
  id: number; agent: string; kind: string; severity: 'info' | 'warn' | 'bad'; title: string; detail: string | null;
  target_type: string | null; target_id: string | null; action_label: string | null; owner_only: boolean;
  /** hint: what the button will do · dismiss_label: meaning of dismiss (e.g. "Not for an order") · choices: other buttons. */
  payload?: { hint?: string; dismiss_label?: string; open_label?: string; choices?: { value: number; label: string }[] } & Record<string, unknown> | null;
}

/** Open agent suggestions for the signed-in role (loaded by page.tsx, shared through ctx). */
export interface AgentFeed { list: Suggestion[]; loaded: boolean; reload: () => void }

export function useAgentFeed(role: Role, refreshKey: unknown): AgentFeed {
  const [list, setList] = useState<Suggestion[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (role === 'worker') return;
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | null = null;
    fetch(`/api/agents/suggestions?role=${role}`, { cache: 'no-store' })
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j?.error || 'Could not load.'); return j as { suggestions: Suggestion[]; refreshing?: boolean }; })
      .then((j) => {
        if (!alive) return;
        setList(j.suggestions ?? []); setLoaded(true);
        // The agents are checking in the background: ask again once they are done.
        if (j.refreshing) retry = setTimeout(() => { if (alive) setTick((t) => t + 1); }, 4000);
      })
      .catch(() => { if (alive) setLoaded(true); });
    return () => { alive = false; if (retry) clearTimeout(retry); };
  }, [role, refreshKey, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { list, loaded, reload };
}

const AGENT_LABEL: Record<string, string> = {
  inquiry: 'Inquiries', orders: 'Orders', allocation: 'Reservations', inventory: 'Stock', logistics: 'Dispatch',
  documents: 'Invoices', costing: 'Margin', reports: 'Reports', credit: 'Payments',
};

/** Where "Open" takes you for each kind of target. Screens read the hash to open the right item. */
function destination(s: Suggestion, role: Role): { tab: Tab; hash?: string } | null {
  // Old-stock summary: the full list of old lots is in Reports → Inventory (not one lot's ledger).
  if (s.kind === 'ageing_stock') return role === 'owner' ? { tab: 'reports', hash: 'inventory=ageing' } : null;
  switch (s.target_type) {
    case 'order': return { tab: 'orders', hash: `order=${s.target_id}` };
    case 'inquiry': return { tab: 'orders', hash: `inquiry=${s.target_id}` };
    case 'dispatch': return { tab: 'dispatch', hash: `dispatch=${s.target_id}` };
    case 'party': return role === 'owner' ? { tab: 'money', hash: `party=${s.target_id}` } : null;
    case 'report': return role === 'owner' ? { tab: 'reports', hash: `report=${s.target_id}` } : null;
    case 'quality': case 'mill': return role === 'owner' ? { tab: 'reports' } : null;
    case 'section': return role === 'owner' ? { tab: 'firm', hash: 'firm=team' } : null;
    case 'lot': return role === 'owner' ? { tab: 'stock', hash: s.target_id ? `ledger=${encodeURIComponent(new URLSearchParams({ view: 'moves', lot: s.target_id, focus: s.target_id }).toString())}` : undefined } : null;
    default: return null;
  }
}

export default function AgentInbox({ ctx, limit = 8, empty = null, onNavigate, only }: { ctx: Ctx; limit?: number; empty?: React.ReactNode; onNavigate?: () => void; only?: Suggestion[] }) {
  const { role, d, go, agents } = ctx;
  const [busy, setBusy] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const list = only ?? agents.list;
  if (!list.length) return agents.loaded ? <>{empty}</> : null;

  const open = (s: Suggestion) => {
    const dest = destination(s, role);
    if (!dest) return;
    onNavigate?.();
    openLink(go, dest.tab, dest.hash); // sets the hash + tells an already-open screen to read it
  };
  const decide = async (s: Suggestion, action: 'accept' | 'reject', choice?: number) => {
    setBusy(s.id);
    try {
      const r = await apiSend<{ message: string }>('/api/agents/suggestions', 'POST', { id: s.id, action, choice, role, actor: actorId(role) });
      d.showToast(r.message, 'success');
      agents.reload();
      if (action === 'accept') {
        await d.refresh();
        if (s.agent === 'credit') open(s); // reminder lives in Money → Outstanding
      }
    } catch (e) {
      d.showToast(e instanceof Error ? e.message : 'Could not do that.', 'danger');
    } finally {
      setBusy(null);
    }
  };
  const shown = all ? list : list.slice(0, limit);

  return (
    <div className="stack-8 agent-inbox">
      {shown.map((s) => (
        <div className="attn" key={s.id}>
          <span className={`dot-sm ${s.severity}`} />
          <div className="grow min0">
            <div className="attn-title">{s.title}</div>
            <div className="attn-sub"><Pill className="agent-tag">{AGENT_LABEL[s.agent] ?? s.agent}</Pill>{s.detail ? ` ${s.detail}` : ''}</div>
            {s.payload?.hint && <div className="attn-hint">{s.payload.hint}</div>}
          </div>
          <div className="attn-actions">
            {s.action_label && <button className="btn sm primary" disabled={busy === s.id} onClick={() => decide(s, 'accept')}>{s.action_label}</button>}
            {s.action_label && s.payload?.choices?.map((c) => <button key={c.value} className="btn sm attn-alt" disabled={busy === s.id} onClick={() => decide(s, 'accept', c.value)}>{c.label}</button>)}
            {destination(s, role) && (
              s.action_label
                ? <button className="linkbtn small attn-open" onClick={() => open(s)}>{s.payload?.open_label ?? (s.target_type === 'order' ? 'Open order' : 'Open')}</button>
                : <button className="btn sm" onClick={() => open(s)}>{s.payload?.open_label ?? 'Open'}</button>
            )}
            {s.payload?.dismiss_label
              ? <button className="btn sm" disabled={busy === s.id} onClick={() => decide(s, 'reject')}>{s.payload.dismiss_label}</button>
              : <button className="ib sm-ib" aria-label="Dismiss" title="Dismiss" disabled={busy === s.id} onClick={() => decide(s, 'reject')}><Icon name="x" size={14} /></button>}
          </div>
        </div>
      ))}
      {list.length > limit && <button className="linkbtn small left" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${list.length}`}</button>}
    </div>
  );
}

// ---------- Floor items (from the app's own data, no agent needed) ----------
export interface AttentionItem { key: string; tone: 'bad' | 'warn' | 'info'; title: string; sub: string; action: string; tab: Tab; hash?: string; cat?: CatKey }

/** What the owner (whole firm) or a supervisor (own sections) should look at now. */
export function useAttentionItems(ctx: Ctx, opts: { reads?: boolean } = {}): AttentionItem[] {
  const { role, d, days } = ctx;
  const withReads = opts.reads !== false;
  return useMemo(() => {
    if (role === 'worker') return [];
    const items: AttentionItem[] = [];
    const owner = role === 'owner';
    if (owner && ctx.signups > 0) {
      items.push({ key: 'signups', tone: 'warn', title: `${ctx.signups} sign up${ctx.signups > 1 ? 's' : ''} waiting for approval`, sub: 'New supervisors or workers asking to use the app', action: 'Approve', tab: 'firm', hash: 'firm=team', cat: 'team' });
    }
    const limit = rules().shortageLimitPct;
    d.jobCards.filter((j) => j.flagged && jobInScope(role, j)).slice(0, 2).forEach((j) =>
      items.push({ key: `jc-${j.id}`, tone: 'bad', title: `Shortage ${j.shortage_pct.toFixed(1)}% on ${j.lot_id}`, sub: `${j.process} · JC-${j.id} · above ${limit}% limit`, action: 'Open', tab: 'jobs', cat: 'floor' }));
    const pending = d.captures.filter((c) => c.status === 'pending' && captureInScope(role, c.type));
    if (withReads && pending.length) {
      const autoPct = rules().aiAutoConfirmPct;
      const lowConf = pending.filter((c) => c.confidence * 100 < autoPct).length;
      items.push({ key: 'reads', tone: 'warn', title: `${pending.length} photo read${pending.length > 1 ? 's' : ''} waiting for review`, sub: lowConf ? `${lowConf} below ${autoPct}% confidence` : `All above ${autoPct}% confidence`, action: 'Review', tab: 'review', cat: 'floor' });
    }
    const crew = owner ? days : days.filter((x) => inSupervisorScope(x.section));
    crew.filter((x) => x.cam && x.cam.active_pct < 60).slice(0, 2).forEach((x) =>
      items.push({ key: `idle-${x.worker.id}`, tone: 'warn', title: `${x.worker.name} idle ${Math.round(x.cam!.idle_min)} min`, sub: `CCTV · ${x.cam!.station} · ${x.section}`, action: 'View', tab: owner ? 'people' : 'floor', cat: 'floor' }));
    if (owner) {
      (d.stockSummary?.low_lots ?? []).slice(0, 1).forEach((l) =>
        items.push({
          key: `low-${l.lot_id}`, tone: 'info', title: `${l.lot_id} running low — ${fmtM(l.balance)} left`,
          sub: `${l.quality} · below your low-stock level, so it may not cover the next order. "Open lot" shows this lot's entries in the Stock ledger.`,
          action: 'Open lot', tab: 'stock', cat: 'stock',
          hash: `ledger=${encodeURIComponent(new URLSearchParams({ view: 'moves', lot: l.lot_id, focus: l.lot_id }).toString())}`,
        }));
    }
    return items;
  }, [role, d.jobCards, d.captures, d.stockSummary, days, withReads, ctx.signups]);
}

// ---------- Categories: the bell's Alerts tab groups everything by area ----------
export type CatKey = 'payments' | 'orders' | 'stock' | 'dispatch' | 'floor' | 'team' | 'reports' | 'other';
export const CATS: { key: CatKey; label: string; icon: string; agents: string[] }[] = [
  { key: 'payments', label: 'Payments', icon: 'rupee', agents: ['credit'] },
  { key: 'orders', label: 'Orders & inquiries', icon: 'cart', agents: ['orders', 'inquiry'] },
  { key: 'stock', label: 'Stock', icon: 'box', agents: ['inventory', 'allocation'] },
  { key: 'dispatch', label: 'Dispatch & invoices', icon: 'truck', agents: ['logistics', 'documents'] },
  { key: 'floor', label: 'Floor', icon: 'factory', agents: [] },
  { key: 'team', label: 'Team', icon: 'users', agents: [] },
  { key: 'reports', label: 'Reports', icon: 'chart', agents: ['reports', 'costing'] },
  { key: 'other', label: 'Other', icon: 'alert', agents: [] },
];
export const catOfAgent = (agent: string): CatKey => CATS.find((c) => c.agents.includes(agent))?.key ?? 'other';
const SEV: Record<string, number> = { bad: 0, warn: 1, info: 2 };

/** Everything that needs attention, grouped by category (worst first inside each), with a category filter on top. */
export function AttentionList({ ctx, onNavigate, emptyText = 'All clear. Nothing needs you right now.', reads = true }: { ctx: Ctx; onNavigate?: () => void; emptyText?: string; reads?: boolean }) {
  const items = useAttentionItems(ctx, { reads });
  const agentList = ctx.agents.list;
  const [pick, setPick] = useState<CatKey | 'all'>('all');
  const groups = useMemo(() => CATS.map((c) => ({
    ...c,
    floor: items.filter((i) => (i.cat ?? 'other') === c.key).sort((a, b) => SEV[a.tone] - SEV[b.tone]),
    sugg: agentList.filter((s) => catOfAgent(s.agent) === c.key).sort((a, b) => SEV[a.severity] - SEV[b.severity]),
  })).map((g) => ({ ...g, n: g.floor.length + g.sugg.length, bad: g.floor.some((i) => i.tone === 'bad') || g.sugg.some((s) => s.severity === 'bad') }))
    .filter((g) => g.n > 0), [items, agentList]);
  const total = groups.reduce((t, g) => t + g.n, 0);
  if (!total) return ctx.agents.loaded || items.length ? <p className="muted" style={{ margin: 0 }}>{emptyText}</p> : null;
  const current = pick !== 'all' && groups.some((g) => g.key === pick) ? pick : 'all';
  const shown = current === 'all' ? groups : groups.filter((g) => g.key === current);
  return (
    <div className="stack-12">
      {groups.length > 1 && (
        <div className="attn-cats" role="group" aria-label="Show category">
          <button type="button" className={`chip ${current === 'all' ? 'on' : ''}`} aria-pressed={current === 'all'} onClick={() => setPick('all')}>All <span className="num">{total}</span></button>
          {groups.map((g) => (
            <button key={g.key} type="button" className={`chip ${current === g.key ? 'on' : ''}`} aria-pressed={current === g.key} onClick={() => setPick(g.key)}>
              {g.bad && <span className="dot-sm bad" aria-hidden />}{g.label} <span className="num">{g.n}</span>
            </button>
          ))}
        </div>
      )}
      {shown.map((g) => (
        <section key={g.key} className="attn-group" aria-label={`${g.label}: ${g.n}`}>
          <div className="attn-group-head"><Icon name={g.icon} size={15} strokeWidth={2} /><span className="strong">{g.label}</span><span className="muted small num">{g.n}</span></div>
          <div className="stack-8">
            {g.floor.map((a) => (
              <div className="attn" key={a.key}>
                <span className={`dot-sm ${a.tone}`} />
                <div className="grow min0">
                  <div className="attn-title">{a.title}</div>
                  <div className="attn-sub">{a.sub}</div>
                </div>
                <button className="btn sm" onClick={() => { onNavigate?.(); if (a.hash) openLink(ctx.go, a.tab, a.hash); else ctx.go(a.tab); }}>{a.action}</button>
              </div>
            ))}
            {g.sugg.length > 0 && <AgentInbox ctx={ctx} onNavigate={onNavigate} only={g.sugg} limit={current === 'all' ? 4 : 50} />}
          </div>
        </section>
      ))}
    </div>
  );
}

/** Photo reads waiting in the signed-in person's review scope. */
export function usePendingReads(ctx: Ctx): number {
  const { d, role } = ctx;
  return useMemo(() => d.captures.filter((c) => c.status === 'pending' && captureInScope(role, c.type)).length, [d.captures, role]);
}

/** Bell badge: alerts (floor items + agent suggestions) and photo reads waiting for review. */
export function useAttentionCount(ctx: Ctx): { alerts: number; reads: number; total: number } {
  const items = useAttentionItems(ctx, { reads: false });
  const alerts = items.length + ctx.agents.list.length;
  const reads = usePendingReads(ctx);
  return { alerts, reads, total: alerts + reads };
}

/** The bell's panel: "Alerts" and "Review queue" side by side. Right drawer on desktop, sheet on phones. */
export function AttentionPanel({ ctx }: { ctx: Ctx }) {
  const { attention, openAttention } = ctx;
  const n = useAttentionCount(ctx);
  const close = () => openAttention(null);
  const count = (x: number) => (x > 0 ? <span className="seg-count num">{x > 99 ? '99+' : x}</span> : null);
  return (
    <Sheet wide open={attention != null} title={`Needs your attention${n.total > 0 ? ` (${n.total})` : ''}`} onClose={close}>
      {attention && (
        <div className="stack-16">
          <Segmented label="Show" value={attention} onChange={(t) => openAttention(t)} className="fit attn-tabs"
            options={[{ value: 'alerts', label: <>Alerts{count(n.alerts)}</> }, { value: 'review', label: <>Review queue{count(n.reads)}</> }]} />
          {attention === 'alerts' ? <AttentionList ctx={ctx} reads={false} onNavigate={close} /> : <ReviewQueue ctx={ctx} />}
        </div>
      )}
    </Sheet>
  );
}
