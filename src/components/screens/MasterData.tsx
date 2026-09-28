'use client';

// Owner Settings → master data: parties, selling rates, process costs, billing & GST, agent thresholds.
import React, { useState } from 'react';
import Icon from '../Icon';
import { Pill, Sheet, inr } from '../ui';
import type { Ctx } from '../ctx';
import { apiSend, useApi, who } from '@/lib/useApi';
import { actorId } from '@/lib/useTextileData';
import type { Party } from '@/lib/domain';
import type { BillingSettings, CostRow, QualityRate, RateRow, SectionCost } from '@/lib/money/master';
import { gstinValid } from '@/lib/money/validate';
import s from './Money.module.css';

type Send = (url: string, method: string, body: Record<string, unknown>, ok: string) => Promise<boolean>;

function useSend(ctx: Ctx, after: () => void): Send {
  return async (url, method, body, ok) => {
    try {
      await apiSend(url, method, { ...body, role: ctx.role, actor: actorId(ctx.role) });
      ctx.d.showToast(ok);
      after();
      return true;
    } catch (e) {
      ctx.d.showToast(e instanceof Error ? e.message : 'Could not save.', 'danger');
      return false;
    }
  };
}

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
      <span className="switch-knob" />
    </button>
  );
}

const shortDate = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '—');
const perM = (n: number | null | undefined) => (n == null ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}/m`);

export function MasterData({ ctx }: { ctx: Ctx }) {
  if (ctx.role !== 'owner') return null;
  return <OwnerMasterData ctx={ctx} />;
}

function OwnerMasterData({ ctx }: { ctx: Ctx }) {
  const [bump, setBump] = useState(0);
  const refresh = () => setBump((b) => b + 1);
  const key = `${ctx.d.lastSync?.getTime() ?? 0}:${bump}`;
  const q = who(ctx.role, actorId(ctx.role));
  const parties = useApi<{ parties: Party[] }>(`/api/parties?all=1&${q}`, key);
  const send = useSend(ctx, refresh);
  return (
    <div className="settings-grid">
      <Parties ctx={ctx} list={parties.data?.parties ?? null} send={send} />
      <Rates ctx={ctx} refreshKey={key} parties={parties.data?.parties ?? []} send={send} />
      <Costs ctx={ctx} refreshKey={key} send={send} />
      <Billing ctx={ctx} refreshKey={key} send={send} />
    </div>
  );
}

// ---------- Parties ----------
function Parties({ ctx, list, send }: { ctx: Ctx; list: Party[] | null; send: Send }) {
  const [search, setSearch] = useState('');
  const [edit, setEdit] = useState<Party | 'new' | null>(null);
  const [showAll, setShowAll] = useState(false);
  const k = search.trim().toLowerCase();
  const rows = (list ?? []).filter((p) => !k || [p.name, p.city, p.phone, p.gstin].some((x) => x?.toLowerCase().includes(k)));
  const shown = showAll || k ? rows : rows.slice(0, 12);
  void ctx;
  return (
    <section className={`card pad stack-16 ${s.full}`}>
      <div className={s.head}>
        <div className="stack-4 grow"><h2 className="h2">Parties</h2><span className="muted small">Clients you sell to: phone, GSTIN, credit limit and days.</span></div>
        <button className="btn primary" onClick={() => setEdit('new')}><Icon name="plus" size={16} strokeWidth={2} />Add party</button>
      </div>
      <input className={`input ${s.search}`} aria-label="Search parties" placeholder="Search name, city, phone or GSTIN" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="list">
        {list == null && <span className="muted small" style={{ padding: 14 }}>Loading…</span>}
        {shown.map((p) => (
          <div key={p.id} className={`list-row ${p.active ? '' : 'off'}`}>
            <div className={s.rowMain}>
              <span className="strong">{p.name}</span>
              <span className="muted tiny">{[p.city, p.phone, p.gstin].filter(Boolean).join(' · ') || 'No details yet'}</span>
            </div>
            {!p.active && <Pill>Off</Pill>}
            <span className="d"><Pill tone={p.credit_limit == null ? 'neutral' : 'info'}>{p.credit_limit == null ? 'No limit' : inr(p.credit_limit)} · {p.credit_days} d</Pill></span>
            <button type="button" className="ib sm-ib" aria-label={`Edit ${p.name}`} onClick={() => setEdit(p)}><Icon name="edit" size={15} /></button>
          </div>
        ))}
        {list && !rows.length && <span className="muted small" style={{ padding: 14 }}>{k ? 'No match.' : 'No parties yet.'}</span>}
      </div>
      {!showAll && !k && rows.length > 12 && <button className="linkbtn" onClick={() => setShowAll(true)}>Show all {rows.length}</button>}
      <Sheet open={edit != null} title={edit === 'new' ? 'Add party' : edit ? edit.name : ''} onClose={() => setEdit(null)}>
        {edit != null && <PartyForm key={edit === 'new' ? 'new' : edit.id} party={edit === 'new' ? null : edit} send={send} onDone={() => setEdit(null)} />}
      </Sheet>
    </section>
  );
}

function PartyForm({ party, send, onDone }: { party: Party | null; send: Send; onDone: () => void }) {
  const [f, setF] = useState({
    name: party?.name ?? '', phone: party?.phone ?? '', gstin: party?.gstin ?? '', city: party?.city ?? '', address: party?.address ?? '',
    state_code: party?.state_code ?? '', credit_limit: party?.credit_limit == null ? '' : String(party.credit_limit), credit_days: String(party?.credit_days ?? 30), active: party?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const g = f.gstin.replace(/\s+/g, '').toUpperCase();
  const gOk = !g || gstinValid(g);
  return (
    <form className="stack-16" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      const body = { ...f, gstin: g, state_code: g ? undefined : f.state_code };
      const ok = party ? await send(`/api/parties/${party.id}`, 'PATCH', body, `${f.name} saved`) : await send('/api/parties', 'POST', body, `${f.name} added`);
      setBusy(false);
      if (ok) onDone();
    }}>
      <label className="fld">Name<input value={f.name} maxLength={150} onChange={set('name')} required autoFocus={!party} /></label>
      <div className={s.formGrid}>
        <label className="fld">Phone<input inputMode="tel" value={f.phone} onChange={set('phone')} placeholder="98250 12345" /></label>
        <label className="fld">City<input value={f.city} maxLength={100} onChange={set('city')} /></label>
        <label className={`fld ${s.span2}`}>GSTIN
          <input className="num" value={f.gstin} maxLength={18} onChange={set('gstin')} placeholder="24AAACC1206D1ZM" style={{ textTransform: 'uppercase' }} />
          {g && <span className={`${s.fldHint} ${gOk ? s.good : s.bad}`}>{gOk ? `Valid · state ${g.slice(0, 2)}` : g.length < 15 ? '15 characters needed' : 'Check digit does not match — look for a typo'}</span>}
        </label>
        {!g && <label className="fld">State code<input className="num" inputMode="numeric" value={f.state_code} maxLength={2} onChange={set('state_code')} placeholder="24" /></label>}
        <label className={`fld ${s.span2}`}>Address<textarea className="input" rows={2} value={f.address} maxLength={400} onChange={set('address')} /></label>
        <label className="fld">Credit limit ₹<input className="num" inputMode="decimal" value={f.credit_limit} onChange={set('credit_limit')} placeholder="Blank = no limit" /></label>
        <label className="fld">Credit days<input className="num" inputMode="numeric" value={f.credit_days} onChange={set('credit_days')} /></label>
      </div>
      <div className="row-8"><Toggle on={f.active} label="Active" onChange={(v) => setF({ ...f, active: v })} /><span className="small t2">{f.active ? 'Active' : 'Off — hidden from new orders'}</span></div>
      <div className="row-8"><button className="btn primary" type="submit" disabled={busy || !f.name.trim() || !gOk}>{busy ? 'Saving…' : party ? 'Save' : 'Add party'}</button></div>
    </form>
  );
}

// ---------- Selling rates ----------
function Rates({ ctx, refreshKey, parties, send }: { ctx: Ctx; refreshKey: string; parties: Party[]; send: Send }) {
  const { data, error } = useApi<{ qualities: QualityRate[]; history: RateRow[] }>(`/api/rates?${who(ctx.role, actorId(ctx.role))}`, refreshKey);
  const [open, setOpen] = useState<string | null>(null);
  const cur = data?.qualities.find((x) => x.quality === open) ?? null;
  const missing = data?.qualities.filter((x) => x.rate_per_m == null).length ?? 0;
  return (
    <section className="card pad stack-16">
      <div className="stack-4"><h2 className="h2">Selling rates</h2><span className="muted small">₹ per meter by quality. A party’s own rate wins over the general one.</span></div>
      {missing > 0 && <Pill tone="warn">{missing} {missing === 1 ? 'quality has' : 'qualities have'} no rate</Pill>}
      <div className="list">
        {error && <span className="muted small" style={{ padding: 14 }}>{error}</span>}
        {!data && !error && <span className="muted small" style={{ padding: 14 }}>Loading…</span>}
        {data?.qualities.map((r) => (
          <div key={r.quality} className="list-row">
            <div className={s.rowMain}>
              <span className="strong">{r.quality}</span>
              <span className="muted tiny">{r.rate_per_m == null ? 'No rate yet' : `since ${shortDate(r.valid_from)}`}{r.upcoming ? ` · ${perM(r.upcoming.rate_per_m)} from ${shortDate(r.upcoming.valid_from)}` : ''}{r.overrides.length ? ` · ${r.overrides.length} party rate${r.overrides.length === 1 ? '' : 's'}` : ''}</span>
            </div>
            <span className="num strong">{r.rate_per_m == null ? <Pill tone="warn">Not set</Pill> : perM(r.rate_per_m)}</span>
            <button className="btn sm" onClick={() => setOpen(r.quality)}>Set</button>
          </div>
        ))}
      </div>
      <Sheet open={cur != null} title={cur ? `${cur.quality} · rates` : ''} onClose={() => setOpen(null)}>
        {cur && <RatePanel key={cur.quality} q={cur} history={data!.history.filter((h) => h.quality.toLowerCase() === cur.quality.toLowerCase()).slice(0, 12)} parties={parties} send={send} />}
      </Sheet>
    </section>
  );
}

function RatePanel({ q, history, parties, send }: { q: QualityRate; history: RateRow[]; parties: Party[]; send: Send }) {
  const [rate, setRate] = useState('');
  const [from, setFrom] = useState('');
  const [party, setParty] = useState('');
  const [pRate, setPRate] = useState('');
  return (
    <div className="stack-16">
      <div className="stack-4"><span className="muted small">General rate now</span><span className="kpi-value num">{perM(q.rate_per_m)}</span></div>
      <form className="stack-10" onSubmit={async (e) => { e.preventDefault(); if (await send('/api/rates', 'POST', { quality: q.quality, rate_per_m: rate, valid_from: from || undefined }, `${q.quality} rate set`)) { setRate(''); setFrom(''); } }}>
        <div className={s.formGrid}>
          <label className="fld">New rate ₹/m<input className="num" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} required /></label>
          <label className="fld">From date<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><span className={s.fldHint}>Blank = today</span></label>
        </div>
        <div className="row-8"><button className="btn primary" type="submit" disabled={!rate.trim()}>Set general rate</button></div>
      </form>
      <div className="stack-10">
        <h3 className="strong">Party rates</h3>
        <div className="list">
          {q.overrides.map((o) => (
            <div key={o.party_id} className="list-row"><div className={s.rowMain}><span className="strong">{o.party_name}</span><span className="muted tiny">since {shortDate(o.valid_from)}</span></div><span className="num">{perM(o.rate_per_m)}</span></div>
          ))}
          {!q.overrides.length && <span className="muted small" style={{ padding: 14 }}>None — everyone gets the general rate.</span>}
        </div>
        <form className="add-row" onSubmit={async (e) => { e.preventDefault(); if (await send('/api/rates', 'POST', { quality: q.quality, party_id: party, rate_per_m: pRate }, 'Party rate set')) { setPRate(''); } }}>
          <select className="input sel" aria-label="Party" value={party} onChange={(e) => setParty(e.target.value)} required>
            <option value="">Choose party</option>
            {parties.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input className="input num" style={{ flex: '0 1 120px', height: 38 }} inputMode="decimal" aria-label="Party rate ₹/m" placeholder="₹/m" value={pRate} onChange={(e) => setPRate(e.target.value)} required />
          <button className="btn" type="submit" disabled={!party || !pRate.trim()}>Set</button>
        </form>
      </div>
      {history.length > 0 && (
        <div className="stack-10">
          <h3 className="strong">History</h3>
          <div className="list">
            {history.map((h) => (
              <div key={h.id} className="list-row"><div className={s.rowMain}><span className="small">{h.party_name ?? 'General'}</span><span className="muted tiny">from {shortDate(h.valid_from)}</span></div><span className="num small">{perM(h.rate_per_m)}</span></div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Process costs ----------
function Costs({ ctx, refreshKey, send }: { ctx: Ctx; refreshKey: string; send: Send }) {
  const { data, error } = useApi<{ sections: SectionCost[]; history: CostRow[] }>(`/api/costs?${who(ctx.role, actorId(ctx.role))}`, refreshKey);
  const active = ctx.d.config.sections.filter((x) => x.active).map((x) => x.name);
  const rows = (data?.sections ?? []).filter((x) => x.active || active.some((a) => a.toLowerCase() === x.section.toLowerCase()) || x.job_cards > 0);
  return (
    <section className="card pad stack-16">
      <div className="stack-4"><h2 className="h2">Process costs</h2><span className="muted small">₹ per meter each section adds. Used for lot cost and margin.</span></div>
      <div className="list">
        {error && <span className="muted small" style={{ padding: 14 }}>{error}</span>}
        {!data && !error && <span className="muted small" style={{ padding: 14 }}>Loading…</span>}
        {rows.map((r) => <CostRowForm key={`${r.section}:${r.cost_per_m}`} r={r} send={send} />)}
        {data && !rows.length && <span className="muted small" style={{ padding: 14 }}>No sections yet.</span>}
      </div>
    </section>
  );
}

function CostRowForm({ r, send }: { r: SectionCost; send: Send }) {
  const [v, setV] = useState('');
  return (
    <div className="list-row wrap">
      <div className={s.rowMain}>
        <span className="strong">{r.section}</span>
        <span className="muted tiny">{r.cost_per_m == null ? (r.job_cards ? `${r.job_cards} job cards, no cost yet` : 'No cost yet') : `${perM(r.cost_per_m)} since ${shortDate(r.valid_from)}`}{r.upcoming ? ` · ${perM(r.upcoming.cost_per_m)} from ${shortDate(r.upcoming.valid_from)}` : ''}</span>
      </div>
      {r.cost_per_m == null && r.job_cards > 0 && <Pill tone="warn">Needed</Pill>}
      <form className={s.inlineForm} onSubmit={async (e) => { e.preventDefault(); if (await send('/api/costs', 'POST', { section: r.section, cost_per_m: v }, `${r.section} cost set`)) setV(''); }}>
        <input className="input num" inputMode="decimal" aria-label={`${r.section} cost ₹/m`} placeholder={r.cost_per_m == null ? '₹/m' : String(r.cost_per_m)} value={v} onChange={(e) => setV(e.target.value)} />
        <button className="btn sm" type="submit" disabled={!v.trim()}>Save</button>
      </form>
    </div>
  );
}

// ---------- Billing & GST + agent thresholds ----------
function Billing({ ctx, refreshKey, send }: { ctx: Ctx; refreshKey: string; send: Send }) {
  const { data, error } = useApi<{ billing: BillingSettings }>(`/api/settings/billing?${who(ctx.role, actorId(ctx.role))}`, refreshKey);
  if (error) return <section className="card pad"><span className="muted small">{error}</span></section>;
  if (!data) return <section className="card pad"><span className="muted small">Loading billing…</span></section>;
  const k = JSON.stringify(data.billing);
  return (
    <>
      <BillingForm key={`b:${k}`} b={data.billing} send={send} />
      <Thresholds key={`t:${k}`} b={data.billing} send={send} />
    </>
  );
}

function BillingForm({ b, send }: { b: BillingSettings; send: Send }) {
  const init = {
    legal_name: b.legal_name ?? '', gstin: b.gstin ?? '', address: b.address ?? '', state_code: b.state_code ?? '', phone: b.phone ?? '',
    bank_name: b.bank_name ?? '', bank_account: b.bank_account ?? '', bank_ifsc: b.bank_ifsc ?? '', invoice_prefix: b.invoice_prefix,
    next_invoice_no: String(b.next_invoice_no), hsn_code: b.hsn_code, gst_rate_pct: String(b.gst_rate_pct),
  };
  const [f, setF] = useState(init);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const dirty = (Object.keys(f) as (keyof typeof f)[]).some((k) => f[k] !== init[k]);
  const g = f.gstin.replace(/\s+/g, '').toUpperCase();
  const gOk = !g || gstinValid(g);
  return (
    <form className="card pad stack-16" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      const changed = Object.fromEntries((Object.keys(f) as (keyof typeof f)[]).filter((k) => f[k] !== init[k]).map((k) => [k, f[k]]));
      await send('/api/settings/billing', 'PUT', changed, 'Billing details saved');
      setBusy(false);
    }}>
      <div className="stack-4"><h2 className="h2">Billing & GST</h2><span className="muted small">Printed on invoices, challans, statements and payment reminders.</span></div>
      <div className={s.formGrid}>
        <label className={`fld ${s.span2}`}>Legal name<input value={f.legal_name} maxLength={150} onChange={set('legal_name')} placeholder="As on GST registration" /></label>
        <label className="fld">GSTIN
          <input className="num" value={f.gstin} maxLength={18} onChange={set('gstin')} style={{ textTransform: 'uppercase' }} />
          {g && <span className={`${s.fldHint} ${gOk ? s.good : s.bad}`}>{gOk ? `Valid · state ${g.slice(0, 2)}` : 'Check digit does not match'}</span>}
        </label>
        <label className="fld">State code<input className="num" inputMode="numeric" maxLength={2} value={g && gOk ? g.slice(0, 2) : f.state_code} disabled={!!g && gOk} onChange={set('state_code')} /></label>
        <label className={`fld ${s.span2}`}>Address<textarea className="input" rows={2} maxLength={400} value={f.address} onChange={set('address')} /></label>
        <label className="fld">Phone<input inputMode="tel" value={f.phone} onChange={set('phone')} /></label>
        <label className="fld">Bank name<input value={f.bank_name} maxLength={100} onChange={set('bank_name')} /></label>
        <label className="fld">Account no.<input className="num" inputMode="numeric" value={f.bank_account} maxLength={24} onChange={set('bank_account')} /></label>
        <label className="fld">IFSC<input className="num" value={f.bank_ifsc} maxLength={11} onChange={set('bank_ifsc')} style={{ textTransform: 'uppercase' }} placeholder="HDFC0001234" /></label>
        <label className="fld">Invoice prefix<input className="num" value={f.invoice_prefix} maxLength={12} onChange={set('invoice_prefix')} style={{ textTransform: 'uppercase' }} /></label>
        <label className="fld">Next invoice no.<input className="num" inputMode="numeric" value={f.next_invoice_no} onChange={set('next_invoice_no')} /><span className={s.fldHint}>Can only go up</span></label>
        <label className="fld">HSN code<input className="num" inputMode="numeric" value={f.hsn_code} maxLength={8} onChange={set('hsn_code')} /></label>
        <label className="fld">GST rate %<input className="num" inputMode="decimal" value={f.gst_rate_pct} onChange={set('gst_rate_pct')} /></label>
      </div>
      <div className="row-8"><button className="btn primary" type="submit" disabled={busy || !dirty || !gOk}>{busy ? 'Saving…' : 'Save billing'}</button></div>
    </form>
  );
}

function Thresholds({ b, send }: { b: BillingSettings; send: Send }) {
  const [low, setLow] = useState(String(b.low_stock_m));
  const [age, setAge] = useState(String(b.ageing_days));
  const dirty = low !== String(b.low_stock_m) || age !== String(b.ageing_days);
  return (
    <form className="card pad stack-16" onSubmit={(e) => { e.preventDefault(); void send('/api/settings/billing', 'PUT', { low_stock_m: low, ageing_days: age }, 'Thresholds saved'); }}>
      <div className="stack-4"><h2 className="h2">Agent thresholds</h2><span className="muted small">When the inventory agent raises an alert.</span></div>
      <label className="fld">Low stock (meters)<input className="num" inputMode="decimal" value={low} onChange={(e) => setLow(e.target.value)} /><span className="muted small">Alert when a quality’s free stock falls below this.</span></label>
      <label className="fld">Ageing lot (days)<input className="num" inputMode="numeric" value={age} onChange={(e) => setAge(e.target.value)} /><span className="muted small">Alert when a lot has not moved for this many days.</span></label>
      <div className="row-8"><button className="btn primary" type="submit" disabled={!dirty}>Save thresholds</button></div>
    </form>
  );
}
