'use client';

// My firm → Policy (owner): the firm's rules (flags, auto-saving photo reads, time-saved baseline),
// stock alerts, WhatsApp switches (reminders, dispatch messages, morning summary) and firm knowledge notes the chat answers from.
import React, { useCallback, useEffect, useState } from 'react';
import Icon from '../Icon';
import type { Ctx } from '../ctx';
import type { KnowledgeDoc } from '@/lib/useTextileData';
import { LIMITS } from '@/lib/config';
import { apiSend, useApi } from '@/lib/useApi';
import { Pill, dayTime } from '../ui';
import { StockAlerts } from './MasterData';
import { Toggle } from './MyFirm';

export function PolicyPart({ ctx }: { ctx: Ctx }) {
  return (
    <div className="settings-grid">
      <Rules ctx={ctx} />
      <StockAlerts ctx={ctx} />
      <WhatsAppCard ctx={ctx} />
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

// ---------- WhatsApp ----------
interface WaView {
  connected: boolean;
  settings: { auto_reminders: boolean; reminder_days: number; dispatch_messages: boolean; morning_summary: boolean; summary_extra: string[] };
  owner_phone: string | null; gap_days: number;
  incoming: { id: number; from: string; name: string | null; body: string; at: string }[];
}

/** Owner switches for messages the app sends on WhatsApp by itself, plus a test message. */
function WhatsAppCard({ ctx }: { ctx: Ctx }) {
  const [tick, setTick] = useState(0);
  const { data, error } = useApi<WaView>(ctx.role === 'owner' ? '/api/whatsapp' : null, tick);
  if (ctx.role !== 'owner') return null;
  if (error) return <section className="card pad"><span className="muted small">{error}</span></section>;
  if (!data) return <section className="card pad"><span className="muted small">Loading WhatsApp…</span></section>;
  return <WhatsAppForm key={JSON.stringify(data.settings)} ctx={ctx} v={data} onSaved={() => setTick((t) => t + 1)} />;
}

function WhatsAppForm({ ctx, v, onSaved }: { ctx: Ctx; v: WaView; onSaved: () => void }) {
  const st = v.settings;
  const [days, setDays] = useState(String(st.reminder_days));
  const [extra, setExtra] = useState(st.summary_extra.join(', '));
  const [busy, setBusy] = useState<string | null>(null);
  const save = async (body: Record<string, unknown>, ok: string) => {
    setBusy(Object.keys(body)[0]);
    try { await apiSend('/api/whatsapp', 'PUT', body); ctx.d.showToast(ok); onSaved(); } catch (e) { ctx.d.showToast(e instanceof Error ? e.message : 'Could not save.', 'danger'); } finally { setBusy(null); }
  };
  const test = async () => {
    setBusy('test');
    try { const r = await apiSend<{ message: string }>('/api/whatsapp/test', 'POST', {}); ctx.d.showToast(r.message); onSaved(); } catch (e) { ctx.d.showToast(e instanceof Error ? e.message : 'Could not send.', 'danger'); } finally { setBusy(null); }
  };
  const row = (key: 'auto_reminders' | 'dispatch_messages' | 'morning_summary', title: string, sub: React.ReactNode) => (
    <div className="wa-row">
      <div className="stack-2 grow min0"><span className="strong">{title}</span><span className="muted small">{sub}</span></div>
      <Toggle on={st[key]} label={title} onChange={(on) => { if (!busy) void save({ [key]: on }, `${title}: ${on ? 'on' : 'off'}`); }} />
    </div>
  );
  const daysDirty = days !== String(st.reminder_days);
  const extraDirty = extra.trim() !== st.summary_extra.join(', ');
  return (
    <section className="card pad stack-16" data-wa-card>
      <div className="wa-head">
        <div className="stack-4 min0"><h2 className="h2">WhatsApp</h2><span className="muted small">Messages the app sends for you on WhatsApp.</span></div>
        <Pill tone={v.connected ? 'good' : 'neutral'}>{v.connected ? 'Connected' : 'Not connected'}</Pill>
      </div>
      {!v.connected && <div className="alert wa-note">WhatsApp not connected. Reminders open in WhatsApp for you to send yourself. Your developer can connect it; these switches work once it is.</div>}
      <div className="stack-12">
        {row('auto_reminders', 'Payment reminders by themselves', <>Every morning, to parties with a bill overdue by {st.reminder_days}+ days. Each party at most once in {v.gap_days} days.</>)}
        {st.auto_reminders && (
          <form className="wa-inline" onSubmit={(e) => { e.preventDefault(); void save({ reminder_days: Number(days) }, 'Days saved'); }}>
            <label className="fld">Overdue by at least (days)<input className="num" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} /></label>
            <button className="btn" type="submit" disabled={!daysDirty || busy != null}>Save</button>
          </form>
        )}
        {row('dispatch_messages', 'Dispatch message to the party', 'When a dispatch is saved: challan no., date, lots, meters and transport. No rates or ₹. Parties without a mobile number are skipped.')}
        {row('morning_summary', 'Morning summary to me', <>About 7 am: stock, yesterday in / out, orders due, overdue payments, alerts.{v.owner_phone ? ` To ${v.owner_phone}.` : ' Add your mobile number in My firm → Team first.'}</>)}
        {st.morning_summary && (
          <form className="wa-inline" onSubmit={(e) => { e.preventDefault(); void save({ summary_extra: extra.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean) }, 'Numbers saved'); }}>
            <label className="fld">Also send to (optional)<input inputMode="tel" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="98250 12345, 98790 54321" /><span className="muted small">Up to 5 mobile numbers, comma between them.</span></label>
            <button className="btn" type="submit" disabled={!extraDirty || busy != null}>Save</button>
          </form>
        )}
      </div>
      <div className="row-8" style={{ flexWrap: 'wrap' }}>
        <button className="btn" disabled={!v.connected || busy != null} onClick={test}>{busy === 'test' ? 'Sending…' : 'Send me a test message'}</button>
        {v.connected && !v.owner_phone && <span className="muted small">Needs your mobile number.</span>}
      </div>
      {v.incoming.length > 0 && (
        <div className="stack-8">
          <span className="strong small">Last messages received</span>
          <div className="list">
            {v.incoming.map((m) => (
              <div key={m.id} className="list-row wa-msg">
                <div className="stack-2 grow min0"><span className="small"><b>{m.name ?? m.from}</b>{m.name ? <span className="muted"> · {m.from}</span> : null}</span><span className="t2 small wa-body">{m.body}</span></div>
                <span className="muted tiny">{dayTime(m.at)}</span>
              </div>
            ))}
          </div>
          <span className="muted tiny">The app only keeps these here — it does not answer them. Call or message the party yourself.</span>
        </div>
      )}
    </section>
  );
}
