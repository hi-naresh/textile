'use client';

// Reports tab: day / week / month report (numbers + change vs the previous period + short summary),
// Excel download, and the Inventory picture (days of cover, ageing lots, mill loss).
// ₹ and AI cost come only for the owner (the API strips them for supervisors).
import React, { useEffect, useState } from 'react';
import Icon from '../Icon';
import { Empty, Kpi, LockTag, PageHead, Pill, Segmented, fmt, inr, type Tone } from '../ui';
import type { Ctx } from '../ctx';
import { flashWhenReady, useApi, useHashLink, who } from '@/lib/useApi';
import type { KpiChange, Named, Report } from '@/lib/reports/build';
import type { CoverStatus, InventorySnapshot } from '@/lib/reports/inventory';
import s from './Reports.module.css';

type Period = 'day' | 'week' | 'month';
const PERIOD_WORD: Record<Period, string> = { day: 'Day', week: 'Week', month: 'Month' };

const m = (v: number | null | undefined) => (v == null ? '—' : `${fmt(v)} m`);
const usd = (v: number) => `$${v.toFixed(v > 0 && v < 1 ? 3 : 2)}`;
function valueText(k: Pick<KpiChange, 'unit'>, v: number | null): string {
  if (v == null) return '—';
  switch (k.unit) {
    case 'm': return m(v);
    case '%': return `${fmt(v, 1)}%`;
    case 'inr': return inr(v);
    case 'usd': return usd(v);
    case 'min': return `${fmt(v)} min`;
    default: return fmt(v);
  }
}
function changeSub(k: KpiChange, prevLabel: string): { text: string; tone?: Tone } {
  if (k.changePct == null) return { text: k.prev == null ? `nothing to compare` : `${prevLabel}: ${valueText(k, k.prev)}` };
  const c = k.changePct;
  if (Math.abs(c) < 1) return { text: `same as ${prevLabel}` };
  const up = c > 0;
  const good = up === k.upIsGood;
  const amount = k.unit === '%' ? `${fmt(Math.abs(c), 1)} pts` : `${fmt(Math.abs(c))}%`;
  return { text: `${up ? '▲' : '▼'} ${amount} vs ${prevLabel}`, tone: good ? 'good' : 'bad' };
}
const STATUS: Record<CoverStatus, { tone: Tone; label: string }> = { short: { tone: 'bad', label: 'Short' }, low: { tone: 'warn', label: 'Low' }, ok: { tone: 'good', label: 'OK' } };
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Opening a report from an alert: go('reports') after setting location.hash = '#report=day:2026-09-27'. */
function fromHash(): { period: Period; date: string } | null {
  if (typeof window === 'undefined') return null;
  const x = window.location.hash.match(/report=(day|week|month):(\d{4}-\d{2}-\d{2})/);
  return x ? { period: x[1] as Period, date: x[2] } : null;
}

function Bars({ rows, color, empty, unit = 'm' }: { rows: Named[]; color: string; empty: string; unit?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.meters));
  if (!rows.length) return <span className="muted small">{empty}</span>;
  return (
    <div className="qlist">
      {rows.map((r) => (
        <div key={r.name} className={`qrow ${s.bar}`}>
          <div className="qrow-top"><span className="strong ellipsis grow">{r.name}</span><span className="num small">{fmt(r.meters)} {unit}</span></div>
          <div className="qbar"><i style={{ width: `${(r.meters / max) * 100}%`, background: color }} /></div>
          <span className="muted tiny">{r.count} {r.count === 1 ? 'challan' : 'challans'}</span>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value, total }: { label: React.ReactNode; value: React.ReactNode; total?: boolean }) {
  return <div className={`${s.stat} ${total ? s.total : ''}`}><span className={total ? '' : 'muted'}>{label}</span><span className="num">{value}</span></div>;
}

export function Reports({ ctx }: { ctx: Ctx }) {
  const owner = ctx.role === 'owner';
  const allowed = ctx.role === 'owner' || ctx.role === 'supervisor';
  const [period, setPeriod] = useState<Period>('day');
  const [date, setDate] = useState(''); // '' = today (the server's today)
  const [allQ, setAllQ] = useState(false);

  useEffect(() => {
    const read = () => { const h = fromHash(); if (h) { setPeriod(h.period); setDate(h.date); } };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);

  const qs = `period=${period}${date ? `&date=${date}` : ''}&${who(ctx.role, null)}`;
  const { data: r, error, loading } = useApi<Report>(allowed ? `/api/reports?${qs}` : null, ctx.d.lastSync);
  const { data: inv, error: invErr } = useApi<InventorySnapshot>(allowed ? `/api/inventory?role=${ctx.role}` : null, ctx.d.lastSync);

  if (!allowed) {
    return <div className="page fade"><PageHead title="Reports" /><Empty title="Reports are for the owner and supervisors" /></div>;
  }

  const shown = r && r.period === period ? r : null;
  const kpis = shown?.kpis ?? [];
  const prevWord = shown ? shown.prevLabel : '';
  const nothing = shown && shown.stock.in === 0 && shown.stock.out === 0 && shown.production.cards === 0;

  return (
    <div className="page fade">
      <PageHead title="Reports" sub={shown ? `${shown.label} · ${shown.rangeText}${shown.partial ? ' (so far)' : ''}` : 'Daily, weekly and monthly numbers'}>
        <div className={`row-8 ${s.controls}`} style={{ flexWrap: 'wrap' }}>
          <Segmented label="Period" value={period} onChange={(p) => setPeriod(p)} options={(['day', 'week', 'month'] as Period[]).map((p) => ({ value: p, label: PERIOD_WORD[p] }))} />
          <input
            type="date" className={`input ${s.date}`} aria-label="Date" max={localToday()}
            value={date || shown?.to || ''} onChange={(e) => setDate(e.target.value)}
          />
          {date && <button className="btn sm" onClick={() => setDate('')}>Today</button>}
          <a className="btn" href={`/api/reports/export?${qs}`} download><Icon name="download" size={16} strokeWidth={2} />Excel</a>
        </div>
      </PageHead>

      {error && <div className="alert bad">{error}</div>}
      {!shown && !error && <span className="muted">{loading ? 'Loading…' : 'No report.'}</span>}

      {shown && (
        <>
          <section className="card pad stack-10">
            <div className="card-head"><h2>Summary</h2>{shown.narrativeSource === 'ai' && <Pill tone="info">AI worded</Pill>}</div>
            <ul className={s.narr}>{shown.narrative.map((line, i) => <li key={i}>{line}</li>)}</ul>
            {nothing && <span className="muted small">No stock movement or production in this period.</span>}
          </section>

          <div className="grid-kpi">
            {kpis.map((k) => {
              const sub = changeSub(k, prevWord);
              return <Kpi key={k.key} label={k.label} value={valueText(k, k.value)} sub={sub.text} subTone={sub.tone} lock={k.ownerOnly} />;
            })}
          </div>

          <div className="grid-split">
            <section className="card pad stack-14">
              <div className="card-head"><h2>Dispatch</h2><span className="muted small num">{m(shown.dispatch.total)} · {shown.dispatch.parties} {shown.dispatch.parties === 1 ? 'party' : 'parties'}</span></div>
              <div className={s.cols}>
                <div className="stack-10 min0"><h3 className="h3">By party</h3><Bars rows={shown.dispatch.byParty} color="var(--warn)" empty="Nothing dispatched." /></div>
                <div className="stack-10 min0"><h3 className="h3">By quality</h3><Bars rows={shown.dispatch.byQuality} color="var(--warn)" empty="Nothing dispatched." /></div>
              </div>
            </section>
            <section className="card pad stack-10">
              <div className="card-head"><h2>Stock</h2></div>
              <div>
                <Stat label={`Opening (${shown.from})`} value={m(shown.stock.opening)} />
                <Stat label={`Received · ${shown.stock.inChallans} challans`} value={`+${fmt(shown.stock.in)} m`} />
                <Stat label={`Dispatched · ${shown.stock.outChallans} challans`} value={`−${fmt(shown.stock.out)} m`} />
                <Stat label={`Closing (${shown.to})`} value={m(shown.stock.closing)} total />
              </div>
              {shown.timeSaved.captures > 0 && <span className="muted small">Photo capture saved about {fmt(shown.timeSaved.savedMin)} min on {shown.timeSaved.captures} read{shown.timeSaved.captures === 1 ? '' : 's'}.</span>}
            </section>
          </div>

          <div className="grid-split">
            <section className="card pad stack-14">
              <div className="card-head">
                <h2>Production</h2>
                <span className="muted small num">{m(shown.production.total)} · {shown.production.cards} cards{shown.production.shortagePct != null ? ` · ${fmt(shown.production.shortagePct, 1)}% short` : ''}</span>
              </div>
              {shown.production.cards === 0 && <span className="muted small">No job cards closed in this period.</span>}
              {shown.production.bySection.length > 0 && (
                <table className="tbl rtbl">
                  <thead><tr><th>Section</th><th>Done</th><th>Cards</th><th>Shortage</th><th>Efficiency</th></tr></thead>
                  <tbody>
                    {shown.production.bySection.map((x) => {
                      const eff = shown.efficiency.bySection.find((e) => e.name.toLowerCase() === x.name.toLowerCase())?.pct ?? null;
                      return (
                        <tr key={x.name}>
                          <td data-label="Section" className="strong">{x.name}</td>
                          <td data-label="Done" className="num">{m(x.meters)}</td>
                          <td data-label="Cards" className="num">{x.count}</td>
                          <td data-label="Shortage" className="num">{x.shortagePct == null ? '—' : <Pill tone={x.shortagePct > shown.production.limitPct ? 'bad' : 'good'}>{fmt(x.shortagePct, 1)}%</Pill>}</td>
                          <td data-label="Efficiency" className="num">{eff == null ? '—' : `${fmt(eff, 1)}%`}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {shown.production.flagged.length > 0 && (
                <div className="alert bad">
                  {shown.production.flagged.length} card{shown.production.flagged.length === 1 ? '' : 's'} over the {shown.production.limitPct}% shortage limit:{' '}
                  {shown.production.flagged.slice(0, 5).map((f) => `JC-${f.id} ${f.lot_id} (${f.worker}, ${fmt(f.shortagePct, 1)}%)`).join('; ')}
                </div>
              )}
              {shown.efficiency.pct != null && (
                <span className="muted small">Efficiency {fmt(shown.efficiency.pct, 1)}% (target {shown.efficiency.targetPct}%){shown.efficiency.belowTarget ? ` · ${shown.efficiency.belowTarget} of ${shown.efficiency.workers} workers below` : ''}</span>
              )}
            </section>
            <section className="card pad stack-10 d">
              <div className="card-head"><h2>By worker</h2></div>
              {shown.production.byWorker.length === 0 && <span className="muted small">No work closed.</span>}
              <div>{shown.production.byWorker.map((w) => <Stat key={w.name} label={<>{w.name} <span className="tiny">· {w.section} · {w.count} card{w.count === 1 ? '' : 's'}</span></>} value={m(w.meters)} />)}</div>
            </section>
          </div>

          <div className="grid-split">
            <section className="card pad stack-14 d">
              <div className="card-head"><h2>Receipts by mill</h2><span className="muted small num">{m(shown.receipts.total)}</span></div>
              {shown.receipts.byMill.length === 0 ? <span className="muted small">Nothing received.</span> : (
                <div className="qlist">
                  {shown.receipts.byMill.map((x) => {
                    const max = Math.max(1, ...shown.receipts.byMill.map((y) => y.meters));
                    return (
                      <div key={x.name} className={`qrow ${s.bar}`}>
                        <div className="qrow-top"><span className="strong ellipsis grow">{x.name}</span><span className="num small">{fmt(x.meters)} m</span></div>
                        <div className="qbar"><i style={{ width: `${(x.meters / max) * 100}%`, background: 'var(--accent)' }} /></div>
                        <span className="muted tiny">{x.count} challan{x.count === 1 ? '' : 's'}{x.lossPct != null ? ` · ${fmt(x.lossPct, 1)}% grey→finished loss` : ''}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
            <section className="card pad stack-10">
              <div className="card-head"><h2>Orders &amp; inquiries</h2></div>
              {!shown.orders.hasData && !shown.inquiries.hasData ? <span className="muted small">No orders or inquiries recorded yet.</span> : (
                <div>
                  {shown.orders.hasData && <>
                    <Stat label="New orders" value={`${shown.orders.created} · ${m(shown.orders.createdM)}`} />
                    <Stat label="Sent against orders" value={m(shown.orders.dispatchedM)} />
                    <Stat label="Orders completed" value={shown.orders.completed} />
                    <Stat label="Open now" value={`${shown.orders.open} · ${m(shown.orders.openM)}`} />
                    <Stat label={<span className={shown.orders.overdue ? 'strong' : ''} style={shown.orders.overdue ? { color: 'var(--bad)' } : undefined}>Past promise date</span>} value={`${shown.orders.overdue} · ${m(shown.orders.overdueM)}`} />
                  </>}
                  {shown.inquiries.hasData && <>
                    <Stat label="New inquiries" value={shown.inquiries.created} />
                    <Stat label="Won / lost" value={`${shown.inquiries.won} / ${shown.inquiries.lost}`} />
                  </>}
                </div>
              )}
            </section>
          </div>

          {owner && (shown.money || shown.ai) && (
            <div className="grid-split">
              {shown.money && (
                <section className="card pad stack-10">
                  <div className="card-head"><h2>Money</h2><LockTag /></div>
                  {!shown.money.hasData ? <span className="muted small">No invoices or payments recorded yet.</span> : <>
                    <div>
                      <Stat label={`Invoiced · ${shown.money.invoices}`} value={inr(shown.money.invoiced)} />
                      <Stat label={`Collected · ${shown.money.payments}`} value={inr(shown.money.collected)} />
                      <Stat label={`Outstanding on ${shown.to}`} value={inr(shown.money.outstanding)} total />
                      <Stat label={<span style={shown.money.overdue ? { color: 'var(--bad)' } : undefined}>Overdue</span>} value={inr(shown.money.overdue)} />
                    </div>
                    {shown.money.topOutstanding.length > 0 && <>
                      <h3 className="h3">Who owes most</h3>
                      <div>{shown.money.topOutstanding.map((x) => <Stat key={x.name} label={<>{x.name}{x.overdue > 0 && <span className="tiny" style={{ color: 'var(--bad)' }}> · {inr(x.overdue)} overdue</span>}</>} value={inr(x.amount)} />)}</div>
                    </>}
                  </>}
                </section>
              )}
              {shown.ai && (
                <section className="card pad stack-10 d">
                  <div className="card-head"><h2>AI usage</h2><LockTag /></div>
                  <div>
                    <Stat label={`Calls${shown.ai.failed ? ` · ${shown.ai.failed} failed` : ''}`} value={fmt(shown.ai.calls)} />
                    {shown.ai.byFeature.map((f) => <Stat key={f.feature} label={<span className="tiny">{f.feature} · {f.calls}</span>} value={usd(f.costUsd)} />)}
                    <Stat label="Cost" value={usd(shown.ai.costUsd)} total />
                  </div>
                </section>
              )}
            </div>
          )}
        </>
      )}

      <InventorySection inv={inv} error={invErr} allQ={allQ} setAllQ={setAllQ} />
    </div>
  );
}

function InventorySection({ inv, error, allQ, setAllQ }: { inv: InventorySnapshot | null; error: string | null; allQ: boolean; setAllQ: (v: boolean) => void }) {
  // Deep link from the old-stock alert ("See the N lots"): #inventory=ageing → show every old lot and scroll to them.
  const link = useHashLink('inventory');
  const [allAge, setAllAge] = useState(false);
  useEffect(() => {
    if (link.value !== 'ageing') return;
    setAllAge(true); // eslint-disable-line react-hooks/set-state-in-effect -- responding to a deep link
    const cancel = flashWhenReady('#inv-ageing', 8000);
    // The report above loads separately and can push the list down after the first scroll: re-align if it moved.
    const again = [1200, 2500, 4500].map((ms) => setTimeout(() => {
      const el = document.getElementById('inv-ageing');
      if (el && Math.abs(el.getBoundingClientRect().top) > 160) el.scrollIntoView({ block: 'start' });
    }, ms));
    return () => { cancel(); again.forEach(clearTimeout); };
  }, [link]);
  if (error) return <div className="alert bad">Inventory: {error}</div>;
  if (!inv) return null;
  const rows = allQ ? inv.qualities : inv.qualities.slice(0, 10);
  return (
    <>
      <section className="card flush">
        <div className="card-head pad-x">
          <h2>Inventory</h2>
          {inv.totals.short > 0 && <Pill tone="bad">{inv.totals.short} short</Pill>}
          {inv.totals.low > 0 && <Pill tone="warn">{inv.totals.low} low</Pill>}
          <span className="muted small num">{m(inv.totals.free)} free</span>
        </div>
        {inv.qualities.length === 0 ? <div className="card-head pad-x"><span className="muted small">No stock yet.</span></div> : (
          <table className="tbl rtbl">
            <thead><tr><th>Quality</th><th>Free</th><th>Sells a day</th><th>Days of cover</th><th>Open orders</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.key}>
                  <td data-label="Quality" className="strong">{x.quality}</td>
                  <td data-label="Free" className="num">{m(x.free)}{x.reserved > 0 && <span className="muted tiny"> ({fmt(x.reserved)} reserved)</span>}</td>
                  <td data-label="Sells a day" className="num">{x.avgDaily > 0 ? m(x.avgDaily) : '—'}</td>
                  <td data-label="Days of cover" className="num">{x.daysCover == null ? '—' : `${fmt(x.daysCover)} days`}</td>
                  <td data-label="Open orders" className="num">{x.openOrders ? `${x.openOrders} · ${m(x.openOrderM)}` : '—'}</td>
                  <td data-label="Status"><Pill tone={STATUS[x.status].tone}>{STATUS[x.status].label}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {inv.qualities.length > 10 && (
          <div className="card-head pad-x"><button className="linkbtn small left" onClick={() => setAllQ(!allQ)}>{allQ ? 'Show fewer' : `Show all ${inv.qualities.length} qualities`}</button></div>
        )}
      </section>

      <div className="grid-split">
        <section className="card pad stack-10 d" id="inv-ageing">
          <div className="card-head"><h2>Not moved in {inv.thresholds.ageingDays}+ days</h2><span className="muted small num">{inv.ageing.count} lots · {m(inv.ageing.meters)}</span></div>
          {inv.ageing.count === 0 ? <span className="muted small">Every lot moved recently.</span> : (
            <div>{inv.ageing.lots.slice(0, allAge ? undefined : 8).map((l) => <Stat key={l.lot_id} label={<>{l.lot_id} <span className="tiny">· {l.quality} · {l.location ?? 'no location'} · {l.days} days</span></>} value={m(l.balance)} />)}</div>
          )}
          {inv.ageing.count > 8 && <button className="linkbtn small left" onClick={() => setAllAge(!allAge)}>{allAge ? 'Show fewer' : `Show all ${inv.ageing.count} lots`}</button>}
          {inv.noLocation.count > 0 && <div className="alert warn">{inv.noLocation.count} lot{inv.noLocation.count === 1 ? '' : 's'} with stock but no location: {inv.noLocation.lots.slice(0, 6).map((l) => l.lot_id).join(', ')}{inv.noLocation.count > 6 ? ' …' : ''}</div>}
        </section>
        <section className="card pad stack-10 d">
          <div className="card-head"><h2>Mill loss</h2><span className="muted small">last {inv.millLoss.days} days{inv.millLoss.overallPct != null ? ` · overall ${fmt(inv.millLoss.overallPct, 1)}%` : ''}</span></div>
          {inv.millLoss.mills.length === 0 ? <span className="muted small">No receipts with both grey and finished meters.</span> : (
            <div>
              {inv.millLoss.mills.map((x) => (
                <Stat key={x.mill} label={<>{x.mill} <span className="tiny">· {x.receipts} receipt{x.receipts === 1 ? '' : 's'}</span></>}
                  value={<Pill tone={x.flagged ? 'bad' : x.gap > 2 ? 'warn' : 'good'}>{fmt(x.lossPct, 1)}%</Pill>} />
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
