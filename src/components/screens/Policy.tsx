'use client';

// My firm → Policy (owner): the firm's rules (flags, auto-saving photo reads, time-saved baseline),
// stock alerts, and firm knowledge notes the chat answers from.
import React, { useCallback, useEffect, useState } from 'react';
import Icon from '../Icon';
import type { Ctx } from '../ctx';
import type { KnowledgeDoc } from '@/lib/useTextileData';
import { LIMITS } from '@/lib/config';
import { StockAlerts } from './MasterData';
import { Toggle } from './MyFirm';

export function PolicyPart({ ctx }: { ctx: Ctx }) {
  return (
    <div className="settings-grid">
      <Rules ctx={ctx} />
      <StockAlerts ctx={ctx} />
      <Knowledge ctx={ctx} />
    </div>
  );
}

function Rules({ ctx }: { ctx: Ctx }) {
  const cfg = ctx.d.config;
  const api = ctx.d.settingsApi;
  const [shortage, setShortage] = useState(String(cfg.rules.shortageLimitPct));
  const [efficiency, setEfficiency] = useState(String(cfg.rules.efficiencyTargetPct));
  const [autoPct, setAutoPct] = useState(String(cfg.rules.aiAutoConfirmPct));
  const [challanMin, setChallanMin] = useState(String(cfg.rules.manualChallanMin));
  const [jobCardMin, setJobCardMin] = useState(String(cfg.rules.manualJobCardMin));
  const rulesDirty = shortage !== String(cfg.rules.shortageLimitPct) || efficiency !== String(cfg.rules.efficiencyTargetPct) || autoPct !== String(cfg.rules.aiAutoConfirmPct)
    || challanMin !== String(cfg.rules.manualChallanMin) || jobCardMin !== String(cfg.rules.manualJobCardMin);
  return (
    <section className="card pad stack-16">
      <div className="stack-4"><h2 className="h2">Rules</h2><span className="muted small">Limits used for flags and automatic saving.</span></div>
      <label className="fld">Shortage limit (%)<input className="num" inputMode="decimal" value={shortage} onChange={(e) => setShortage(e.target.value)} />
        <span className="muted small">A job card losing more than this is flagged. Allowed {LIMITS.shortageLimitPct.min}–{LIMITS.shortageLimitPct.max}.</span></label>
      <label className="fld">Worker efficiency target (%)<input className="num" inputMode="decimal" value={efficiency} onChange={(e) => setEfficiency(e.target.value)} />
        <span className="muted small">A worker’s day below this is flagged.</span></label>
      <div className="two-col">
        <label className="fld">Manual minutes per challan<input className="num" inputMode="decimal" value={challanMin} onChange={(e) => setChallanMin(e.target.value)} /></label>
        <label className="fld">Manual minutes per job card<input className="num" inputMode="decimal" value={jobCardMin} onChange={(e) => setJobCardMin(e.target.value)} /></label>
      </div>
      <span className="muted small" style={{ marginTop: -8 }}>How long entering one by hand takes. Used for the time-saved figure.</span>
      <label className="fld">Auto-confirm photo reads (%)<input className="num" inputMode="decimal" value={autoPct} onChange={(e) => setAutoPct(e.target.value)} />
        <span className="muted small">Photo reads at or above this confidence are saved without review. Allowed {LIMITS.aiAutoConfirmPct.min}–{LIMITS.aiAutoConfirmPct.max}; 100 = always review.</span></label>
      <div className="row-8"><button className="btn primary" disabled={!rulesDirty} onClick={() => api.updateFirm({ shortage_limit_pct: shortage, efficiency_target_pct: efficiency, ai_auto_confirm_pct: autoPct, manual_challan_min: challanMin, manual_job_card_min: jobCardMin })}>Save rules</button></div>
    </section>
  );
}

/** Firm notes the chat answers policy / how-to questions from. */
function Knowledge({ ctx }: { ctx: Ctx }) {
  const api = ctx.d.settingsApi;
  const [docs, setDocs] = useState<KnowledgeDoc[] | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const load = useCallback(async () => { try { setDocs(await api.knowledge()); } catch { setDocs([]); } }, [api]);
  useEffect(() => { let alive = true; api.knowledge().then((x) => { if (alive) setDocs(x); }).catch(() => { if (alive) setDocs([]); }); return () => { alive = false; }; }, [api]);
  return (
    <section className="card pad stack-16">
      <div className="stack-4"><h2 className="h2">Firm knowledge</h2><span className="muted small">Short notes (policies, party terms, how-tos). Chat answers from these.</span></div>
      <div className="list">
        {docs == null && <span className="muted small">Loading…</span>}
        {docs?.map((k) => (
          <div key={k.id} className={`list-row wrap ${k.active ? '' : 'off'}`}>
            <button type="button" className="linkbtn strong left note-title" onClick={() => setOpen(open === k.id ? null : k.id)}>{k.title}</button>
            <Toggle on={k.active} label={`${k.title} active`} onChange={async (v) => { if (await api.updateKnowledge(k.id, { active: v })) load(); }} />
            {open === k.id && <p className="t2 small note-body">{k.body}</p>}
          </div>
        ))}
        {docs && !docs.length && <span className="muted small">No notes yet.</span>}
      </div>
      <form className="stack-10" onSubmit={async (e) => { e.preventDefault(); if (!title.trim() || !body.trim()) return; if (await api.addKnowledge(title.trim(), body.trim())) { setTitle(''); setBody(''); load(); } }}>
        <input className="input" aria-label="Note title" placeholder="Title, e.g. Payment terms" value={title} maxLength={150} onChange={(e) => setTitle(e.target.value)} />
        <textarea className="input" aria-label="Note text" rows={3} placeholder="The note…" value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} />
        <div className="row-8"><button className="btn primary" type="submit" disabled={!title.trim() || !body.trim()}><Icon name="plus" size={16} strokeWidth={2} />Add note</button></div>
      </form>
    </section>
  );
}
