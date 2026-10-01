'use client';

// Owner home building blocks: "Right now" (today's floor and movements) and "Stock flow" (in vs out over a
// period, with demand by quality). Used by the owner's Overview.
import React, { useEffect, useMemo, useState } from 'react';
import Icon from '../Icon';
import { Segmented, fmt, time } from '../ui';
import type { Ctx } from '../ctx';
import { CAPTURE_LABEL } from '@/lib/derive';
import type { LedgerRow } from '@/lib/useLedger';

// "Today" comes from the server (database date) so it matches every other today-figure in the app.
const localToday = (ts: string | null | undefined) => !!ts && new Date(ts).toDateString() === new Date().toDateString();

/** Meters in few characters: 33.6 L m, 4,520 m, 12.5 m (L = lakh, Cr = crore). */
export function fmtMeters(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e7) return `${fmt(n / 1e7, 2)} Cr m`;
  if (a >= 1e5) return `${fmt(n / 1e5, 1)} L m`;
  return `${fmt(n, a >= 1000 ? 0 : 1)} m`;
}

type LiveTab = 'floor' | 'out' | 'in' | 'feed';

interface FeedItem { ts: string; tone: 'info' | 'warn' | 'good' | 'neutral'; text: string; sub: string }

export function LiveNow({ ctx, rows = 6 }: { ctx: Ctx; rows?: number }) {
  const { d, go } = ctx;
  const [tab, setTab] = useState<LiveTab>('floor');

  const floor = useMemo(() => d.jobCards.filter((j) => j.status !== 'closed').sort((a, b) => a.process.localeCompare(b.process) || a.ts_created.localeCompare(b.ts_created)), [d.jobCards]);
  const byProcess = useMemo(() => {
    const m = new Map<string, { cards: number; meters: number }>();
    floor.forEach((j) => { const x = m.get(j.process) ?? { cards: 0, meters: 0 }; x.cards++; x.meters += j.meters_in; m.set(j.process, x); });
    return Array.from(m.entries());
  }, [floor]);
  const floorM = floor.reduce((s, j) => s + j.meters_in, 0);
  const outToday = useMemo(() => d.ledger.filter((l) => l.direction === 'OUT' && l.is_today), [d.ledger]);
  const inToday = useMemo(() => d.ledger.filter((l) => l.direction === 'IN' && l.is_today), [d.ledger]);
  const sum = (xs: { meters: number }[]) => xs.reduce((s, x) => s + x.meters, 0);
  // Totals over ALL of today's movements come from the server (d.today); d.ledger holds only the latest rows.
  const tIn = d.today ? { m: d.today.in_m, n: d.today.in_count } : { m: sum(inToday), n: inToday.length };
  const tOut = d.today ? { m: d.today.out_m, n: d.today.out_count } : { m: sum(outToday), n: outToday.length };
  const [todayRows, setTodayRows] = useState<{ dir: 'IN' | 'OUT'; rows: LedgerRow[]; more: boolean } | null>(null);
  useEffect(() => {
    if (tab !== 'out' && tab !== 'in') return;
    const dir = tab === 'out' ? 'OUT' : 'IN';
    let live = true;
    fetch(`/api/stock/ledger?today=1&direction=${dir}&limit=50`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setTodayRows({ dir, rows: j.rows ?? [], more: !!j.next }); })
      .catch(() => {});
    return () => { live = false; };
  }, [tab, d.today]);
  const wantDir = tab === 'out' ? 'OUT' : 'IN';
  const moveRows: { id: number; lot_id: string; meters: number; party: string | null; mill_name: string | null; quality?: string | null; source_doc_id: string | null; ts: string }[] =
    todayRows && todayRows.dir === wantDir ? todayRows.rows : (tab === 'out' ? outToday : inToday);
  const closedToday = useMemo(() => d.jobCards.filter((j) => j.status === 'closed' && j.closed_today), [d.jobCards]);

  const feed = useMemo(() => {
    const items: FeedItem[] = [
      ...outToday.map((l) => ({ ts: l.ts, tone: 'warn' as const, text: `${fmt(l.meters, 1)} m sent to ${l.party ?? '—'}`, sub: `${l.lot_id}${l.quality ? ` · ${l.quality}` : ''}${l.source_doc_id ? ` · ${l.source_doc_id}` : ''}` })),
      ...inToday.map((l) => ({ ts: l.ts, tone: 'info' as const, text: `${fmt(l.meters, 1)} m received${l.mill_name ? ` from ${l.mill_name}` : ''}`, sub: `${l.lot_id}${l.quality ? ` · ${l.quality}` : ''}${l.source_doc_id ? ` · ${l.source_doc_id}` : ''}` })),
      ...closedToday.map((j) => ({ ts: j.ts_closed!, tone: 'good' as const, text: `JC-${j.id} ${j.process.toLowerCase()} done · ${fmt(j.meters_out, 1)} m`, sub: `${j.lot_id} · ${j.worker_name}${j.shortage_pct > 0 ? ` · ${j.shortage_pct.toFixed(1)}% short` : ''}` })),
      ...d.jobCards.filter((j) => j.created_today).map((j) => ({ ts: j.ts_created, tone: 'neutral' as const, text: `JC-${j.id} started · ${j.process}`, sub: `${j.lot_id} · ${j.worker_name} · ${fmt(j.meters_in, 1)} m` })),
      ...d.captures.filter((c) => c.is_today).map((c) => ({ ts: c.ts, tone: c.status === 'pending' ? ('warn' as const) : ('neutral' as const), text: `${CAPTURE_LABEL[c.type]} photo ${c.status === 'pending' ? 'waiting for review' : c.status}`, sub: String((c.ai_json as Record<string, unknown> | null)?.lot_id ?? '') })),
    ];
    return items.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 12);
  }, [outToday, inToday, closedToday, d.jobCards, d.captures]);

  const count = (n: number) => <span className="ov-count num">{n}</span>;
  const summary =
    tab === 'floor' ? (floor.length ? `${fmtMeters(floorM)} on ${floor.length} open card${floor.length === 1 ? '' : 's'}${byProcess.length ? ` · ${byProcess.map(([p, x]) => `${p} ${x.cards}`).join(' · ')}` : ''}` : '')
      : tab === 'out' ? (tOut.n ? `${fmtMeters(tOut.m)} sent out on ${tOut.n} challan${tOut.n === 1 ? '' : 's'} today` : '')
        : tab === 'in' ? (tIn.n ? `${fmtMeters(tIn.m)} received on ${tIn.n} challan${tIn.n === 1 ? '' : 's'} today` : '')
          : '';

  return (
    <section className="card pad stack-14 ov-now">
      <div className="card-head">
        <span className="live-dot" aria-hidden="true" />
        <h2>Right now</h2>
        <span className="muted small">updated {d.lastSync ? time(d.lastSync.toISOString()) : '—'}</span>
      </div>
      <Segmented label="Show" value={tab} onChange={setTab} className="ov-tabs" options={[
        { value: 'floor', label: <>On floor{count(floor.length)}</> },
        { value: 'out', label: <>Sent out{count(tOut.n)}</> },
        { value: 'in', label: <>Received{count(tIn.n)}</> },
        { value: 'feed', label: <>Activity{count(feed.length)}</> },
      ]} />
      {summary && <p className="muted small ov-now-sum">{summary}</p>}

      {tab === 'floor' && (
        <div className="live-list">
          {floor.slice(0, rows).map((j) => (
            <div key={j.id} className="live-row">
              <div className="grow min0 stack-2"><span className="strong ellipsis">{j.lot_id} · {j.quality}</span><span className="muted small ellipsis">{j.process} · {j.worker_name} · since {localToday(j.ts_created) ? time(j.ts_created) : new Date(j.ts_created).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span></div>
              <span className="num">{fmt(j.meters_in)} m</span>
            </div>
          ))}
          {!floor.length && <Calm text="Nothing on the floor right now." />}
          {floor.length > rows && <button className="linkbtn small left ov-more" onClick={() => go('jobs')}>See all {floor.length} open cards</button>}
        </div>
      )}
      {(tab === 'out' || tab === 'in') && (
        <div className="live-list">
          {moveRows.slice(0, rows).map((l) => (
            <div key={l.id} className="live-row">
              <div className="grow min0 stack-2"><span className="strong ellipsis">{tab === 'out' ? l.party ?? '—' : l.mill_name ?? '—'}</span><span className="muted small ellipsis">{l.lot_id}{l.quality ? ` · ${l.quality}` : ''}{l.source_doc_id ? ` · ${l.source_doc_id}` : ''} · {time(l.ts)}</span></div>
              <span className="num">{fmt(l.meters, 1)} m</span>
            </div>
          ))}
          {!moveRows.length && <Calm text={tab === 'out' ? 'Nothing sent out yet today.' : 'Nothing received yet today.'} />}
          {(tab === 'out' ? tOut.n : tIn.n) > Math.min(rows, moveRows.length) && moveRows.length > 0 && (
            <button className="linkbtn small left ov-more" onClick={() => go('stock')}>See all {tab === 'out' ? tOut.n : tIn.n} in the stock ledger</button>
          )}
        </div>
      )}
      {tab === 'feed' && (
        feed.length ? (
          <ol className="timeline">
            {feed.slice(0, rows + 2).map((f, i) => (
              <li key={i}>
                <span className={`tl-dot ${f.tone}`} />
                <div className="stack-2 min0"><span className="strong">{f.text}</span>{f.sub && <span className="muted small">{f.sub}</span>}<span className="muted tiny">{time(f.ts)}</span></div>
              </li>
            ))}
          </ol>
        ) : <Calm text="No activity yet today." />
      )}
    </section>
  );
}

/** Quiet empty state: a check mark and one short line. */
export function Calm({ text }: { text: string }) {
  return <p className="ov-calm"><Icon name="check" size={15} strokeWidth={2} />{text}</p>;
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
  if (unit === 'hour') return i % 6 === 0 ? `${d.getHours()}h` : '';
  if (unit === 'day') {
    if (n <= 7) return d.toLocaleDateString('en-IN', { weekday: 'short' });
    return i % 7 === 0 || i === n - 1 ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';
  }
  if (unit === 'month') return n > 12 && i % 3 !== 0 ? '' : d.toLocaleDateString('en-IN', { month: 'short' }) + (d.getMonth() === 0 || i === 0 ? ` ’${String(d.getFullYear()).slice(2)}` : '');
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

/**
 * Top of the chart's scale. When one or two bars dwarf the rest (10× or more, e.g. a bulk opening-stock import), the
 * scale stops at the next-largest bar and the giants are drawn cut (with a break mark and their value),
 * so every other day stays readable.
 */
function chartScale(values: number[]): { top: number; cut: boolean } {
  const v = values.filter((x) => x > 0).sort((a, b) => b - a);
  if (!v.length) return { top: 1, cut: false };
  for (let k = 0; k < Math.min(2, v.length - 1); k++) {
    if (v[k] > 10 * v[k + 1]) return { top: niceTop(v[k + 1] * 1.15), cut: true };
  }
  return { top: niceTop(v[0]), cut: false };
}
/** Round a scale top up to 1, 2, 2.5 or 5 × a power of ten so the axis label reads cleanly. */
function niceTop(x: number): number {
  if (x <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 2.5, 5, 10]) if (x <= m * p) return m * p;
  return 10 * p;
}

export function StockFlow({ ctx, showDemand = true }: { ctx: Ctx; showDemand?: boolean }) {
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
  const { top, cut } = chartScale(buckets.flatMap((b) => [b.in_m, b.out_m]));
  const totIn = buckets.reduce((s, b) => s + b.in_m, 0);
  const totOut = buckets.reduce((s, b) => s + b.out_m, 0);
  const qs = data?.qualities ?? [];
  const qMax = Math.max(1, ...qs.map((q) => q.out_m));
  const n = buckets.length;
  const empty = !!data && totIn === 0 && totOut === 0;
  const h = (v: number) => (v <= 0 ? '0' : `max(3px, ${Math.min(100, (v / top) * 100)}%)`);

  return (
    <section className="card pad stack-16 flow">
      <div className="flow-head">
        <div className="stack-2 grow min0">
          <h2 className="h2">Stock flow</h2>
          <span className="muted small">Fabric received and sent out · {RANGE_TEXT[range]}{quality ? ` · ${quality}` : ''}</span>
        </div>
        <Segmented label="Period" value={range} onChange={setRange} options={[{ value: 'day', label: 'Today' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'year', label: 'Year' }, { value: 'all', label: 'All' }]} />
        <select className="input sel" aria-label="Quality" value={quality} onChange={(e) => setQuality(e.target.value)}>
          <option value="">All qualities</option>
          {(data?.allQualities ?? []).map((q) => <option key={q} value={q}>{q}</option>)}
        </select>
      </div>

      <div className={`flow-body ${showDemand ? '' : 'solo'}`}>
        <div className="stack-12 min0">
          <div className="fl-legend">
            <span className="fl-key"><i className="fl-in" />Received <b className="num">{fmtMeters(totIn)}</b></span>
            <span className="fl-key"><i className="fl-out" />Sent out <b className="num">{fmtMeters(totOut)}</b></span>
          </div>
          {err && <p className="muted small">Could not load the chart. Pull to refresh or try again in a moment.</p>}
          {!err && !data && <div className="fl-chart fl-skel" aria-hidden="true" />}
          {!err && data && (
            <div className="fl-chart" role="group" aria-label={`Stock flow, ${RANGE_TEXT[range]}: ${fmtMeters(totIn)} received, ${fmtMeters(totOut)} sent out`}>
              <div className="fl-axis" aria-hidden="true"><span className="num">{fmtMeters(top)}</span><span className="num">{fmtMeters(top / 2)}</span><span className="num">0</span></div>
              <div className="fl-plot">
                <div className="fl-grid" aria-hidden="true"><i /><i /><i /></div>
                <div className={`fl-cols ${n > 14 ? 'dense' : ''}`}>
                  {buckets.map((b, i) => {
                    const edge = i < n * 0.25 ? 'l' : i >= n * 0.75 ? 'r' : '';
                    return (
                      <div className="fl-col" key={b.key} tabIndex={0} aria-label={`${bucketTitle(b.key, data.unit)}: ${fmt(b.in_m, 1)} m received, ${fmt(b.out_m, 1)} m sent out`}>
                        <div className="fl-bars">
                          <div className={`fl-bar fl-in ${b.in_m > top ? 'cut' : ''}`} style={{ height: h(b.in_m) }}>{b.in_m > top && <span className="fl-cutv num">{fmtMeters(b.in_m)}</span>}</div>
                          <div className={`fl-bar fl-out ${b.out_m > top ? 'cut' : ''}`} style={{ height: h(b.out_m) }}>{b.out_m > top && <span className="fl-cutv num">{fmtMeters(b.out_m)}</span>}</div>
                        </div>
                        <span className="fl-x">{bucketLabel(b.key, data.unit, i, n)}</span>
                        <div className={`fl-tip ${edge}`} role="presentation">
                          <span className="strong">{bucketTitle(b.key, data.unit)}</span>
                          <span><i className="fl-in" />Received <b className="num">{fmt(b.in_m, 1)} m</b></span>
                          <span><i className="fl-out" />Sent out <b className="num">{fmt(b.out_m, 1)} m</b></span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          {cut && !err && <p className="muted tiny fl-note">A very large day is drawn cut short (its total is written on it) so the other days stay readable.</p>}
          {empty && <p className="muted small">No fabric moved {RANGE_TEXT[range] === 'today' ? 'today' : `in the ${RANGE_TEXT[range]}`}.</p>}
        </div>

        {showDemand && (
          <div className="stack-10 min0">
            <div className="stack-2"><h3 className="h3">Demand by quality</h3><span className="muted tiny">most sent out first · tap one to see it in the chart</span></div>
            <div className="qlist">
              {qs.slice(0, 6).map((q) => (
                <button key={q.quality} className={`qrow ${quality === q.quality ? 'on' : ''}`} aria-pressed={quality === q.quality} onClick={() => setQuality(quality === q.quality ? '' : q.quality)}>
                  <div className="qrow-top"><span className="strong ellipsis grow">{q.quality}</span><span className="num small">{fmtMeters(q.out_m)}</span></div>
                  <div className="qbar"><i className="fl-out" style={{ width: q.out_m > 0 ? `max(3px, ${(q.out_m / qMax) * 100}%)` : '0' }} /></div>
                  <span className="muted tiny">{q.parties} part{q.parties === 1 ? 'y' : 'ies'} · {fmtMeters(q.in_m)} received</span>
                </button>
              ))}
              {data && !qs.length && <Calm text="Nothing moved in this period." />}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
