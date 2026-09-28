'use client';

// Owner home: what is happening right now, and stock flow over any period (with demand by quality).
import React, { useEffect, useMemo, useState } from 'react';
import Icon from '../Icon';
import { Pill, Segmented, fmt, time } from '../ui';
import type { Ctx } from '../ctx';
import { CAPTURE_LABEL } from '@/lib/derive';

// "Today" comes from the server (database date) so it matches every other today-figure in the app.
const localToday = (ts: string | null | undefined) => !!ts && new Date(ts).toDateString() === new Date().toDateString();

type LiveTab = 'floor' | 'out' | 'in' | 'feed';

interface FeedItem { ts: string; tone: 'info' | 'warn' | 'good' | 'neutral'; icon: string; text: string; sub: string }

export function LiveNow({ ctx }: { ctx: Ctx }) {
  const { d, go } = ctx;
  const [tab, setTab] = useState<LiveTab>('floor');

  const floor = useMemo(() => d.jobCards.filter((j) => j.status !== 'closed').sort((a, b) => a.process.localeCompare(b.process) || a.ts_created.localeCompare(b.ts_created)), [d.jobCards]);
  const byProcess = useMemo(() => {
    const m = new Map<string, { cards: number; meters: number }>();
    floor.forEach((j) => { const x = m.get(j.process) ?? { cards: 0, meters: 0 }; x.cards++; x.meters += j.meters_in; m.set(j.process, x); });
    return Array.from(m.entries());
  }, [floor]);
  const outToday = useMemo(() => d.ledger.filter((l) => l.direction === 'OUT' && l.is_today), [d.ledger]);
  const inToday = useMemo(() => d.ledger.filter((l) => l.direction === 'IN' && l.is_today), [d.ledger]);
  const closedToday = useMemo(() => d.jobCards.filter((j) => j.status === 'closed' && j.closed_today), [d.jobCards]);
  const sum = (xs: { meters: number }[]) => xs.reduce((s, x) => s + x.meters, 0);

  const feed = useMemo(() => {
    const items: FeedItem[] = [
      ...outToday.map((l) => ({ ts: l.ts, tone: 'warn' as const, icon: 'arrow', text: `${fmt(l.meters, 1)} m dispatched to ${l.party ?? '—'}`, sub: `${l.lot_id}${l.quality ? ` · ${l.quality}` : ''}${l.source_doc_id ? ` · ${l.source_doc_id}` : ''}` })),
      ...inToday.map((l) => ({ ts: l.ts, tone: 'info' as const, icon: 'box', text: `${fmt(l.meters, 1)} m received${l.mill_name ? ` from ${l.mill_name}` : ''}`, sub: `${l.lot_id}${l.quality ? ` · ${l.quality}` : ''}${l.source_doc_id ? ` · ${l.source_doc_id}` : ''}` })),
      ...closedToday.map((j) => ({ ts: j.ts_closed!, tone: 'good' as const, icon: 'check', text: `JC-${j.id} ${j.process.toLowerCase()} done · ${fmt(j.meters_out, 1)} m`, sub: `${j.lot_id} · ${j.worker_name}${j.shortage_pct > 0 ? ` · ${j.shortage_pct.toFixed(1)}% short` : ''}` })),
      ...d.jobCards.filter((j) => j.created_today).map((j) => ({ ts: j.ts_created, tone: 'neutral' as const, icon: 'card', text: `JC-${j.id} started · ${j.process}`, sub: `${j.lot_id} · ${j.worker_name} · ${fmt(j.meters_in, 1)} m` })),
      ...d.captures.filter((c) => c.is_today).map((c) => ({ ts: c.ts, tone: c.status === 'pending' ? ('warn' as const) : ('neutral' as const), icon: 'camera', text: `${CAPTURE_LABEL[c.type]} photo ${c.status === 'pending' ? 'waiting for review' : c.status}`, sub: String((c.ai_json as Record<string, unknown> | null)?.lot_id ?? '') })),
    ];
    return items.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 12);
  }, [outToday, inToday, closedToday, d.jobCards, d.captures]);

  return (
    <section className="card pad stack-14 live">
      <div className="card-head">
        <span className="live-dot" aria-hidden="true" />
        <h2>Right now</h2>
        <div className="grow" />
        <span className="muted small">updated {d.lastSync ? time(d.lastSync.toISOString()) : '—'}</span>
        <button className="ib sm-ib" aria-label="Refresh" onClick={() => d.refresh()}><Icon name="refresh" size={15} /></button>
      </div>
      <div className="live-stats">
        <button className={`live-stat ${tab === 'floor' ? 'on' : ''}`} onClick={() => setTab('floor')}><span className="muted small">On the floor</span><span className="num strong">{fmt(sum(floor.map((j) => ({ meters: j.meters_in }))))} m</span><span className="muted tiny">{floor.length} card{floor.length === 1 ? '' : 's'}</span></button>
        <button className={`live-stat ${tab === 'out' ? 'on' : ''}`} onClick={() => setTab('out')}><span className="muted small">Dispatched today</span><span className="num strong">{fmt(sum(outToday))} m</span><span className="muted tiny">{outToday.length} challan{outToday.length === 1 ? '' : 's'}</span></button>
        <button className={`live-stat ${tab === 'in' ? 'on' : ''}`} onClick={() => setTab('in')}><span className="muted small">Received today</span><span className="num strong">{fmt(sum(inToday))} m</span><span className="muted tiny">{inToday.length} challan{inToday.length === 1 ? '' : 's'}</span></button>
        <button className={`live-stat ${tab === 'feed' ? 'on' : ''}`} onClick={() => setTab('feed')}><span className="muted small">Activity today</span><span className="num strong">{feed.length}</span><span className="muted tiny">events</span></button>
      </div>

      {tab === 'floor' && (
        <div className="stack-10">
          {byProcess.length > 0 && <div className="chips">{byProcess.map(([p, x]) => <Pill key={p} tone="info">{p} · {x.cards} · <span className="num">{fmt(x.meters)} m</span></Pill>)}</div>}
          <div className="live-list">
            {floor.slice(0, 8).map((j) => (
              <div key={j.id} className="live-row">
                <div className="grow min0 stack-2"><span className="strong ellipsis">{j.lot_id} · {j.quality}</span><span className="muted small ellipsis">{j.process} · {j.worker_name} · since {localToday(j.ts_created) ? time(j.ts_created) : new Date(j.ts_created).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span></div>
                <span className="num strong">{fmt(j.meters_in)} m</span>
              </div>
            ))}
            {!floor.length && <span className="muted small">Nothing is being worked on right now.</span>}
            {floor.length > 8 && <button className="linkbtn small left" onClick={() => go('jobs')}>All {floor.length} open cards</button>}
          </div>
        </div>
      )}
      {(tab === 'out' || tab === 'in') && (
        <div className="live-list">
          {(tab === 'out' ? outToday : inToday).map((l) => (
            <div key={l.id} className="live-row">
              <div className="grow min0 stack-2"><span className="strong ellipsis">{tab === 'out' ? l.party : l.mill_name ?? '—'}</span><span className="muted small ellipsis">{l.lot_id}{l.quality ? ` · ${l.quality}` : ''}{l.source_doc_id ? ` · ${l.source_doc_id}` : ''} · {time(l.ts)}</span></div>
              <span className="num strong">{fmt(l.meters, 1)} m</span>
            </div>
          ))}
          {!(tab === 'out' ? outToday : inToday).length && <span className="muted small">Nothing {tab === 'out' ? 'dispatched' : 'received'} yet today.</span>}
        </div>
      )}
      {tab === 'feed' && (
        <ol className="timeline">
          {feed.map((f, i) => (
            <li key={i}>
              <span className={`tl-dot ${f.tone}`} />
              <div className="stack-2"><span className="strong">{f.text}</span>{f.sub && <span className="muted small">{f.sub}</span>}<span className="muted tiny">{time(f.ts)}</span></div>
            </li>
          ))}
          {!feed.length && <span className="muted small">No activity yet today.</span>}
        </ol>
      )}
    </section>
  );
}

// ---------------- Stock flow with ranges + demand by quality ----------------
type Range = 'day' | 'week' | 'month' | 'year' | 'all';
interface FlowData {
  unit: 'hour' | 'day' | 'month' | 'year';
  buckets: { key: string; in_m: number; out_m: number }[];
  qualities: { quality: string; in_m: number; out_m: number; lots: number; parties: number }[];
  allQualities: string[];
}

function bucketLabel(key: string, unit: FlowData['unit'], i: number, n: number): string {
  const d = new Date(key);
  if (unit === 'hour') return i % 3 === 0 ? `${d.getHours()}h` : '';
  if (unit === 'day') {
    if (n <= 7) return d.toLocaleDateString('en-IN', { weekday: 'short' });
    return i % 5 === 0 || i === n - 1 ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';
  }
  if (unit === 'month') return d.toLocaleDateString('en-IN', { month: 'short' }) + (d.getMonth() === 0 || i === 0 ? ` ’${String(d.getFullYear()).slice(2)}` : '');
  return String(d.getFullYear());
}
function bucketTitle(key: string, unit: FlowData['unit']): string {
  const d = new Date(key);
  if (unit === 'hour') return `${d.getHours()}:00–${d.getHours() + 1}:00`;
  if (unit === 'day') return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  if (unit === 'month') return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  return String(d.getFullYear());
}
const RANGE_TEXT: Record<Range, string> = { day: 'today', week: 'last 7 days', month: 'last 30 days', year: 'last 12 months', all: 'all years' };

export function StockFlow({ ctx }: { ctx: Ctx }) {
  const [range, setRange] = useState<Range>('week');
  const [quality, setQuality] = useState('');
  const [data, setData] = useState<FlowData | null>(null);
  const [err, setErr] = useState(false);
  const sync = ctx.d.lastSync;

  useEffect(() => {
    let alive = true;
    fetch(`/api/stock/flow?range=${range}${quality ? `&quality=${encodeURIComponent(quality)}` : ''}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((x: FlowData) => { if (alive) { setData(x); setErr(false); } })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [range, quality, sync]);

  const buckets = data?.buckets ?? [];
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.in_m, b.out_m)));
  const totIn = buckets.reduce((s, b) => s + b.in_m, 0);
  const totOut = buckets.reduce((s, b) => s + b.out_m, 0);
  const qs = data?.qualities ?? [];
  const qMax = Math.max(1, ...qs.map((q) => Math.max(q.in_m, q.out_m)));
  const dense = buckets.length > 14;

  return (
    <section className="card pad stack-16 flow d">
      <div className="flow-head">
        <div className="stack-2 grow min0">
          <h2 className="h2">Stock flow</h2>
          <span className="muted small">{RANGE_TEXT[range]}{quality ? ` · ${quality}` : ''} · <span className="num">+{fmt(totIn)} m</span> in · <span className="num">−{fmt(totOut)} m</span> out</span>
        </div>
        <Segmented label="Period" value={range} onChange={setRange} options={[{ value: 'day', label: 'Today' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'year', label: 'Year' }, { value: 'all', label: 'All' }]} />
        <select className="input sel" aria-label="Quality" value={quality} onChange={(e) => setQuality(e.target.value)}>
          <option value="">All qualities</option>
          {(data?.allQualities ?? []).map((q) => <option key={q} value={q}>{q}</option>)}
        </select>
      </div>
      {err && <span className="muted small">Could not load the chart.</span>}
      <div className="flow-body">
        <div className="stack-10 min0">
          <div className="row-8">
            <span className="legend"><i style={{ background: 'var(--accent)' }} />In</span>
            <span className="legend"><i style={{ background: 'var(--warn)' }} />Out</span>
          </div>
          <div className={`chart ${dense ? 'dense' : ''}`}>
            {buckets.map((b, i) => (
              <div className="chart-col" key={b.key} title={`${bucketTitle(b.key, data!.unit)}: in ${fmt(b.in_m)} m, out ${fmt(b.out_m)} m`}>
                <div className="chart-bars">
                  <div className="chart-bar" style={{ height: `${(b.in_m / max) * 100}%`, background: 'var(--accent)' }} />
                  <div className="chart-bar" style={{ height: `${(b.out_m / max) * 100}%`, background: 'var(--warn)' }} />
                </div>
                <span className="chart-label">{bucketLabel(b.key, data!.unit, i, buckets.length)}</span>
              </div>
            ))}
            {!buckets.length && !err && <span className="muted">Loading…</span>}
          </div>
        </div>
        <div className="stack-10 min0">
          <div className="card-head"><h3 className="h3">Demand by quality</h3><span className="muted tiny">sorted by dispatched</span></div>
          <div className="qlist">
            {qs.slice(0, 8).map((q) => (
              <button key={q.quality} className={`qrow ${quality === q.quality ? 'on' : ''}`} onClick={() => setQuality(quality === q.quality ? '' : q.quality)} title="Show only this quality in the chart">
                <div className="qrow-top"><span className="strong ellipsis grow">{q.quality}</span><span className="num small">{q.out_m > 0 ? `−${fmt(q.out_m)} m` : '0 m'}</span></div>
                <div className="qbar"><i style={{ width: `${(q.out_m / qMax) * 100}%`, background: 'var(--warn)' }} /></div>
                <div className="qbar"><i style={{ width: `${(q.in_m / qMax) * 100}%`, background: 'var(--accent)' }} /></div>
                <span className="muted tiny">+{fmt(q.in_m)} m in · {q.lots} lot{q.lots === 1 ? '' : 's'} · {q.parties} part{q.parties === 1 ? 'y' : 'ies'}</span>
              </button>
            ))}
            {!qs.length && <span className="muted small">No movements in this period.</span>}
          </div>
        </div>
      </div>
    </section>
  );
}
