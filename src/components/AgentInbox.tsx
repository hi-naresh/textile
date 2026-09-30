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
import { apiSend } from '@/lib/useApi';
import { actorId } from '@/lib/useTextileData';

export interface Suggestion {
  id: number; agent: string; kind: string; severity: 'info' | 'warn' | 'bad'; title: string; detail: string | null;
  target_type: string | null; target_id: string | null; action_label: string | null; owner_only: boolean;
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
    fetch(`/api/agents/suggestions?role=${role}`, { cache: 'no-store' })
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j?.error || 'Could not load.'); return j as { suggestions: Suggestion[] }; })
      .then((j) => { if (alive) { setList(j.suggestions ?? []); setLoaded(true); } })
      .catch(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [role, refreshKey, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { list, loaded, reload };
}

const AGENT_LABEL: Record<string, string> = {
  inquiry: 'Inquiries', orders: 'Orders', allocation: 'Allocation', inventory: 'Inventory', logistics: 'Dispatch',
  documents: 'Documents', costing: 'Costing', reports: 'Reports', credit: 'Credit',
};

/** Where "Open" takes you for each kind of target. Screens read the hash to open the right item. */
function destination(s: Suggestion, role: Role): { tab: Tab; hash?: string } | null {
  switch (s.target_type) {
    case 'order': return { tab: 'orders', hash: `order=${s.target_id}` };
    case 'inquiry': return { tab: 'orders', hash: `inquiry=${s.target_id}` };
    case 'dispatch': return { tab: 'dispatch', hash: `dispatch=${s.target_id}` };
    case 'party': return role === 'owner' ? { tab: 'money', hash: `party=${s.target_id}` } : null;
    case 'report': return role === 'owner' ? { tab: 'reports', hash: `report=${s.target_id}` } : null;
    case 'quality': case 'mill': return role === 'owner' ? { tab: 'reports' } : null;
    case 'section': return role === 'owner' ? { tab: 'firm', hash: 'firm=team' } : null;
    case 'lot': return role === 'owner' ? { tab: 'stock' } : null;
    default: return null;
  }
}

export default function AgentInbox({ ctx, limit = 8, empty = null, onNavigate }: { ctx: Ctx; limit?: number; empty?: React.ReactNode; onNavigate?: () => void }) {
  const { role, d, go, agents } = ctx;
  const [busy, setBusy] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const list = agents.list;
  if (!list.length) return agents.loaded ? <>{empty}</> : null;

  const open = (s: Suggestion) => {
    const dest = destination(s, role);
    if (!dest) return;
    if (dest.hash) window.history.replaceState(null, '', `#${dest.hash}`);
    onNavigate?.();
    go(dest.tab);
  };
  const decide = async (s: Suggestion, action: 'accept' | 'reject') => {
    setBusy(s.id);
    try {
      const r = await apiSend<{ message: string }>('/api/agents/suggestions', 'POST', { id: s.id, action, role, actor: actorId(role) });
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
          </div>
          <div className="attn-actions">
            {s.action_label && <button className="btn sm primary" disabled={busy === s.id} onClick={() => decide(s, 'accept')}>{s.action_label}</button>}
            {!s.action_label && destination(s, role) && <button className="btn sm" onClick={() => open(s)}>Open</button>}
            <button className="ib sm-ib" aria-label="Dismiss" title="Dismiss" disabled={busy === s.id} onClick={() => decide(s, 'reject')}><Icon name="x" size={14} /></button>
          </div>
        </div>
      ))}
      {list.length > limit && <button className="linkbtn small left" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${list.length}`}</button>}
    </div>
  );
}

// ---------- Floor items (from the app's own data, no agent needed) ----------
export interface AttentionItem { key: string; tone: 'bad' | 'warn' | 'info'; title: string; sub: string; action: string; tab: Tab; hash?: string }

/** What the owner (whole firm) or a supervisor (own sections) should look at now. */
export function useAttentionItems(ctx: Ctx, opts: { reads?: boolean } = {}): AttentionItem[] {
  const { role, d, days } = ctx;
  const withReads = opts.reads !== false;
  return useMemo(() => {
    if (role === 'worker') return [];
    const items: AttentionItem[] = [];
    const owner = role === 'owner';
    if (owner && ctx.signups > 0) {
      items.push({ key: 'signups', tone: 'warn', title: `${ctx.signups} sign up${ctx.signups > 1 ? 's' : ''} waiting for approval`, sub: 'New supervisors or workers asking to use the app', action: 'Approve', tab: 'firm', hash: 'firm=team' });
    }
    const limit = rules().shortageLimitPct;
    d.jobCards.filter((j) => j.flagged && jobInScope(role, j)).slice(0, 2).forEach((j) =>
      items.push({ key: `jc-${j.id}`, tone: 'bad', title: `Shortage ${j.shortage_pct.toFixed(1)}% on ${j.lot_id}`, sub: `${j.process} · JC-${j.id} · above ${limit}% limit`, action: 'Open', tab: 'jobs' }));
    const pending = d.captures.filter((c) => c.status === 'pending' && captureInScope(role, c.type));
    if (withReads && pending.length) {
      const autoPct = rules().aiAutoConfirmPct;
      const lowConf = pending.filter((c) => c.confidence * 100 < autoPct).length;
      items.push({ key: 'reads', tone: 'warn', title: `${pending.length} photo read${pending.length > 1 ? 's' : ''} waiting for review`, sub: lowConf ? `${lowConf} below ${autoPct}% confidence` : `All above ${autoPct}% confidence`, action: 'Review', tab: 'review' });
    }
    const crew = owner ? days : days.filter((x) => inSupervisorScope(x.section));
    crew.filter((x) => x.cam && x.cam.active_pct < 60).slice(0, 2).forEach((x) =>
      items.push({ key: `idle-${x.worker.id}`, tone: 'warn', title: `${x.worker.name} idle ${Math.round(x.cam!.idle_min)} min`, sub: `CCTV · ${x.cam!.station} · ${x.section}`, action: 'View', tab: owner ? 'people' : 'floor' }));
    if (owner) {
      d.lots.filter((l) => l.balance > 0 && l.balance < 200).slice(0, 1).forEach((l) =>
        items.push({ key: `low-${l.lot_id}`, tone: 'info', title: `${l.lot_id} running low`, sub: `${fmtM(l.balance)} left · ${l.quality}`, action: 'Ledger', tab: 'stock' }));
    }
    return items;
  }, [role, d.jobCards, d.captures, d.lots, days, withReads, ctx.signups]);
}

/** The full list: floor items first, then agent suggestions. */
export function AttentionList({ ctx, onNavigate, emptyText = 'All clear. Nothing needs you right now.', reads = true }: { ctx: Ctx; onNavigate?: () => void; emptyText?: string; reads?: boolean }) {
  const items = useAttentionItems(ctx, { reads });
  return (
    <div className="stack-8">
      {items.map((a) => (
        <div className="attn" key={a.key}>
          <span className={`dot-sm ${a.tone}`} />
          <div className="grow min0">
            <div className="attn-title">{a.title}</div>
            <div className="attn-sub">{a.sub}</div>
          </div>
          <button className="btn sm" onClick={() => { if (a.hash) window.history.replaceState(null, '', `#${a.hash}`); onNavigate?.(); ctx.go(a.tab); }}>{a.action}</button>
        </div>
      ))}
      <AgentInbox ctx={ctx} onNavigate={onNavigate} empty={items.length === 0 ? <p className="muted" style={{ margin: 0 }}>{emptyText}</p> : null} />
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
