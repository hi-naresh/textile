'use client';

// Dispatch & documents (Phase 2 — Logistics & Dispatch + Document Generation agents).
// Owner + supervisor: record dispatches, print challan / packing list. Owner only: GST invoices,
// Tally invoices, Tally export, party statements (₹). Supervisors never see ₹ here.
import React, { useEffect, useMemo, useState } from 'react';
import Icon from '../Icon';
import { Empty, PageHead, Pill, Segmented, Sheet, dayTime, fmt, type Tone } from '../ui';
import type { Ctx } from '../ctx';
import { can } from '@/lib/access';
import { actorId } from '@/lib/useTextileData';
import { apiSend, useApi, who } from '@/lib/useApi';
import type { Allocation, Dispatch as DispatchRow, Invoice, Order, Party } from '@/lib/domain';
import s from './Dispatch.module.css';
import { LotPicker } from '../LotPicker';

type InvoiceRow = Invoice & { days_overdue: number; exported_at: string | null };
type View = 'dispatches' | 'invoices';

const key = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
const rupees = (n: number) => `₹ ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const todayLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // firm's day (India), same as the server
const monthStart = () => `${todayLocal().slice(0, 8)}01`;
const shortDate = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
};

export function Dispatch({ ctx }: { ctx: Ctx }) {
  const owner = can(ctx.role, 'finance.view');
  const [view, setView] = useState<View>('dispatches');
  const [newOpen, setNewOpen] = useState(false);
  const [tallyOpen, setTallyOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  const v: View = owner ? view : 'dispatches';

  return (
    <div className="page fade">
      <PageHead title="Dispatch & documents" sub={owner ? 'Challans, packing lists, GST invoices' : 'Record dispatches, print challans'}>
        {v === 'invoices'
          ? <button className="btn" onClick={() => setTallyOpen(true)}><Icon name="plus" size={16} strokeWidth={2} />Tally invoice</button>
          : <button className="btn primary" onClick={() => setNewOpen(true)}><Icon name="truck" size={16} strokeWidth={2} />New dispatch</button>}
      </PageHead>
      {owner && (
        <div className="toolbar">
          <Segmented label="View" value={view} onChange={setView} options={[{ value: 'dispatches', label: 'Dispatches' }, { value: 'invoices', label: 'Invoices' }]} />
        </div>
      )}
      {v === 'dispatches' ? <DispatchList ctx={ctx} tick={tick} onChanged={bump} /> : <InvoiceList ctx={ctx} tick={tick} onChanged={bump} />}
      <Sheet open={newOpen} title="New dispatch" onClose={() => setNewOpen(false)}>
        {newOpen && <DispatchForm ctx={ctx} onDone={() => { setNewOpen(false); bump(); }} />}
      </Sheet>
      <Sheet open={tallyOpen} title="Record Tally invoice" onClose={() => setTallyOpen(false)}>
        {tallyOpen && <TallyForm ctx={ctx} onDone={() => { setTallyOpen(false); bump(); }} />}
      </Sheet>
    </div>
  );
}

// ---------------- Dispatch list ----------------
function DispatchList({ ctx, tick, onChanged }: { ctx: Ctx; tick: number; onChanged: () => void }) {
  const owner = can(ctx.role, 'finance.view');
  const actor = actorId(ctx.role);
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const [busy, setBusy] = useState<number | null>(null);
  const { data, error, loading } = useApi<{ dispatches: DispatchRow[] }>(`/api/dispatches?days=${days}&${who(ctx.role, actor)}`, `${ctx.d.lastSync}-${tick}`);
  const rows = data?.dispatches ?? [];
  const q = who(ctx.role, actor);

  const [invFor, setInvFor] = useState<DispatchRow | null>(null);
  const createInvoice = async (d: DispatchRow, rates: Record<string, number>) => {
    setBusy(d.id);
    try {
      const r = await apiSend<{ invoice: Invoice; note: string | null }>('/api/invoices', 'POST', { dispatch_id: d.id, rates, role: ctx.role, actor });
      ctx.d.showToast(`Invoice ${r.invoice.invoice_no} · ${rupees(r.invoice.total)}`);
      if (r.note) ctx.d.showToast(r.note, 'warning');
      setInvFor(null);
      onChanged();
    } catch (e) {
      ctx.d.showToast(e instanceof Error ? e.message : 'Could not create the invoice.', 'danger');
    } finally {
      setBusy(null);
    }
  };

  const totalM = rows.reduce((t, r) => t + r.meters, 0);
  return (
    <>
      <div className="toolbar">
        <Segmented label="Period" value={days} onChange={setDays} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
        <div className="grow" />
        {rows.length > 0 && <span className="t2 small"><span className="num strong">{rows.length}</span> dispatches · <span className="num strong">{fmt(totalM, 1)} m</span></span>}
      </div>
      {error ? <div className="alert bad">{error}</div> : loading && !data ? <div className="card pad muted">Loading…</div> : !rows.length ? (
        <Empty title="No dispatches yet" text="Record a dispatch to print its challan and packing list." />
      ) : (
        <section className="card flush">
          <table className="tbl rtbl">
            <thead>
              <tr>
                <th>Date</th><th>Party</th><th>Lots</th><th className="r">Meters</th><th>Challan</th>
                <th className="d">Transport</th>{owner && <th>Invoice</th>}<th className="r">Documents</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td data-label="Date" className="num t2">{dayTime(d.dispatched_at)}</td>
                  <td data-label="Party" className="strong">{d.party_name ?? '—'}{d.order_id ? <div className="muted small">Order #{d.order_id}</div> : null}</td>
                  <td data-label="Lots"><div className="num">{d.lots.slice(0, 3).join(', ')}{d.lots.length > 3 ? ` +${d.lots.length - 3}` : ''}</div></td>
                  <td data-label="Meters" className="r num strong">{fmt(d.meters, 1)}</td>
                  <td data-label="Challan" className="num">{d.challan_no ?? '—'}</td>
                  <td data-label="Transport" className="t2 d">
                    <div>{d.transporter ?? '—'}</div>
                    {(d.lr_no || d.vehicle_no) && <div className="muted small">{[d.lr_no && `LR ${d.lr_no}`, d.vehicle_no].filter(Boolean).join(' · ')}</div>}
                  </td>
                  {owner && (
                    <td data-label="Invoice" className="num">
                      {d.invoice_no ?? <button className="btn sm" disabled={busy === d.id} onClick={() => setInvFor(d)}>{busy === d.id ? 'Creating…' : 'Create'}</button>}
                    </td>
                  )}
                  <td data-label="Documents" className="r">
                    <div className={s.docs}>
                      <a className="btn sm" href={`/api/docs/challan?dispatch_id=${d.id}&${q}`} target="_blank" rel="noopener">Challan</a>
                      <a className="btn sm" href={`/api/docs/packing-list?dispatch_id=${d.id}&${q}`} target="_blank" rel="noopener">Packing</a>
                      {owner && d.invoice_id && <a className="btn sm" href={`/api/docs/invoice?id=${d.invoice_id}&${q}`} target="_blank" rel="noopener">Invoice</a>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <Sheet open={invFor != null} title={invFor ? `Invoice for ${invFor.party_name ?? 'dispatch'}` : ''} onClose={() => setInvFor(null)}>
        {invFor && <InvoiceRates ctx={ctx} dispatch={invFor} busy={busy === invFor.id} onCreate={(rates) => createInvoice(invFor, rates)} />}
      </Sheet>
    </>
  );
}

/** Rates for a new invoice: typed per quality; blank uses the order's rate. There is no rate list. */
function InvoiceRates({ ctx, dispatch, busy, onCreate }: { ctx: Ctx; dispatch: DispatchRow; busy: boolean; onCreate: (rates: Record<string, number>) => void }) {
  const q = who(ctx.role, actorId(ctx.role));
  const orderApi = useApi<{ order: Order }>(dispatch.order_id ? `/api/orders/${dispatch.order_id}?${q}` : null);
  const order = orderApi.data?.order ?? null;
  const qualities = [...new Set(dispatch.lots.map((id) => ctx.d.lots.find((l) => l.lot_id === id)?.quality).filter((x): x is string => !!x))];
  const [rates, setRates] = useState<Record<string, string>>({});
  const orderRate = (ql: string) => (order && key(order.quality) === key(ql) && order.rate_per_m ? order.rate_per_m : null);
  const missing = qualities.filter((ql) => !(parseFloat(rates[ql] ?? '') > 0) && orderRate(ql) == null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onCreate(Object.fromEntries(Object.entries(rates).filter(([, x]) => parseFloat(x) > 0).map(([k, x]) => [k, parseFloat(x)])));
  };
  return (
    <form className="stack-16" onSubmit={submit}>
      <span className="muted small">{fmt(dispatch.meters, 1)} m · challan {dispatch.challan_no ?? '—'}{dispatch.order_id ? ` · order #${dispatch.order_id}` : ''}</span>
      <span className="muted small hint">Type the ₹/m rate for this party. Leave blank to use the order’s rate.</span>
      <div className={s.rates}>
        {qualities.map((ql) => (
          <label key={ql} className="fld">{ql} ₹/m
            <input className="num" inputMode="decimal" value={rates[ql] ?? ''} placeholder={orderRate(ql) != null ? String(orderRate(ql)) : 'Rate needed'} onChange={(e) => setRates({ ...rates, [ql]: e.target.value })} />
          </label>
        ))}
        {!qualities.length && <span className="muted small">Lots of this dispatch are not loaded. Refresh and try again.</span>}
      </div>
      <button className="btn primary big" type="submit" disabled={busy || !qualities.length || missing.length > 0}>{busy ? 'Creating…' : 'Create invoice'}</button>
    </form>
  );
}

// ---------------- New dispatch ----------------
interface Line { lot_id: string; meters: string }
const EMPTY_LINE: Line = { lot_id: '', meters: '' };

function DispatchForm({ ctx, onDone }: { ctx: Ctx; onDone: () => void }) {
  const { d, role } = ctx;
  const owner = can(role, 'finance.view');
  const actor = actorId(role);
  const q = who(role, actor);
  const [party, setParty] = useState('');
  const [orderId, setOrderId] = useState('');
  const [lines, setLines] = useState<Line[]>([{ ...EMPTY_LINE }]);
  const [f, setF] = useState({ challan_no: '', transporter: '', lr_no: '', vehicle_no: '', packages: '' });
  const [invoice, setInvoice] = useState(false);
  const [rates, setRates] = useState<Record<string, string>>({});
  const [credit, setCredit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Parties (Money API) — falls back to names already used on dispatches.
  const partiesApi = useApi<{ parties: Party[] }>(`/api/parties?${q}`);
  const parties = partiesApi.data?.parties ?? [];
  const partyNames = parties.length ? parties.filter((p) => p.active !== false).map((p) => p.name) : d.names.parties;
  const partyId = parties.find((p) => key(p.name) === key(party))?.id ?? null;

  // Open orders of this party (Sales API) — optional.
  const ordersApi = useApi<{ orders: Order[] }>(partyId ? `/api/orders?status=open&party_id=${partyId}&${q}` : null);
  const orders = (partyId ? ordersApi.data?.orders ?? [] : []).filter((o) => o.party_id === partyId && (o.status === 'open' || o.status === 'partly_dispatched'));
  const order = orders.find((o) => String(o.id) === orderId) ?? null;
  const orderDetail = useApi<{ order: Order; allocations: Allocation[] }>(order ? `/api/orders/${order.id}?${q}` : null);

  const stock = useMemo(() => d.lots.filter((l) => l.balance > 0), [d.lots]);
  const lotOf = (id: string) => d.lots.find((l) => l.lot_id === id);
  const totalM = lines.reduce((t, l) => t + (parseFloat(l.meters) || 0), 0);
  const suggested = order ? stock.filter((l) => key(l.quality) === key(order.quality) && !lines.some((x) => x.lot_id === l.lot_id)).slice(0, 8) : [];
  const reserved = (orderDetail.data?.allocations ?? []).filter((a) => a.status === 'reserved' && a.meters - a.dispatched_m > 0);
  const qualities = [...new Set(lines.map((l) => lotOf(l.lot_id)?.quality).filter((x): x is string => !!x))];

  // Credit warning (Money API) as the party / meters change. Never blocks the dispatch.
  const estimate = owner && order?.rate_per_m ? Math.round(totalM * order.rate_per_m) : 0;
  useEffect(() => {
    if (!party.trim()) return;
    let alive = true;
    const t = setTimeout(() => {
      fetch(`/api/credit/check?party=${encodeURIComponent(party.trim())}&amount=${estimate}&${q}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (alive) setCredit(j?.warn ?? null); })
        .catch(() => { if (alive) setCredit(null); });
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [party, estimate, q]);

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addLot = (lot_id: string, meters: number) => setLines((ls) => [...ls.filter((l) => l.lot_id || l.meters), { lot_id, meters: String(meters) }]);
  const useReserved = () => setLines(reserved.map((a) => {
    const bal = lotOf(a.lot_id)?.balance ?? 0;
    return { lot_id: a.lot_id, meters: String(Math.round(Math.min(a.meters - a.dispatched_m, bal) * 100) / 100) };
  }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!party.trim()) return d.showToast('Party is required.', 'warning');
    const ls = lines.filter((l) => l.lot_id || l.meters);
    if (!ls.length) return d.showToast('Add at least one lot.', 'warning');
    for (const l of ls) {
      if (!l.lot_id || !(parseFloat(l.meters) > 0)) return d.showToast('Each line needs a lot and meters.', 'warning');
      const lot = lotOf(l.lot_id);
      if (lot && parseFloat(l.meters) > lot.balance) return d.showToast(`${l.lot_id} has only ${fmt(lot.balance, 1)} m.`, 'warning');
    }
    const rateMap = Object.fromEntries(Object.entries(rates).filter(([, x]) => parseFloat(x) > 0).map(([k, x]) => [k, parseFloat(x)]));
    setBusy(true);
    try {
      const r = await apiSend<{ dispatch: DispatchRow; invoice?: Invoice; note?: string | null }>('/api/dispatches', 'POST', {
        party: party.trim(), order_id: order?.id ?? null, lines: ls.map((l) => ({ lot_id: l.lot_id, meters: parseFloat(l.meters) })),
        ...f, packages: f.packages === '' ? null : Number(f.packages), create_invoice: owner && invoice, rates: owner && invoice ? rateMap : undefined, role, actor,
      });
      d.showToast(`Dispatched ${fmt(r.dispatch.meters, 1)} m · challan ${r.dispatch.challan_no}${r.invoice ? ` · invoice ${r.invoice.invoice_no}` : ''}`);
      if (r.note) d.showToast(r.note, 'warning');
      d.refresh();
      onDone();
    } catch (err) {
      d.showToast(err instanceof Error ? err.message : 'Could not save the dispatch.', 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack-16" onSubmit={submit}>
      <label className="fld">Party
        <input list="dispatch-party-list" value={party} onChange={(e) => { setParty(e.target.value); setOrderId(''); if (!e.target.value.trim()) setCredit(null); }} autoComplete="off" placeholder="Client receiving the goods" />
        <datalist id="dispatch-party-list">{partyNames.map((n) => <option key={n} value={n} />)}</datalist>
      </label>
      {credit && <div className="alert warn">{credit}</div>}

      {orders.length > 0 && (
        <label className="fld">Against order
          <select value={orderId} onChange={(e) => setOrderId(e.target.value)}>
            <option value="">No order / match later</option>
            {orders.map((o) => (
              <option key={o.id} value={o.id}>#{o.id} · {o.quality}{o.design ? ` ${o.design}` : ''} · {fmt(o.meters - (o.dispatched_m ?? 0), 0)} m left</option>
            ))}
          </select>
        </label>
      )}
      {order && (
        <div className="stack-6">
          <span className="muted small">{order.quality}{order.design ? ` · ${order.design}` : ''} · {fmt(order.meters, 0)} m ordered · {fmt(order.dispatched_m ?? 0, 0)} m sent</span>
          {reserved.length > 0 && <button type="button" className="btn sm" onClick={useReserved}>Use reserved lots ({reserved.map((a) => a.lot_id).join(', ')})</button>}
          {suggested.length > 0 && (
            <div className={s.lotChips}>
              {suggested.map((l) => (
                <button key={l.lot_id} type="button" className="chip" onClick={() => addLot(l.lot_id, Math.min(l.balance, Math.max(0, order.meters - (order.dispatched_m ?? 0) - totalM) || l.balance))}>
                  <Icon name="plus" size={12} strokeWidth={2} />{l.lot_id} · {fmt(l.balance, 0)} m
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="fld">Lots and meters
        <div className={s.lines}>
          {lines.map((l, i) => {
            const lot = lotOf(l.lot_id);
            const over = lot != null && parseFloat(l.meters) > lot.balance;
            return (
              <div key={i} className={s.line}>
                <div className="stack-2 min0"><LotPicker ariaLabel={`Lot ${i + 1}`} lots={stock} value={l.lot_id} onChange={(v) => setLine(i, { lot_id: v })} placeholder="Lot no." /></div>
                <input aria-label={`Meters ${i + 1}`} className={over ? s.over : ''} inputMode="decimal" value={l.meters} placeholder="Meters" onChange={(e) => setLine(i, { meters: e.target.value })} />
                <button type="button" className="btn icon-only" aria-label="Remove line" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : [{ ...EMPTY_LINE }]))}><Icon name="x" size={16} /></button>
                {lot && (
                  <span className={`small ${s.sub} ${over ? s.bad : 'muted'}`}>
                    {lot.quality} · {lot.design} · {fmt(lot.balance, 1)} m in stock{lot.location ? ` · ${lot.location}` : ''}
                    {!over && lot.balance > 0 && <> · <button type="button" className="linkbtn" onClick={() => setLine(i, { meters: String(lot.balance) })}>all</button></>}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <div className="row-10">
          <button type="button" className="btn sm" onClick={() => setLines((ls) => [...ls, { ...EMPTY_LINE }])}><Icon name="plus" size={14} strokeWidth={2} />Add lot</button>
          <span className="grow" />
          <span className="small t2">Total <span className="num strong">{fmt(totalM, 2)} m</span></span>
        </div>
      </div>

      <div className="two-col">
        <label className="fld">Challan no.<input className="num" value={f.challan_no} onChange={(e) => setF({ ...f, challan_no: e.target.value })} placeholder="Auto" /></label>
        <label className="fld">Packages<input className="num" inputMode="numeric" value={f.packages} onChange={(e) => setF({ ...f, packages: e.target.value.replace(/\D/g, '') })} /></label>
      </div>
      <label className="fld">Transporter<input value={f.transporter} onChange={(e) => setF({ ...f, transporter: e.target.value })} /></label>
      <div className="two-col">
        <label className="fld">LR no.<input className="num" value={f.lr_no} onChange={(e) => setF({ ...f, lr_no: e.target.value })} /></label>
        <label className="fld">Vehicle<input className="num" value={f.vehicle_no} onChange={(e) => setF({ ...f, vehicle_no: e.target.value })} placeholder="GJ05 AB 1234" /></label>
      </div>

      {owner && (
        <div className="stack-10">
          <label className="check"><input type="checkbox" checked={invoice} onChange={(e) => setInvoice(e.target.checked)} />Create GST invoice</label>
          {invoice && qualities.length > 0 && (
            <>
              <span className="muted small hint">Type the ₹/m rate for this party. Leave blank to use the order’s rate.</span>
              <div className={s.rates}>
                {qualities.map((ql) => (
                  <label key={ql} className="fld">{ql} ₹/m
                    <input className="num" inputMode="decimal" value={rates[ql] ?? ''} placeholder={order && key(order.quality) === key(ql) && order.rate_per_m ? String(order.rate_per_m) : 'Rate needed'} onChange={(e) => setRates({ ...rates, [ql]: e.target.value })} />
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      <span className="muted small hint">Stock goes down now. A lot that is fully sent is marked “Dispatched”.</span>
      <button className="btn primary big" type="submit" disabled={busy}>{busy ? 'Saving…' : `Record dispatch${totalM ? ` · ${fmt(totalM, 1)} m` : ''}`}</button>
    </form>
  );
}

// ---------------- Invoices (owner) ----------------
type InvFilter = 'all' | 'open' | 'overdue' | 'paid' | 'cancelled';
const STATUS: Record<Invoice['status'], { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'info' }, part_paid: { label: 'Part paid', tone: 'warn' }, paid: { label: 'Paid', tone: 'good' }, cancelled: { label: 'Cancelled', tone: 'neutral' },
};

function InvoiceList({ ctx, tick, onChanged }: { ctx: Ctx; tick: number; onChanged: () => void }) {
  const actor = actorId(ctx.role);
  const q = who(ctx.role, actor);
  const [filter, setFilter] = useState<InvFilter>('all');
  const [busy, setBusy] = useState<number | null>(null);
  const { data, error, loading } = useApi<{ invoices: InvoiceRow[] }>(`/api/invoices?${q}${filter === 'all' ? '' : `&status=${filter}`}`, `${ctx.d.lastSync}-${tick}`);
  const rows = data?.invoices ?? [];
  const due = rows.filter((r) => r.status === 'open' || r.status === 'part_paid').reduce((t, r) => t + r.balance, 0);

  const cancel = async (inv: InvoiceRow) => {
    if (!window.confirm(`Cancel invoice ${inv.invoice_no}? The dispatch can then be invoiced again.`)) return;
    setBusy(inv.id);
    try {
      await apiSend(`/api/invoices/${inv.id}`, 'PATCH', { status: 'cancelled', role: ctx.role, actor });
      ctx.d.showToast(`Invoice ${inv.invoice_no} cancelled`);
      onChanged();
    } catch (e) {
      ctx.d.showToast(e instanceof Error ? e.message : 'Could not cancel.', 'danger');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="toolbar">
        <div className="chips">
          {(['all', 'open', 'overdue', 'paid', 'cancelled'] as InvFilter[]).map((x) => (
            <button key={x} type="button" className={`chip ${filter === x ? 'on' : ''}`} aria-pressed={filter === x} onClick={() => setFilter(x)}>{x[0].toUpperCase() + x.slice(1)}</button>
          ))}
        </div>
        <div className="grow" />
        {rows.length > 0 && <span className="t2 small">Due <span className="num strong">{rupees(due)}</span></span>}
      </div>
      {error ? <div className="alert bad">{error}</div> : loading && !data ? <div className="card pad muted">Loading…</div> : !rows.length ? (
        <Empty title="No invoices" text={filter === 'all' ? 'Create one from a dispatch, or record an invoice made in Tally.' : 'Nothing in this list.'} />
      ) : (
        <section className="card flush">
          <table className="tbl rtbl">
            <thead>
              <tr><th>Invoice</th><th className="d">Date</th><th>Party</th><th className="r">Total</th><th className="r d">Paid</th><th className="r">Balance</th><th>Due</th><th>Status</th><th className="r">Actions</th></tr>
            </thead>
            <tbody>
              {rows.map((inv) => {
                const overdue = (inv.status === 'open' || inv.status === 'part_paid') && inv.days_overdue > 0;
                return (
                  <tr key={inv.id}>
                    <td data-label="Invoice" className="num strong">{inv.invoice_no}{inv.source === 'tally' && <div className="muted small">Tally</div>}</td>
                    <td data-label="Date" className="num t2 d">{shortDate(inv.invoice_date)}</td>
                    <td data-label="Party">{inv.party_name}</td>
                    <td data-label="Total" className="r num">{rupees(inv.total)}</td>
                    <td data-label="Paid" className="r num t2 d">{rupees(inv.paid)}</td>
                    <td data-label="Balance" className="r num strong">{inv.status === 'cancelled' ? '—' : rupees(inv.balance)}</td>
                    <td data-label="Due" className="num">{overdue ? <Pill tone="bad">{shortDate(inv.due_date)} · {inv.days_overdue}d late</Pill> : <span className="t2">{shortDate(inv.due_date)}</span>}</td>
                    <td data-label="Status"><Pill tone={overdue ? 'bad' : STATUS[inv.status].tone}>{overdue ? 'Overdue' : STATUS[inv.status].label}</Pill></td>
                    <td data-label="Actions" className="r">
                      <div className={s.docs}>
                        {inv.source === 'app' && <a className="btn sm" href={`/api/docs/invoice?id=${inv.id}&${q}`} target="_blank" rel="noopener">PDF</a>}
                        {inv.status !== 'cancelled' && <button className="btn sm danger" disabled={busy === inv.id} onClick={() => cancel(inv)}>Cancel</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
      <div className="grid-split">
        <TallyExport ctx={ctx} />
        <Statement ctx={ctx} />
      </div>
    </>
  );
}

function TallyExport({ ctx }: { ctx: Ctx }) {
  const q = who(ctx.role, actorId(ctx.role));
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayLocal());
  const base = `/api/invoices/export?from=${from}&to=${to}&${q}`;
  return (
    <section className="card">
      <div className="card-head pad-x"><h2>Export for Tally</h2><span className="muted small">app invoices</span></div>
      <div className={`${s.cardBody} stack-12`}>
        <div className={s.exportRow}>
          <label className="fld">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="fld">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
        <div className="row-8">
          <a className="btn" href={`${base}&format=xlsx`} download><Icon name="download" size={16} strokeWidth={2} />Excel</a>
          <a className="btn" href={`${base}&format=xml`} download><Icon name="download" size={16} strokeWidth={2} />Tally XML</a>
        </div>
        <span className="muted small">In Tally: Import → Vouchers. Needs ledgers Sales, CGST Output, SGST Output, IGST Output, Round Off and each party.</span>
      </div>
    </section>
  );
}

function Statement({ ctx }: { ctx: Ctx }) {
  const q = who(ctx.role, actorId(ctx.role));
  const { data } = useApi<{ parties: Party[] }>(`/api/parties?${q}`);
  const parties = data?.parties ?? [];
  const [pid, setPid] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(todayLocal());
  return (
    <section className="card">
      <div className="card-head pad-x"><h2>Party statement</h2><span className="muted small">PDF</span></div>
      <div className={`${s.cardBody} stack-12`}>
        {parties.length ? (
          <label className="fld">Party
            <select value={pid} onChange={(e) => setPid(e.target.value)}>
              <option value="">Pick a party</option>
              {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        ) : <span className="muted small">Party list is not available yet.</span>}
        <div className={s.exportRow}>
          <label className="fld">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="fld">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
        {pid
          ? <a className="btn" href={`/api/docs/statement?party_id=${pid}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}&${q}`} target="_blank" rel="noopener">Open statement</a>
          : <button className="btn" disabled>Open statement</button>}
        <span className="muted small">Blank “from” = start of the financial year.</span>
      </div>
    </section>
  );
}

// ---------------- Record Tally invoice ----------------
function TallyForm({ ctx, onDone }: { ctx: Ctx; onDone: () => void }) {
  const actor = actorId(ctx.role);
  const partiesApi = useApi<{ parties: Party[] }>(`/api/parties?${who(ctx.role, actor)}`);
  const names = partiesApi.data?.parties?.map((p) => p.name) ?? ctx.d.names.parties;
  const [f, setF] = useState({ invoice_no: '', party: '', invoice_date: todayLocal(), taxable_amount: '', total: '', due_date: '' });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.invoice_no.trim() || !f.party.trim() || !(parseFloat(f.total) > 0)) return ctx.d.showToast('Invoice no, party and total are required.', 'warning');
    setBusy(true);
    try {
      const r = await apiSend<{ invoice: Invoice }>('/api/invoices', 'POST', {
        source: 'tally', invoice_no: f.invoice_no.trim(), party: f.party.trim(), invoice_date: f.invoice_date,
        taxable_amount: f.taxable_amount || null, total: f.total, due_date: f.due_date || null, role: ctx.role, actor,
      });
      ctx.d.showToast(`Recorded ${r.invoice.invoice_no} · due ${shortDate(r.invoice.due_date)}`);
      onDone();
    } catch (err) {
      ctx.d.showToast(err instanceof Error ? err.message : 'Could not save.', 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack-16" onSubmit={submit}>
      <span className="muted small">For invoices made in Tally: amounts only, so payments and credit stay right.</span>
      <label className="fld">Invoice no.<input className="num" value={f.invoice_no} onChange={set('invoice_no')} /></label>
      <label className="fld">Party
        <input list="tally-party-list" value={f.party} onChange={set('party')} autoComplete="off" />
        <datalist id="tally-party-list">{names.map((n) => <option key={n} value={n} />)}</datalist>
      </label>
      <div className="two-col">
        <label className="fld">Invoice date<input type="date" value={f.invoice_date} onChange={set('invoice_date')} /></label>
        <label className="fld">Due date<input type="date" value={f.due_date} onChange={set('due_date')} /></label>
      </div>
      <span className="muted small hint">Blank due date = invoice date + the party’s credit days.</span>
      <div className="two-col">
        <label className="fld">Taxable ₹<input className="num" inputMode="decimal" value={f.taxable_amount} onChange={set('taxable_amount')} placeholder="Optional" /></label>
        <label className="fld">Total ₹<input className="num" inputMode="decimal" value={f.total} onChange={set('total')} /></label>
      </div>
      <button className="btn primary big" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Record invoice'}</button>
    </form>
  );
}
