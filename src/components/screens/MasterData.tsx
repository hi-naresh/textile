'use client';

// Owner master data, shown in My firm (parties, billing & GST) and Settings (stock alert thresholds).
// Selling rates and process costs are turned off: every party gets its own rate, typed on the order.
import React, { useEffect, useState } from 'react';
import Icon from '../Icon';
import { Pill, Sheet, inr } from '../ui';
import type { Ctx } from '../ctx';
import { apiSend, flashWhenReady, useApi, who } from '@/lib/useApi';
import { actorId } from '@/lib/useTextileData';
import type { Party } from '@/lib/domain';
import type { BillingSettings } from '@/lib/money/master';
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

/** Parties (clients) with search, add and edit. Owner only. */
/** `link`: open this party (deep link #firm=parties&party=ID from search). */
export function FirmParties({ ctx, link = null }: { ctx: Ctx; link?: { id: number; n: number } | null }) {
  const [bump, setBump] = useState(0);
  const key = `${ctx.d.lastSync?.getTime() ?? 0}:${bump}`;
  const parties = useApi<{ parties: Party[] }>(ctx.role === 'owner' ? `/api/parties?all=1&${who(ctx.role, actorId(ctx.role))}` : null, key);
  const send = useSend(ctx, () => setBump((b) => b + 1));
  if (ctx.role !== 'owner') return null;
  return <Parties list={parties.error ? [] : parties.data?.parties ?? null} error={parties.error} send={send} link={link} />;
}

/** Billing & GST details printed on invoices (legal name, GSTIN, address, bank, invoice numbering). */
export function FirmBilling({ ctx }: { ctx: Ctx }) {
  const [bump, setBump] = useState(0);
  const key = `${ctx.d.lastSync?.getTime() ?? 0}:${bump}`;
  const { data, error } = useApi<{ billing: BillingSettings }>(ctx.role === 'owner' ? `/api/settings/billing?${who(ctx.role, actorId(ctx.role))}` : null, key);
  const send = useSend(ctx, () => setBump((b) => b + 1));
  if (ctx.role !== 'owner') return null;
  if (error) return <section className="card pad"><span className="muted small">{error}</span></section>;
  if (!data) return <section className="card pad"><span className="muted small">Loading billing…</span></section>;
  return <BillingForm key={JSON.stringify(data.billing)} b={data.billing} send={send} />;
}

/** When the inventory agent raises low-stock / ageing alerts (Settings → Rules). */
export function StockAlerts({ ctx }: { ctx: Ctx }) {
  const [bump, setBump] = useState(0);
  const key = `${ctx.d.lastSync?.getTime() ?? 0}:${bump}`;
  const { data, error } = useApi<{ billing: BillingSettings }>(ctx.role === 'owner' ? `/api/settings/billing?${who(ctx.role, actorId(ctx.role))}` : null, key);
  const send = useSend(ctx, () => setBump((b) => b + 1));
  if (ctx.role !== 'owner') return null;
  if (error) return <section className="card pad"><span className="muted small">{error}</span></section>;
  if (!data) return <section className="card pad"><span className="muted small">Loading…</span></section>;
  return <Thresholds key={`${data.billing.low_stock_m}:${data.billing.ageing_days}`} b={data.billing} send={send} />;
}

// ---------- Parties ----------
function Parties({ list, error, send, link }: { list: Party[] | null; error: string | null; send: Send; link: { id: number; n: number } | null }) {
  const [search, setSearch] = useState('');
  const [edit, setEdit] = useState<Party | 'new' | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Deep link: filter the list to that party, highlight its row and open its details (once the list is in).
  const [handled, setHandled] = useState<{ id: number; n: number } | null>(null);
  const linked = link && link !== handled ? list?.find((p) => p.id === link.id) ?? null : null;
  useEffect(() => {
    if (!link || link === handled || !list) return;
    /* eslint-disable react-hooks/set-state-in-effect -- a deep link arrived: open that party */
    setHandled(link);
    if (!linked) return;
    setSearch(linked.name);
    setEdit(linked);
    /* eslint-enable react-hooks/set-state-in-effect */
    flashWhenReady(`[data-party-row="${linked.id}"]`, 3000); // not cancelled on re-run: `handled` changes right away
  }, [link, handled, list, linked]);
  const k = search.trim().toLowerCase();
  const rows = (list ?? []).filter((p) => !k || [p.name, p.city, p.phone, p.gstin].some((x) => x?.toLowerCase().includes(k)));
  const shown = showAll || k ? rows : rows.slice(0, 12);
  return (
    <section className={`card pad stack-16 ${s.full}`}>
      <div className={s.head}>
        <div className="stack-4 grow"><h2 className="h2">Parties</h2><span className="muted small">Clients you sell to: mobile (WhatsApp), GSTIN, credit limit and days.</span></div>
        <button className="btn primary" onClick={() => setEdit('new')}><Icon name="plus" size={16} strokeWidth={2} />Add party</button>
      </div>
      <input className={`input ${s.search}`} aria-label="Search parties" placeholder="Search name, city, phone or GSTIN" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="list">
        {error && <span className="muted small" style={{ padding: 14 }}>{error}</span>}
        {list == null && <span className="muted small" style={{ padding: 14 }}>Loading…</span>}
        {shown.map((p) => (
          <div key={p.id} data-party-row={p.id} className={`list-row ${p.active ? '' : 'off'}`}>
            <div className={s.rowMain}>
              <span className="strong">{p.name}</span>
              <span className="muted tiny">{[p.city, p.phone, p.gstin].filter(Boolean).join(' · ') || 'No details yet'}</span>
            </div>
            {!p.active && <Pill>Off</Pill>}
            <span className="d"><Pill tone={p.credit_limit == null ? 'neutral' : 'info'}>{p.credit_limit == null ? 'No limit' : inr(p.credit_limit)} · {p.credit_days} d</Pill></span>
            <button type="button" className="ib sm-ib" aria-label={`Edit ${p.name}`} onClick={() => setEdit(p)}><Icon name="edit" size={15} /></button>
          </div>
        ))}
        {list && !error && !rows.length && <span className="muted small" style={{ padding: 14 }}>{k ? 'No match.' : 'No parties yet.'}</span>}
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
        <label className="fld">Mobile (WhatsApp)<input inputMode="tel" value={f.phone} onChange={set('phone')} placeholder="98250 12345" /><span className={s.fldHint}>Reminders and dispatch messages go here</span></label>
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

// ---------- Billing & GST + stock alert thresholds ----------
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
    <form className="card pad stack-16" onSubmit={(e) => { e.preventDefault(); void send('/api/settings/billing', 'PUT', { low_stock_m: low, ageing_days: age }, 'Stock alerts saved'); }}>
      <div className="stack-4"><h2 className="h2">Stock alerts</h2><span className="muted small">When the app warns you about stock.</span></div>
      <label className="fld">Low stock (meters)<input className="num" inputMode="decimal" value={low} onChange={(e) => setLow(e.target.value)} /><span className="muted small">Alert when a quality’s free stock falls below this.</span></label>
      <label className="fld">Ageing lot (days)<input className="num" inputMode="numeric" value={age} onChange={(e) => setAge(e.target.value)} /><span className="muted small">Alert when a lot has not moved for this many days.</span></label>
      <div className="row-8"><button className="btn primary" type="submit" disabled={!dirty}>Save stock alerts</button></div>
    </form>
  );
}
