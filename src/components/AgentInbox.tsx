'use client';

// Alerts + suggested actions raised by the Phase 2 agents ("invisible automation" surface).
// Shown inside "Needs your attention" (owner) and on the supervisor's Floor screen.
import React, { useState } from 'react';
import Icon from './Icon';
import { Pill } from './ui';
import type { Ctx } from './ctx';
import type { Tab } from '@/lib/access';
import { apiSend, useApi } from '@/lib/useApi';
import { actorId } from '@/lib/useTextileData';

interface Suggestion {
  id: number; agent: string; kind: string; severity: 'info' | 'warn' | 'bad'; title: string; detail: string | null;
  target_type: string | null; target_id: string | null; action_label: string | null; owner_only: boolean;
}

const AGENT_LABEL: Record<string, string> = {
  inquiry: 'Inquiries', orders: 'Orders', allocation: 'Allocation', inventory: 'Inventory', logistics: 'Dispatch',
  documents: 'Documents', costing: 'Costing', reports: 'Reports', credit: 'Credit',
};

/** Where "Open" takes you for each kind of target. Screens read the hash to open the right item. */
function destination(s: Suggestion): { tab: Tab; hash?: string } | null {
  switch (s.target_type) {
    case 'order': return { tab: 'orders', hash: `order=${s.target_id}` };
    case 'inquiry': return { tab: 'orders', hash: `inquiry=${s.target_id}` };
    case 'dispatch': return { tab: 'dispatch', hash: `dispatch=${s.target_id}` };
    case 'party': return { tab: 'money', hash: `party=${s.target_id}` };
    case 'report': return { tab: 'reports', hash: `report=${s.target_id}` };
    case 'quality': case 'mill': return s.kind === 'missing_rate' ? { tab: 'settings' } : { tab: 'reports' };
    case 'section': return { tab: 'settings' };
    case 'lot': return { tab: 'stock' };
    default: return null;
  }
}

export default function AgentInbox({ ctx, limit = 8, empty = null }: { ctx: Ctx; limit?: number; empty?: React.ReactNode }) {
  const { role, d, go } = ctx;
  const { data, reload } = useApi<{ suggestions: Suggestion[] }>(role === 'worker' ? null : `/api/agents/suggestions?role=${role}`, d.lastSync);
  const [busy, setBusy] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const list = data?.suggestions ?? [];
  if (!list.length) return data ? <>{empty}</> : null;

  const decide = async (s: Suggestion, action: 'accept' | 'reject') => {
    setBusy(s.id);
    try {
      const r = await apiSend<{ message: string }>('/api/agents/suggestions', 'POST', { id: s.id, action, role, actor: actorId(role) });
      d.showToast(r.message, 'success');
      reload();
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
  const open = (s: Suggestion) => {
    const dest = destination(s);
    if (!dest) return;
    if (dest.hash) window.history.replaceState(null, '', `#${dest.hash}`);
    go(dest.tab);
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
            {!s.action_label && destination(s) && <button className="btn sm" onClick={() => open(s)}>Open</button>}
            <button className="ib sm-ib" aria-label="Dismiss" title="Dismiss" disabled={busy === s.id} onClick={() => decide(s, 'reject')}><Icon name="x" size={14} /></button>
          </div>
        </div>
      ))}
      {list.length > limit && <button className="linkbtn small left" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${list.length}`}</button>}
    </div>
  );
}
