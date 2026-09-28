'use client';

// Money (owner only): Outstanding (credit & ageing, reminders, statements), Payments, Margin.
import React, { useState } from 'react';
import Icon from '../Icon';
import { Empty, Kpi, PageHead, Pill, Segmented, Sheet, fmt, inr, type Tone } from '../ui';
import type { Ctx } from '../ctx';
import { apiSend, takeHash, useApi, who } from '@/lib/useApi';
import { actorId } from '@/lib/useTextileData';
import type { Party, Payment } from '@/lib/domain';
import type { BucketKey, CreditTotals, PartyCredit } from '@/lib/money/credit';
import type { MarginBy, MarginRow } from '@/lib/money/costing';
import type { Reminder } from '@/lib/money/reminder';
import s from './Money.module.css';

type View = 'out' | 'pay' | 'margin';
type Lang = 'en' | 'hi' | 'gu';
type PaymentRow = Payment & { invoice_no: string | null };

const BUCKETS: { k: BucketKey; label: string; cls: string; tone: Tone }[] = [
  { k: 'current', label: 'Not due', cls: s.b0, tone: 'info' },
  { k: 'd1_30', label: '1–30 d', cls: s.b1, tone: 'warn' },
  { k: 'd31_60', label: '31–60 d', cls: s.b2, tone: 'warn' },
  { k: 'd61_90', label: '61–90 d', cls: s.b3, tone: 'bad' },
  { k: 'd90p', label: '90+ d', cls: s.b4, tone: 'bad' },
];

const rs = (n: number | null | undefined) => (n == null ? '—' : n < 0 ? `− ${inr(-n)}` : inr(n));
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const shortDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });

export function Money({ ctx }: { ctx: Ctx }) {
  if (ctx.role !== 'owner') {
    return (
      <div className="page fade">
        <PageHead title="Money" />
        <Empty title="Owner only" text="Invoices, payments and margins are only shown to the owner." />
      </div>
    );
  }
  return <OwnerMoney ctx={ctx} />;
}

function OwnerMoney({ ctx }: { ctx: Ctx }) {
  const [view, setView] = useState<View>('out');
  const [bump, setBump] = useState(0);
  const refresh = () => setBump((b) => b + 1);
  const key = `${ctx.d.lastSync?.getTime() ?? 0}:${bump}`;
  const q = who(ctx.role, actorId(ctx.role));
  const credit = useApi<{ parties: PartyCredit[]; totals: CreditTotals }>(`/api/credit?${q}`, key);
  const [payFor, setPayFor] = useState<string | null>(null); // party name for the payment sheet
  const [remFor, setRemFor] = useState<PartyCredit | null>(null);
  // Deep link from a credit alert (#party=12): open that party's reminder once the data is in.
  const [linkParty, setLinkParty] = useState(() => Number(takeHash('party')) || null);
  const linked = linkParty ? credit.data?.parties.find((p) => p.party_id === linkParty) ?? null : null;
  const reminder = remFor ?? linked;

  return (
    <div className="page fade">
      <PageHead title="Money" sub="Outstanding, payments and margin · owner only">
        <button className="btn primary" onClick={() => setPayFor('')}><Icon name="plus" size={16} strokeWidth={2} />Record payment</button>
      </PageHead>
      <Segmented label="Money view" value={view} onChange={setView} className="fit"
        options={[{ value: 'out', label: 'Outstanding' }, { value: 'pay', label: 'Payments' }, { value: 'margin', label: 'Margin' }]} />
      {view === 'out' && <Outstanding ctx={ctx} data={credit.data} error={credit.error} loading={credit.loading} onPay={(n) => setPayFor(n)} onRemind={setRemFor} />}
      {view === 'pay' && <Payments ctx={ctx} refreshKey={key} onSaved={refresh} />}
      {view === 'margin' && <Margin ctx={ctx} refreshKey={key} />}

      <Sheet open={payFor != null} title="Record payment" onClose={() => setPayFor(null)}>
        {payFor != null && <PaymentForm ctx={ctx} initialParty={payFor} onSaved={() => { setPayFor(null); refresh(); }} />}
      </Sheet>
      <Sheet open={reminder != null} title={reminder ? `Reminder · ${reminder.name}` : 'Reminder'} onClose={() => { setRemFor(null); setLinkParty(null); }}>
        {reminder && <ReminderPanel ctx={ctx} party={reminder} />}
      </Sheet>
    </div>
  );
}

// ---------- Outstanding ----------
function AgeBar({ b, total }: { b: PartyCredit['buckets']; total: number }) {
  const sum = BUCKETS.reduce((a, x) => a + b[x.k], 0) || total || 1;
  const parts = BUCKETS.filter((x) => b[x.k] > 0);
  return (
    <div className={s.ageCell}>
      <div className={s.age} role="img" aria-label={parts.map((x) => `${x.label}: ${inr(b[x.k])}`).join(', ') || 'Nothing pending'}>
        {parts.map((x) => <span key={x.k} className={x.cls} style={{ width: `${(b[x.k] / sum) * 100}%` }} title={`${x.label}: ${inr(b[x.k])}`} />)}
      </div>
      <div className={s.ageLegend}>
        {parts.map((x) => <span key={x.k}><i className={x.cls} />{x.label} {inr(b[x.k])}</span>)}
        {!parts.length && <span>Nothing pending</span>}
      </div>
    </div>
  );
}

function Outstanding({ ctx, data, error, loading, onPay, onRemind }: { ctx: Ctx; data: { parties: PartyCredit[]; totals: CreditTotals } | null; error: string | null; loading: boolean; onPay: (name: string) => void; onRemind: (p: PartyCredit) => void }) {
  const [filter, setFilter] = useState<'due' | 'all'>('due');
  if (error) return <Empty title="Could not load" text={error} />;
  if (!data) return <span className="muted small">{loading ? 'Loading…' : ''}</span>;
  const t = data.totals;
  const rows = filter === 'due' ? data.parties.filter((p) => p.outstanding > 0 || p.over_limit > 0) : data.parties;
  const q = who(ctx.role, actorId(ctx.role));
  return (
    <>
      <div className="grid-kpi">
        <Kpi label="Outstanding" value={inr(t.outstanding)} sub={t.advance > 0 ? `${inr(t.advance)} paid in advance` : `${data.parties.filter((p) => p.outstanding > 0).length} parties`} lock />
        <Kpi label="Overdue" value={inr(t.overdue)} sub={t.parties_overdue ? `${t.parties_overdue} ${t.parties_overdue === 1 ? 'party' : 'parties'} late` : 'No one is late'} subTone={t.overdue > 0 ? 'bad' : 'good'} lock />
        <Kpi label="Collected this month" value={inr(t.collected_this_month)} sub={`Billed ${inr(t.invoiced_this_month)}`} lock />
        <Kpi label="Over credit limit" value={String(t.parties_over_limit)} sub={t.parties_over_limit ? 'Hold new dispatches' : 'All within limit'} subTone={t.parties_over_limit ? 'bad' : 'good'} lock />
      </div>
      <section className="card flush">
        <div className="card-head pad-x">
          <h2>By party</h2>
          <Segmented label="Show parties" value={filter} onChange={setFilter} className="fit" options={[{ value: 'due', label: 'With dues' }, { value: 'all', label: 'All' }]} />
        </div>
        <table className="tbl rtbl">
          <thead><tr><th>Party</th><th className="r">Outstanding</th><th className="r">Overdue</th><th>Ageing</th><th className="r d">Limit · available</th><th className="r d">Last payment</th><th className="r">Actions</th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.party_id}>
                <td data-label="Party"><div className="stack-0"><span className="strong">{p.name}</span>{p.phone && <span className="muted tiny">{p.phone}</span>}</div></td>
                <td data-label="Outstanding" className="r num strong">{rs(p.outstanding)}</td>
                <td data-label="Overdue" className="r">{p.overdue > 0 ? <Pill tone={p.oldest_due_days > 60 ? 'bad' : 'warn'}><span className="num">{inr(p.overdue)} · {p.oldest_due_days} d</span></Pill> : <span className="muted">—</span>}</td>
                <td data-label="Ageing"><AgeBar b={p.buckets} total={p.outstanding} /></td>
                <td data-label="Limit" className="r num d">
                  {p.limit == null ? <span className="muted">No limit</span> : <div className="stack-0"><span>{inr(p.limit)}</span><span className={`tiny ${p.over_limit > 0 ? '' : 'muted'}`} style={p.over_limit > 0 ? { color: 'var(--bad)' } : undefined}>{p.over_limit > 0 ? `${inr(p.over_limit)} over` : `${rs(p.available)} free`}</span></div>}
                </td>
                <td data-label="Last payment" className="r num t2 d">{p.last_payment ? <div className="stack-0"><span>{inr(p.last_payment.amount)}</span><span className="muted tiny">{shortDate(p.last_payment.paid_on)}</span></div> : '—'}</td>
                <td data-label="Actions" className="r">
                  <div className={s.actions}>
                    <button className="btn sm" disabled={p.outstanding <= 0} onClick={() => onRemind(p)}>Reminder</button>
                    <a className="btn sm" href={`/api/docs/statement?party_id=${p.party_id}&${q}`} target="_blank" rel="noreferrer">Statement</a>
                    <button className="btn sm primary" onClick={() => onPay(p.name)}>Payment</button>
                  </div>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} className="muted center">{filter === 'due' ? 'Nothing outstanding' : 'No invoices or payments yet'}</td></tr>}
          </tbody>
        </table>
      </section>
    </>
  );
}

// ---------- Reminder ----------
function ReminderPanel({ ctx, party }: { ctx: Ctx; party: PartyCredit }) {
  const [lang, setLang] = useState<Lang>(ctx.lang);
  const [polish, setPolish] = useState(false);
  const url = `/api/credit/reminder?party_id=${party.party_id}&lang=${lang}${polish ? '&polish=1' : ''}&${who(ctx.role, actorId(ctx.role))}`;
  const { data, error, loading } = useApi<Reminder>(url);
  const aiOn = ctx.d.status?.ai.state === 'connected';
  const copy = async () => {
    if (!data) return;
    try { await navigator.clipboard.writeText(data.text); ctx.d.showToast('Reminder copied'); } catch { ctx.d.showToast('Could not copy — select the text and copy it', 'warning'); }
  };
  return (
    <div className="stack-16">
      <div className="fld">Language
        <Segmented label="Reminder language" value={lang} onChange={setLang} className="fit" options={[{ value: 'en', label: 'English' }, { value: 'hi', label: 'हिंदी' }, { value: 'gu', label: 'ગુજરાતી' }]} />
      </div>
      <div className="row-8" style={{ flexWrap: 'wrap' }}>
        <Pill tone="neutral">Outstanding {inr(party.outstanding)}</Pill>
        {party.overdue > 0 && <Pill tone="bad">Overdue {inr(party.overdue)}</Pill>}
      </div>
      {error && <span className="small" style={{ color: 'var(--bad)' }}>{error}</span>}
      <textarea className={s.draft} aria-label="Reminder text" readOnly value={loading && !data ? 'Preparing…' : data?.text ?? ''} />
      {!party.phone && <span className="muted small">No phone saved for {party.name}. WhatsApp will ask you to pick the chat. Add the number in Settings → Parties.</span>}
      <div className="row-8" style={{ flexWrap: 'wrap' }}>
        <button className="btn" disabled={!data} onClick={copy}>Copy</button>
        <a className={`btn primary ${!data ? 'disabled' : ''}`} aria-disabled={!data} href={data?.whatsapp_url ?? '#'} target="_blank" rel="noreferrer">Open WhatsApp</a>
        {aiOn && <button className="btn" disabled={loading || polish} onClick={() => setPolish(true)}>{polish && data?.polished ? 'Reworded' : 'Reword with AI'}</button>}
      </div>
      {polish && data && !data.polished && !loading && <span className="muted small">AI rewording was not used — the standard text is shown.</span>}
    </div>
  );
}

// ---------- Payments ----------
function PaymentForm({ ctx, initialParty, onSaved }: { ctx: Ctx; initialParty: string; onSaved: () => void }) {
  const q = who(ctx.role, actorId(ctx.role));
  const parties = useApi<{ parties: Party[] }>(`/api/parties?${q}`);
  const [party, setParty] = useState(initialParty);
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(today);
  const [mode, setMode] = useState<Payment['mode']>('bank');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await apiSend<{ payment: Payment; outstanding: number; paid_invoices: string[] }>('/api/payments', 'POST', { party, amount, paid_on: paidOn, mode, reference, role: ctx.role, actor: actorId(ctx.role) });
      const paid = r.paid_invoices.length ? ` · ${r.paid_invoices.join(', ')} paid` : '';
      ctx.d.showToast(`${inr(r.payment.amount)} from ${r.payment.party_name} saved · ${r.outstanding > 0 ? `${inr(r.outstanding)} still due` : 'nothing due'}${paid}`);
      setAmount(''); setReference('');
      onSaved();
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'Could not save.');
    } finally { setBusy(false); }
  };
  return (
    <form className="stack-16" onSubmit={submit}>
      <label className="fld">Party
        <input list="money-parties" value={party} onChange={(e) => setParty(e.target.value)} placeholder="Start typing a party" autoComplete="off" required />
        <datalist id="money-parties">{parties.data?.parties.filter((p) => p.active).map((p) => <option key={p.id} value={p.name} />)}</datalist>
      </label>
      <div className={s.formGrid}>
        <label className="fld">Amount ₹<input className="num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 25000" required /></label>
        <label className="fld">Date<input type="date" value={paidOn} max={today()} onChange={(e) => setPaidOn(e.target.value)} /></label>
        <label className="fld">Mode
          <select value={mode} onChange={(e) => setMode(e.target.value as Payment['mode'])}>
            <option value="bank">Bank (NEFT/RTGS)</option><option value="upi">UPI</option><option value="cheque">Cheque</option><option value="cash">Cash</option><option value="other">Other</option>
          </select>
        </label>
        <label className="fld">Reference<input value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} placeholder="UTR / cheque no." /></label>
      </div>
      <span className="muted small">Settles the oldest bills first.</span>
      {err && <span className="small" style={{ color: 'var(--bad)' }}>{err}</span>}
      <div className="row-8"><button className="btn primary" type="submit" disabled={busy || !party.trim() || !amount.trim()}>{busy ? 'Saving…' : 'Save payment'}</button></div>
    </form>
  );
}

function Payments({ ctx, refreshKey, onSaved }: { ctx: Ctx; refreshKey: string; onSaved: () => void }) {
  const list = useApi<{ payments: PaymentRow[] }>(`/api/payments?limit=100&${who(ctx.role, actorId(ctx.role))}`, refreshKey);
  const MODE: Record<Payment['mode'], string> = { bank: 'Bank', upi: 'UPI', cheque: 'Cheque', cash: 'Cash', other: 'Other' };
  return (
    <div className="grid-split">
      <section className="card flush">
        <div className="card-head pad-x"><h2>Recent payments</h2><span className="muted small">latest 100</span></div>
        <table className="tbl rtbl">
          <thead><tr><th>Date</th><th>Party</th><th className="r">Amount</th><th className="d">Mode</th><th className="d">Reference</th><th className="d">Bill</th></tr></thead>
          <tbody>
            {list.data?.payments.map((p) => (
              <tr key={p.id}>
                <td data-label="Date" className="num t2">{shortDate(p.paid_on)}</td>
                <td data-label="Party" className="strong">{p.party_name}</td>
                <td data-label="Amount" className="r num strong">{inr(p.amount)}</td>
                <td data-label="Mode" className="d"><Pill>{MODE[p.mode]}</Pill></td>
                <td data-label="Reference" className="t2 d">{p.reference ?? '—'}</td>
                <td data-label="Bill" className="num t2 d">{p.invoice_no ?? 'Oldest first'}</td>
              </tr>
            ))}
            {list.data && !list.data.payments.length && <tr><td colSpan={6} className="muted center">No payments yet</td></tr>}
            {!list.data && <tr><td colSpan={6} className="muted center">{list.error ?? 'Loading…'}</td></tr>}
          </tbody>
        </table>
      </section>
      <section className="card pad stack-16">
        <h2 className="h2">Record payment</h2>
        <PaymentForm ctx={ctx} initialParty="" onSaved={onSaved} />
      </section>
    </div>
  );
}

// ---------- Margin ----------
const hint = (missing: string[]) => {
  const words = missing.map((m) => (m.startsWith('process cost: ') ? `${m.slice(14)} cost` : m));
  return `Add ${[...new Set(words)].slice(0, 3).join(', ')}${words.length > 3 ? '…' : ''}`;
};

function Margin({ ctx, refreshKey }: { ctx: Ctx; refreshKey: string }) {
  const [by, setBy] = useState<MarginBy>('party');
  const [days, setDays] = useState<'30' | '90' | '365'>('30');
  const { data, error } = useApi<{ rows: MarginRow[]; totals: Omit<MarginRow, 'key' | 'label' | 'party_id'> }>(`/api/margin?by=${by}&days=${days}&${who(ctx.role, actorId(ctx.role))}`, refreshKey);
  const t = data?.totals;
  const label = ({ party: 'Party', quality: 'Quality', order: 'Order', lot: 'Lot' } as const)[by];
  return (
    <>
      <div className="toolbar">
        <Segmented label="Margin by" value={by} onChange={setBy} className="fit" options={[{ value: 'party', label: 'Party' }, { value: 'quality', label: 'Quality' }, { value: 'order', label: 'Order' }, { value: 'lot', label: 'Lot' }]} />
        <Segmented label="Period" value={days} onChange={setDays} className="fit" options={[{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '365', label: '1 year' }]} />
      </div>
      {error && <Empty title="Could not load" text={error} />}
      {t && (
        <div className="grid-kpi">
          <Kpi label="Sales" value={inr(t.revenue)} sub={`${fmt(t.meters)} m dispatched`} lock />
          <Kpi label="Cost" value={inr(t.cost)} sub={t.complete ? 'All costs known' : 'Some costs missing'} subTone={t.complete ? 'good' : 'warn'} lock />
          <Kpi label="Margin" value={rs(t.margin)} sub={t.margin_pct == null ? '—' : `${t.margin_pct}% of sales`} subTone={t.margin_pct != null && t.margin_pct < 3 ? 'bad' : 'good'} lock />
          <Kpi label="Not priced" value={`${fmt(t.unpriced_m)} m`} sub={t.unpriced_m ? 'No selling rate — left out of ₹' : 'Every dispatch priced'} subTone={t.unpriced_m ? 'warn' : 'good'} />
        </div>
      )}
      {data && (
        <section className="card flush">
          <table className="tbl rtbl">
            <thead><tr><th>{label}</th><th className="r d">Meters</th><th className="r">Sales</th><th className="r d">Cost</th><th className="r">Margin</th><th className="r">Margin %</th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.key}>
                  <td data-label={label}><div className="stack-0"><span className="strong">{r.label}</span>{!r.complete && <span className={s.miss}>{hint(r.missing)}</span>}</div></td>
                  <td data-label="Meters" className="r num t2 d">{fmt(r.meters)}</td>
                  <td data-label="Sales" className="r num">{inr(r.revenue)}</td>
                  <td data-label="Cost" className="r num t2 d">{inr(r.cost)}</td>
                  <td data-label="Margin" className="r num strong">{rs(r.margin)}</td>
                  <td data-label="Margin %" className="r">{r.margin_pct == null ? <span className="muted">—</span> : <Pill tone={r.margin_pct < 3 ? 'bad' : r.complete ? 'good' : 'neutral'}><span className="num">{r.margin_pct}%</span></Pill>}</td>
                </tr>
              ))}
              {!data.rows.length && <tr><td colSpan={6} className="muted center">No dispatches in this period</td></tr>}
            </tbody>
          </table>
        </section>
      )}
      <span className="muted small">Cost = purchase rate + process costs + shortage loss. Rows marked in amber are missing a cost or rate, so their margin looks higher than it is.</span>
    </>
  );
}
