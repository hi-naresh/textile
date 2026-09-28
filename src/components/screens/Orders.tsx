'use client';

// Orders & inquiries (Phase 2 — Sales). Inquiry Handling, Order Management and Fabric Allocation.
// Owner: everything. Supervisor: log inquiries + reply drafts (no ₹), view orders in meters only.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from '../Icon';
import { Empty, PageHead, Pill, Segmented, Sheet, Track, dayTime, fmt, type Tone } from '../ui';
import type { Ctx } from '../ctx';
import { can } from '@/lib/access';
import { actorId } from '@/lib/useTextileData';
import { apiSend, takeHash, useApi, who } from '@/lib/useApi';
import type { Allocation, Inquiry, Order, Party } from '@/lib/domain';
import s from './Orders.module.css';

// ---------- API shapes ----------
type OrderRow = Order & { party_phone: string | null; reserved_m: number };
type AllocRow = Allocation & { quality: string; design: string };
type InquiryRow = Inquiry & { party_phone: string | null; design: string | null; lang: 'en' | 'hi' | 'gu'; updated_at: string };
interface StockInfo { free: number; lots: { lot_id: string; design: string; free: number; location: string | null }[]; design_only: boolean }
interface InquiryView { inquiry: InquiryRow; stock: StockInfo; rate: number | null; promise_date: string | null }
interface Candidate { lot_id: string; design: string; free: number; balance: number; location: string | null; design_match: boolean }

const ORDER_STATUS: Record<Order['status'], { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'info' },
  partly_dispatched: { label: 'Part sent', tone: 'warn' },
  dispatched: { label: 'Dispatched', tone: 'good' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};
const INQ_STATUS: Record<Inquiry['status'], { label: string; tone: Tone }> = {
  new: { label: 'New', tone: 'info' },
  quoted: { label: 'Quoted', tone: 'warn' },
  won: { label: 'Won', tone: 'good' },
  lost: { label: 'Lost', tone: 'neutral' },
};
const SOURCES: { value: Inquiry['source']; label: string }[] = [
  { value: 'whatsapp', label: 'WhatsApp' }, { value: 'phone', label: 'Phone' }, { value: 'visit', label: 'Visit' }, { value: 'other', label: 'Other' },
];

const todayLocal = () => new Date().toLocaleDateString('en-CA');
const shortDate = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};
const daysTo = (iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${todayLocal()}T00:00:00Z`)) / 86_400_000);
const m = (n: number | null | undefined) => (n == null ? '—' : `${fmt(n, 1)} m`);
const rs = (n: number | null | undefined) => (n == null ? '—' : `₹${fmt(n, 2)}/m`);
const isActive = (o: Order) => o.status === 'open' || o.status === 'partly_dispatched';
const isLate = (o: Order) => isActive(o) && !!o.promise_date && o.promise_date < todayLocal() && o.dispatched_m < o.meters * 0.98;

function waLink(text: string, phone: string | null) {
  let p = (phone ?? '').replace(/\D/g, '');
  if (p.length === 10) p = `91${p}`;
  return `https://wa.me/${p}?text=${encodeURIComponent(text)}`;
}

/** Party names for the datalists: the parties master (if available) + names used on dispatches. */
function useParties(ctx: Ctx) {
  const { data } = useApi<{ parties: Party[] }>(`/api/parties?${who(ctx.role, actorId(ctx.role))}`, ctx.d.lastSync);
  return useMemo(() => {
    const list = (data?.parties ?? []).filter((p) => p.active !== false);
    const names = Array.from(new Set([...list.map((p) => p.name), ...ctx.d.names.parties])).sort((a, b) => a.localeCompare(b));
    return { names, byName: (n: string) => list.find((p) => p.name.toLowerCase() === n.trim().toLowerCase()) ?? null };
  }, [data, ctx.d.names.parties]);
}

const qualitiesOf = (ctx: Ctx) => Array.from(new Set(ctx.d.lots.map((l) => l.quality).filter(Boolean))).sort((a, b) => a.localeCompare(b));

// =====================================================================
export function Orders({ ctx }: { ctx: Ctx }) {
  // Deep link from an agent alert: #order=41 opens that order, #inquiry=7 the inquiries list.
  const [link] = useState(() => ({ order: takeHash('order'), inquiry: takeHash('inquiry') }));
  const [view, setView] = useState<'inquiries' | 'orders'>(link.order ? 'orders' : 'inquiries');
  const [openOrder, setOpenOrder] = useState<number | null>(link.order ? Number(link.order) || null : null);
  const [newOrder, setNewOrder] = useState(false);
  const manage = can(ctx.role, 'orders.manage');
  const parties = useParties(ctx);

  if (!can(ctx.role, 'orders.view') && !can(ctx.role, 'inquiry.handle')) {
    return <div className="page fade"><PageHead title="Orders & inquiries" /><Empty title="Not available" text="Your role cannot see orders." /></div>;
  }
  const showOrder = (id: number) => { setView('orders'); setOpenOrder(id); };

  return (
    <div className="page fade">
      <PageHead title="Orders & inquiries" sub={manage ? 'Read inquiries, reply, and keep fabric reserved for every order' : 'Log inquiries and see orders (meters only)'}>
        {manage && view === 'orders' && <button className="btn primary" onClick={() => setNewOrder(true)}><Icon name="plus" size={16} strokeWidth={2} />New order</button>}
      </PageHead>
      <div className="toolbar">
        <Segmented label="Show" className="fit" value={view} onChange={setView} options={[{ value: 'inquiries', label: 'Inquiries' }, { value: 'orders', label: 'Orders' }]} />
      </div>
      {view === 'inquiries'
        ? <Inquiries ctx={ctx} parties={parties} onOrder={showOrder} />
        : <OrdersList ctx={ctx} onOpen={setOpenOrder} />}
      {openOrder != null && <OrderSheet ctx={ctx} id={openOrder} onClose={() => setOpenOrder(null)} />}
      {newOrder && <NewOrderSheet ctx={ctx} parties={parties} onClose={() => setNewOrder(false)} onCreated={(id) => { setNewOrder(false); setOpenOrder(id); }} />}
    </div>
  );
}

// =====================================================================
// Inquiries
function Inquiries({ ctx, parties, onOrder }: { ctx: Ctx; parties: ReturnType<typeof useParties>; onOrder: (id: number) => void }) {
  const { role, d } = ctx;
  const actor = actorId(role);
  const [text, setText] = useState('');
  const [source, setSource] = useState<Inquiry['source']>('whatsapp');
  const [party, setParty] = useState('');
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<InquiryView | null>(null);
  const [filter, setFilter] = useState<'all' | Inquiry['status']>('all');
  const list = useApi<{ inquiries: InquiryRow[] }>(`/api/inquiries?status=${filter}&${who(role, actor)}`, d.lastSync);

  const read = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return d.showToast('Paste or type the inquiry first.', 'warning');
    setBusy(true);
    try {
      const res = await apiSend<InquiryView>('/api/inquiries', 'POST', { raw_text: text, source, party_name: party || undefined, role, actor });
      setCurrent(res);
      setText('');
      setParty('');
      list.reload();
      const miss = [!res.inquiry.quality && 'quality', res.inquiry.meters == null && 'meters'].filter(Boolean);
      d.showToast(miss.length ? `Saved. Could not read the ${miss.join(' and ')} — fill it in below.` : 'Inquiry read and saved.', miss.length ? 'warning' : 'success');
    } catch (err) {
      d.showToast(err instanceof Error ? err.message : 'Could not read the inquiry.', 'danger');
    } finally {
      setBusy(false);
    }
  };

  const open = async (id: number) => {
    try {
      const res = await fetch(`/api/inquiries/${id}?${who(role, actor)}`, { cache: 'no-store' });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'Could not load.');
      setCurrent(j);
      if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      d.showToast(err instanceof Error ? err.message : 'Could not load.', 'danger');
    }
  };

  return (
    <div className="stack-16">
      <form className="card pad stack-12" onSubmit={read}>
        <label className="fld">Paste or type the inquiry
          <textarea className={`input ${s.paste}`} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Need 2000 mtr Georgette @14 by 10th · 2000 मीटर जॉर्जेट चाहिए · 1500 મીટર શિફોન જોઈએ" />
        </label>
        <div className="two-col">
          <label className="fld">Came by
            <select value={source} onChange={(e) => setSource(e.target.value as Inquiry['source'])}>
              {SOURCES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
            </select>
          </label>
          <label className="fld">Party (optional)
            <input list="inq-party-list" value={party} onChange={(e) => setParty(e.target.value)} autoComplete="off" placeholder="Found from the text if left empty" />
            <datalist id="inq-party-list">{parties.names.map((n) => <option key={n} value={n} />)}</datalist>
          </label>
        </div>
        <button className="btn primary big" type="submit" disabled={busy}>{busy ? 'Reading…' : 'Read inquiry'}</button>
      </form>

      {current && <InquiryCard key={`${current.inquiry.id}-${current.inquiry.updated_at}`} ctx={ctx} view={current} parties={parties} onChange={(v) => { setCurrent(v); list.reload(); }} onOrder={onOrder} onClose={() => setCurrent(null)} />}

      <section className="card flush">
        <div className="card-head pad-x">
          <h2>Recent inquiries</h2>
        </div>
        <div className="toolbar" style={{ padding: '0 16px 12px' }}>
          <div className="chips scroll-x">
            {(['all', 'new', 'quoted', 'won', 'lost'] as const).map((f) => (
              <button key={f} type="button" className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : INQ_STATUS[f].label}</button>
            ))}
          </div>
        </div>
        {list.error && <div className="alert bad" style={{ margin: '0 16px 16px' }}>{list.error}</div>}
        <div>
          {(list.data?.inquiries ?? []).map((i) => (
            <button key={i.id} type="button" className={`list-row ${s.inqRow}`} onClick={() => open(i.id)}>
              <div className="stack-2 grow" style={{ minWidth: 0 }}>
                <span className="strong">{i.party_name || 'Party not known'}{i.order_id ? <span className="muted small"> · order #{i.order_id}</span> : null}</span>
                <span className={`muted small ${s.clip}`}>{i.quality ? `${i.quality}${i.meters != null ? ` · ${m(i.meters)}` : ''}${i.needed_by ? ` · by ${shortDate(i.needed_by)}` : ''}` : i.raw_text}</span>
              </div>
              <span className="muted tiny d">{dayTime(i.created_at)}</span>
              <Pill tone={INQ_STATUS[i.status].tone}>{INQ_STATUS[i.status].label}</Pill>
            </button>
          ))}
          {!list.loading && !list.error && !(list.data?.inquiries ?? []).length && <div className="muted center small" style={{ padding: 20 }}>No inquiries yet</div>}
        </div>
      </section>
    </div>
  );
}

function InquiryCard({ ctx, view, parties, onChange, onOrder, onClose }: {
  ctx: Ctx; view: InquiryView; parties: ReturnType<typeof useParties>; onChange: (v: InquiryView) => void; onOrder: (id: number) => void; onClose: () => void;
}) {
  const { role, d } = ctx;
  const actor = actorId(role);
  const owner = can(role, 'orders.manage');
  const i = view.inquiry;
  const init = useMemo(() => ({
    party_name: i.party_name ?? '', quality: i.quality ?? '', design: i.design ?? '', meters: i.meters == null ? '' : String(i.meters),
    needed_by: i.needed_by ?? '', quoted_rate: i.quoted_rate == null ? '' : String(i.quoted_rate),
  }), [i]);
  const [f, setF] = useState(init);
  const [draft, setDraft] = useState(i.reply_draft ?? '');
  const [busy, setBusy] = useState(false);
  const qualities = useMemo(() => qualitiesOf(ctx), [ctx]);
  const dirty = (Object.keys(init) as (keyof typeof init)[]).some((k) => f[k] !== init[k]);
  const draftDirty = draft !== (i.reply_draft ?? '');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const found = (i.parsed?.found ?? {}) as Record<string, string>;
  const phone = i.party_phone ?? (i.party_name ? parties.byName(i.party_name)?.phone ?? null : null);

  const patch = async (body: Record<string, unknown>, msg?: string) => {
    setBusy(true);
    try {
      const res = await apiSend<InquiryView>(`/api/inquiries/${i.id}`, 'PATCH', { ...body, role, actor });
      onChange(res);
      if (msg) d.showToast(msg, 'success');
      return res;
    } catch (err) {
      d.showToast(err instanceof Error ? err.message : 'Could not save.', 'danger');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const saveFields = () => {
    const body: Record<string, unknown> = {};
    for (const k of Object.keys(init) as (keyof typeof init)[]) {
      if (f[k] === init[k]) continue;
      if (k === 'quoted_rate' && !owner) continue;
      body[k] = f[k] === '' ? null : f[k];
    }
    if (draftDirty) body.reply_draft = draft; // keep the person's own edits
    return patch(body, draftDirty ? 'Saved. Your own reply text was kept.' : 'Updated — reply redrafted.');
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      d.showToast('Reply copied.', 'success');
    } catch {
      d.showToast('Could not copy — select the text and copy it.', 'warning');
    }
    if (draftDirty) patch({ reply_draft: draft });
  };

  const convert = async () => {
    if (dirty) return d.showToast('Save the changes first.', 'warning');
    setBusy(true);
    try {
      const res = await apiSend<{ order: OrderRow; warnings: string[] }>(`/api/inquiries/${i.id}/convert`, 'POST', { role, actor });
      d.showToast(`Order #${res.order.id} created.${res.warnings.length ? ` ${res.warnings[0]}` : ''}`, res.warnings.length ? 'warning' : 'success');
      onOrder(res.order.id);
    } catch (err) {
      d.showToast(err instanceof Error ? err.message : 'Could not create the order.', 'danger');
    } finally {
      setBusy(false);
    }
  };

  const short = i.meters != null ? Math.max(0, i.meters - view.stock.free) : 0;

  return (
    <section className="card pad stack-16">
      <div className="card-head">
        <h2>Inquiry #{i.id}</h2>
        <Pill tone={INQ_STATUS[i.status].tone}>{INQ_STATUS[i.status].label}</Pill>
        <button type="button" className="ib" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
      </div>
      <p className="muted small" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>“{i.raw_text}”</p>

      <div className="stack-12">
        <div className="two-col">
          <label className="fld">Party
            <input list="inq-card-party" value={f.party_name} onChange={set('party_name')} autoComplete="off" />
            <datalist id="inq-card-party">{parties.names.map((n) => <option key={n} value={n} />)}</datalist>
          </label>
          <label className="fld">Quality
            <input list="inq-card-quality" value={f.quality} onChange={set('quality')} autoComplete="off" />
            <datalist id="inq-card-quality">{qualities.map((n) => <option key={n} value={n} />)}</datalist>
          </label>
        </div>
        <div className="two-col">
          <label className="fld">Meters<input className="num" inputMode="decimal" value={f.meters} onChange={set('meters')} /></label>
          <label className="fld">Needed by<input type="date" value={f.needed_by} onChange={set('needed_by')} /></label>
        </div>
        <div className="two-col">
          <label className="fld">Design (optional)<input value={f.design} onChange={set('design')} autoComplete="off" /></label>
          {owner
            ? <label className="fld">Rate to quote ₹/m<input className="num" inputMode="decimal" value={f.quoted_rate} onChange={set('quoted_rate')} placeholder={view.rate != null ? String(view.rate) : 'No rate set'} /></label>
            : <div />}
        </div>
        {Object.keys(found).length > 0 && (
          <span className="muted tiny d">Read from the text: {Object.entries(found).map(([k, v]) => `${k.replace('_', ' ')} “${v}”`).join(' · ')}{i.parsed?.llm ? ' · AI helped' : ''}</span>
        )}
        {dirty && <button type="button" className="btn primary" disabled={busy} onClick={saveFields}><Icon name="check" size={16} strokeWidth={2} />Save and redraft</button>}
      </div>

      <div className="stack-6">
        <div className={s.wrap}>
          <span className="strong">{i.quality ? `Free stock: ${m(view.stock.free)}` : 'Pick a quality to check stock'}</span>
          {i.quality && i.meters != null && (view.stock.free >= i.meters
            ? <Pill tone="good">Enough{view.promise_date ? ` · can send by ${shortDate(view.promise_date)}` : ''}</Pill>
            : view.stock.free > 0 ? <Pill tone="warn">{m(short)} short</Pill> : <Pill tone="bad">Not in stock</Pill>)}
          {owner && i.quality && <span className="muted small">Rate {view.rate != null ? rs(view.rate) : 'not set'}</span>}
        </div>
        {view.stock.lots.length > 0 && (
          <div className="d">
            {view.stock.lots.slice(0, 6).map((l) => (
              <div key={l.lot_id} className={s.lotRow}>
                <span className="num strong">{l.lot_id}</span>
                <span className="muted">{l.design}{l.location ? ` · ${l.location}` : ''}</span>
                <span className="num">{m(l.free)}</span>
              </div>
            ))}
            {view.stock.lots.length > 6 && <span className="muted tiny">+ {view.stock.lots.length - 6} more lots</span>}
          </div>
        )}
      </div>

      <label className="fld">Reply
        <textarea className={`input ${s.draft}`} value={draft} onChange={(e) => setDraft(e.target.value)} />
      </label>
      <div className={s.wrap}>
        <button type="button" className="btn sm" onClick={copy} disabled={!draft.trim()}>Copy</button>
        <a className="btn sm" href={draft.trim() ? waLink(draft, phone) : undefined} target="_blank" rel="noreferrer" onClick={() => { if (draftDirty) patch({ reply_draft: draft }); }}>
          <Icon name="send" size={14} strokeWidth={2} />Open WhatsApp
        </a>
        {draftDirty && !dirty && <button type="button" className="btn sm" disabled={busy} onClick={() => patch({ reply_draft: draft }, 'Reply saved.')}>Save reply</button>}
        {!owner && <span className="muted tiny">Rates are added by the owner.</span>}
      </div>

      <div className={s.wrap}>
        <span className="muted small">Mark as</span>
        {(['quoted', 'won', 'lost'] as const).map((st) => (
          <button key={st} type="button" className={`chip ${i.status === st ? 'on' : ''}`} disabled={busy || !!i.order_id}
            onClick={() => patch({ status: i.status === st ? 'new' : st }, i.status === st ? 'Marked new.' : `Marked ${INQ_STATUS[st].label.toLowerCase()}.`)}>
            {INQ_STATUS[st].label}
          </button>
        ))}
        <div className="grow" />
        {i.order_id
          ? <button type="button" className="btn sm" onClick={() => onOrder(i.order_id!)}>Open order #{i.order_id}</button>
          : owner && <button type="button" className="btn sm primary" disabled={busy || !i.quality || i.meters == null || i.status === 'lost'} onClick={convert}><Icon name="cart" size={14} strokeWidth={2} />Create order</button>}
      </div>
    </section>
  );
}

// =====================================================================
// Orders
function Progress({ o }: { o: Order }) {
  const sent = o.meters > 0 ? (o.dispatched_m / o.meters) * 100 : 0;
  const ready = o.meters > 0 ? (o.allocated_m / o.meters) * 100 : 0;
  return (
    <div className={s.prog}>
      <div className={s.progLine}><span>Sent</span><Track pct={sent} tone={sent >= 98 ? 'good' : 'info'} /></div>
      <div className={s.progLine}><span>Ready</span><Track pct={ready} tone={ready >= 98 ? 'good' : ready > 0 ? 'warn' : 'bad'} /></div>
    </div>
  );
}

function PromiseCell({ o }: { o: Order }) {
  if (!o.promise_date) return <span className="muted">—</span>;
  if (!isActive(o)) return <span>{shortDate(o.promise_date)}</span>;
  const n = daysTo(o.promise_date);
  if (n < 0) return <Pill tone="bad">{shortDate(o.promise_date)} · {-n}d late</Pill>;
  if (n <= 2) return <Pill tone="warn">{shortDate(o.promise_date)} · {n === 0 ? 'today' : n === 1 ? 'tomorrow' : `${n} days`}</Pill>;
  return <span>{shortDate(o.promise_date)}</span>;
}

function OrdersList({ ctx, onOpen }: { ctx: Ctx; onOpen: (id: number) => void }) {
  const { role, d } = ctx;
  const owner = can(role, 'orders.manage');
  const [status, setStatus] = useState<'open' | 'dispatched' | 'cancelled' | 'all'>('open');
  const { data, error, loading } = useApi<{ orders: OrderRow[] }>(`/api/orders?status=${status}&${who(role, actorId(role))}`, d.lastSync);
  const rows = data?.orders ?? [];
  const pending = rows.filter(isActive).reduce((acc, o) => acc + Math.max(0, o.meters - o.dispatched_m), 0);
  const late = rows.filter(isLate).length;

  return (
    <div className="stack-12">
      <div className="toolbar">
        <Segmented label="Status" value={status} onChange={setStatus} options={[{ value: 'open', label: 'Open' }, { value: 'dispatched', label: 'Dispatched' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'all', label: 'All' }]} />
        {status === 'open' && rows.length > 0 && <span className="muted small">{rows.length} open · {m(pending)} to send{late ? ` · ${late} late` : ''}</span>}
      </div>
      {error && <div className="alert bad">{error}</div>}
      <section className="card flush">
        <table className="tbl rtbl">
          <thead>
            <tr><th>Order</th><th>Party</th><th>Quality</th><th className="r">Meters</th><th>Progress</th><th>Promised</th><th>Status</th>{owner && <th className="r d">Rate</th>}</tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id} className={`${s.rowBtn} ${isLate(o) ? s.late : ''}`} onClick={() => onOpen(o.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(o.id); }}>
                <td data-label="Order" className="num strong">#{o.id}</td>
                <td data-label="Party">{o.party_name}</td>
                <td data-label="Quality">{o.quality}{o.design ? <span className="muted small"> · {o.design}</span> : null}</td>
                <td data-label="Meters" className="r num">{fmt(o.meters, 1)}</td>
                <td data-label="Progress"><Progress o={o} /></td>
                <td data-label="Promised"><PromiseCell o={o} /></td>
                <td data-label="Status"><Pill tone={ORDER_STATUS[o.status].tone}>{ORDER_STATUS[o.status].label}</Pill></td>
                {owner && <td data-label="Rate" className="r num d">{rs(o.rate_per_m)}</td>}
              </tr>
            ))}
            {!loading && !rows.length && <tr><td colSpan={8} className="muted center">{status === 'open' ? 'No open orders' : 'No orders here'}</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function NewOrderSheet({ ctx, parties, onClose, onCreated }: { ctx: Ctx; parties: ReturnType<typeof useParties>; onClose: () => void; onCreated: (id: number) => void }) {
  const { role, d } = ctx;
  const actor = actorId(role);
  const [f, setF] = useState({ party: '', quality: '', design: '', meters: '', rate_per_m: '', promise_date: '', notes: '' });
  const [rateTouched, setRateTouched] = useState(false);
  const [suggested, setSuggested] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const qualities = useMemo(() => qualitiesOf(ctx), [ctx]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF((x) => ({ ...x, [k]: e.target.value }));

  // Prefill the rate from Settings → Rates for this quality (+ party).
  useEffect(() => {
    const q = f.quality.trim();
    if (!q) return;
    const t = setTimeout(() => {
      fetch(`/api/orders/rate?quality=${encodeURIComponent(q)}${f.party.trim() ? `&party=${encodeURIComponent(f.party.trim())}` : ''}&${who(role, actor)}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          const rate = j?.rate ?? null;
          setSuggested(rate);
          if (!rateTouched) setF((x) => ({ ...x, rate_per_m: rate == null ? '' : String(rate) }));
        })
        .catch(() => undefined);
    }, 350);
    return () => clearTimeout(t);
  }, [f.quality, f.party, rateTouched, role, actor]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.party.trim() || !f.quality.trim() || !f.meters.trim()) return d.showToast('Party, quality and meters are required.', 'warning');
    setBusy(true);
    try {
      const res = await apiSend<{ order: OrderRow; warnings: string[] }>('/api/orders', 'POST', { ...f, rate_per_m: f.rate_per_m || null, promise_date: f.promise_date || null, role, actor });
      d.showToast(`Order #${res.order.id} created.${res.warnings.length ? ` ${res.warnings.join(' ')}` : ''}`, res.warnings.length ? 'warning' : 'success');
      onCreated(res.order.id);
    } catch (err) {
      d.showToast(err instanceof Error ? err.message : 'Could not create the order.', 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open title="New order" onClose={onClose}>
      <form className="stack-16" onSubmit={submit}>
        <label className="fld">Party
          <input list="new-order-party" value={f.party} onChange={set('party')} autoComplete="off" autoFocus />
          <datalist id="new-order-party">{parties.names.map((n) => <option key={n} value={n} />)}</datalist>
        </label>
        <div className="two-col">
          <label className="fld">Quality
            <input list="new-order-quality" value={f.quality} onChange={set('quality')} autoComplete="off" />
            <datalist id="new-order-quality">{qualities.map((n) => <option key={n} value={n} />)}</datalist>
          </label>
          <label className="fld">Design (optional)<input value={f.design} onChange={set('design')} autoComplete="off" /></label>
        </div>
        <div className="two-col">
          <label className="fld">Meters<input className="num" inputMode="decimal" value={f.meters} onChange={set('meters')} placeholder="0" /></label>
          <label className="fld">Rate ₹/m
            <input className="num" inputMode="decimal" value={f.rate_per_m} onChange={(e) => { setRateTouched(true); set('rate_per_m')(e); }} placeholder="No rate set" />
          </label>
        </div>
        {suggested != null && rateTouched && Number(f.rate_per_m) !== suggested && <span className="muted small hint">Usual rate: ₹{fmt(suggested, 2)}/m</span>}
        <label className="fld">Promise date<input type="date" min={todayLocal()} value={f.promise_date} onChange={set('promise_date')} /></label>
        <label className="fld">Notes<textarea className="input" rows={2} value={f.notes} onChange={set('notes')} /></label>
        <button className="btn primary big" type="submit" disabled={busy}>Create order</button>
      </form>
    </Sheet>
  );
}

function OrderSheet({ ctx, id, onClose }: { ctx: Ctx; id: number; onClose: () => void }) {
  const { role, d } = ctx;
  const actor = actorId(role);
  const owner = can(role, 'orders.manage');
  const alloc = can(role, 'orders.allocate');
  const { data, error, reload } = useApi<{ order: OrderRow; allocations: AllocRow[] }>(`/api/orders/${id}?${who(role, actor)}`, d.lastSync);
  const o = data?.order;
  const active = !!o && isActive(o);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const act = useCallback(async (fn: () => Promise<string | null>) => {
    setBusy(true);
    try {
      const msg = await fn();
      if (msg) d.showToast(msg, 'success');
      reload();
    } catch (err) {
      d.showToast(err instanceof Error ? err.message : 'Could not do that.', 'danger');
    } finally {
      setBusy(false);
    }
  }, [d, reload]);

  const auto = () => act(async () => {
    const r = await apiSend<{ allocations: unknown[]; allocated_m: number; short_m: number }>(`/api/orders/${id}/allocate`, 'POST', { auto: true, role, actor });
    if (!r.allocations.length) { d.showToast(r.short_m > 0 ? 'No free stock of this quality right now.' : 'Already fully allocated.', 'warning'); return null; }
    if (r.short_m > 0) { d.showToast(`Reserved ${m(r.allocated_m)} from ${r.allocations.length} lot(s) — still ${m(r.short_m)} short.`, 'warning'); return null; }
    return `Reserved ${m(r.allocated_m)} from ${r.allocations.length} lot${r.allocations.length === 1 ? '' : 's'}.`;
  });
  const release = (a: AllocRow) => act(async () => {
    const r = await apiSend<{ released_m: number }>(`/api/allocations/${a.id}/release`, 'POST', { role, actor });
    return `Released ${m(r.released_m)} of lot ${a.lot_id}.`;
  });
  const cancel = () => act(async () => {
    const r = await apiSend<{ message: string }>(`/api/orders/${id}`, 'PATCH', { status: 'cancelled', role, actor });
    setConfirmCancel(false);
    return r.message;
  });

  const need = o ? Math.max(0, Math.round((o.meters - o.allocated_m) * 100) / 100) : 0;
  const allocs = data?.allocations ?? [];

  return (
    <Sheet open title={`Order #${id}`} onClose={onClose}>
      {error && <div className="alert bad">{error}</div>}
      {!o ? (!error && <span className="muted">Loading…</span>) : (
        <div className="stack-16">
          <div className={s.wrap}>
            <Pill tone={ORDER_STATUS[o.status].tone}>{ORDER_STATUS[o.status].label}</Pill>
            {isLate(o) && <Pill tone="bad">Late</Pill>}
            {o.inquiry_id && <span className="muted small">From inquiry #{o.inquiry_id}</span>}
          </div>
          {edit && owner ? (
            <EditOrder ctx={ctx} o={o} onDone={() => { setEdit(false); reload(); }} onCancel={() => setEdit(false)} />
          ) : (
            <dl className={s.facts} style={{ margin: 0 }}>
              <div><dt>Party</dt><dd>{o.party_name}</dd></div>
              <div><dt>Quality</dt><dd>{o.quality}{o.design ? ` · ${o.design}` : ''}</dd></div>
              <div><dt>Ordered</dt><dd className="num">{m(o.meters)}</dd></div>
              <div><dt>Promised</dt><dd><PromiseCell o={o} /></dd></div>
              <div><dt>Sent</dt><dd className="num">{m(o.dispatched_m)}</dd></div>
              <div><dt>Reserved</dt><dd className="num">{m(o.reserved_m)}</dd></div>
              {owner && <div><dt>Rate</dt><dd className="num">{rs(o.rate_per_m)}</dd></div>}
              {owner && o.rate_per_m != null && <div className="d"><dt>Value</dt><dd className="num">₹{fmt(o.rate_per_m * o.meters)}</dd></div>}
              {o.notes && <div style={{ gridColumn: '1 / -1' }}><dt>Notes</dt><dd style={{ fontWeight: 400 }}>{o.notes}</dd></div>}
            </dl>
          )}
          <Progress o={o} />
          {active && need > 0 && <div className="alert warn">{m(need)} still needs fabric reserved.</div>}

          <div className="stack-6">
            <div className={s.wrap}>
              <h3 style={{ margin: 0, fontSize: 15 }} className="grow">Reserved lots</h3>
              {alloc && active && need > 0 && <button type="button" className="btn sm primary" disabled={busy} onClick={auto}>Auto-allocate</button>}
            </div>
            {allocs.length ? (
              <div className="list">
                {allocs.map((a) => (
                  <div key={a.id} className={`list-row ${a.status === 'released' ? 'off' : ''}`}>
                    <div className="stack-2 grow" style={{ minWidth: 0 }}>
                      <span className="strong num">{a.lot_id}</span>
                      <span className="muted tiny">{a.design} · {m(a.meters)}{a.dispatched_m > 0 ? ` · ${m(a.dispatched_m)} sent` : ''}</span>
                    </div>
                    <Pill tone={a.status === 'reserved' ? 'info' : a.status === 'dispatched' ? 'good' : 'neutral'}>{a.status === 'reserved' ? 'Reserved' : a.status === 'dispatched' ? 'Sent' : 'Released'}</Pill>
                    {alloc && a.status === 'reserved' && <button type="button" className="btn sm" disabled={busy} onClick={() => release(a)}>Release</button>}
                  </div>
                ))}
              </div>
            ) : <span className="muted small">No lots reserved yet.</span>}
          </div>

          {alloc && active && need > 0 && <ManualAllocate ctx={ctx} orderId={id} need={need} busy={busy} onDone={reload} />}

          {owner && active && (
            <div className={s.wrap}>
              {!edit && <button type="button" className="btn sm" onClick={() => setEdit(true)}><Icon name="edit" size={14} strokeWidth={2} />Edit</button>}
              <div className="grow" />
              {confirmCancel ? (
                <>
                  <span className="small">Cancel this order{o.reserved_m > 0 ? ' and release its lots' : ''}?</span>
                  <button type="button" className="btn sm" onClick={() => setConfirmCancel(false)}>No</button>
                  <button type="button" className="btn sm danger" disabled={busy} onClick={cancel}>Yes, cancel</button>
                </>
              ) : <button type="button" className="btn sm danger" onClick={() => setConfirmCancel(true)}>Cancel order</button>}
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

function EditOrder({ ctx, o, onDone, onCancel }: { ctx: Ctx; o: OrderRow; onDone: () => void; onCancel: () => void }) {
  const { role, d } = ctx;
  const [f, setF] = useState({ meters: String(o.meters), rate_per_m: o.rate_per_m == null ? '' : String(o.rate_per_m), promise_date: o.promise_date ?? '', design: o.design ?? '', notes: o.notes ?? '' });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await apiSend<{ message: string; warnings: string[] }>(`/api/orders/${o.id}`, 'PATCH', {
        meters: f.meters, rate_per_m: f.rate_per_m || null, promise_date: f.promise_date || null, design: f.design || null, notes: f.notes || null,
        role, actor: actorId(role),
      });
      d.showToast([r.message, ...r.warnings].join(' '), r.warnings.length ? 'warning' : 'success');
      onDone();
    } catch (err) {
      d.showToast(err instanceof Error ? err.message : 'Could not save.', 'danger');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack-12" onSubmit={save}>
      <div className="two-col">
        <label className="fld">Meters<input className="num" inputMode="decimal" value={f.meters} onChange={set('meters')} /></label>
        <label className="fld">Rate ₹/m<input className="num" inputMode="decimal" value={f.rate_per_m} onChange={set('rate_per_m')} /></label>
      </div>
      <div className="two-col">
        <label className="fld">Promise date<input type="date" value={f.promise_date} onChange={set('promise_date')} /></label>
        <label className="fld">Design<input value={f.design} onChange={set('design')} /></label>
      </div>
      <label className="fld">Notes<textarea className="input" rows={2} value={f.notes} onChange={set('notes')} /></label>
      <div className={s.wrap}>
        <button type="button" className="btn sm" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn sm primary" disabled={busy}><Icon name="check" size={14} strokeWidth={2} />Save</button>
      </div>
    </form>
  );
}

function ManualAllocate({ ctx, orderId, need, busy, onDone }: { ctx: Ctx; orderId: number; need: number; busy: boolean; onDone: () => void }) {
  const { role, d } = ctx;
  const actor = actorId(role);
  const [openPick, setOpenPick] = useState(false);
  const { data, error, reload } = useApi<{ need_m: number; lots: Candidate[] }>(openPick ? `/api/orders/${orderId}/candidates?${who(role, actor)}` : null, d.lastSync);
  const [lot, setLot] = useState('');
  const [meters, setMeters] = useState('');
  const [saving, setSaving] = useState(false);
  const chosen = data?.lots.find((l) => l.lot_id === lot) ?? null;

  const pick = (id: string) => {
    setLot(id);
    const c = data?.lots.find((l) => l.lot_id === id);
    if (c) setMeters(String(Math.min(c.free, need)));
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lot || !meters) return d.showToast('Pick a lot and enter meters.', 'warning');
    setSaving(true);
    try {
      const r = await apiSend<{ allocated_m: number }>(`/api/orders/${orderId}/allocate`, 'POST', { lot_id: lot, meters, role, actor });
      d.showToast(`Reserved ${m(r.allocated_m)} of lot ${lot}.`, 'success');
      setLot('');
      setMeters('');
      reload();
      onDone();
    } catch (err) {
      d.showToast(err instanceof Error ? err.message : 'Could not reserve.', 'danger');
    } finally {
      setSaving(false);
    }
  };

  if (!openPick) return <button type="button" className="btn sm" onClick={() => setOpenPick(true)}>Pick a lot myself</button>;
  return (
    <form className="card flat pad stack-12" onSubmit={submit}>
      <span className="strong">Reserve a lot</span>
      {error && <div className="alert bad">{error}</div>}
      {data && !data.lots.length && <span className="muted small">No free lots of this quality.</span>}
      {data && data.lots.length > 0 && (
        <>
          <label className="fld">Lot
            <select value={lot} onChange={(e) => pick(e.target.value)}>
              <option value="">Choose…</option>
              {data.lots.map((l) => (
                <option key={l.lot_id} value={l.lot_id}>{l.lot_id} · {l.design}{l.design_match ? '' : ' (other design)'} · {fmt(l.free, 1)} m free</option>
              ))}
            </select>
          </label>
          <label className="fld">Meters{chosen ? ` (up to ${fmt(Math.min(chosen.free, need), 1)})` : ''}
            <input className="num" inputMode="decimal" value={meters} onChange={(e) => setMeters(e.target.value)} />
          </label>
          <div className={s.wrap}>
            <button type="button" className="btn sm" onClick={() => setOpenPick(false)}>Close</button>
            <button type="submit" className="btn sm primary" disabled={saving || busy || !lot}>Reserve</button>
          </div>
        </>
      )}
    </form>
  );
}
