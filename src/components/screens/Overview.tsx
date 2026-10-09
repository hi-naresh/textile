'use client';

// Owner home (Overview), kept calm on purpose: a greeting, four figures that matter each morning, the few
// things that need the owner, what is happening right now, stock flow and the sections.
// Screen density (Settings): Compact shows shorter lists and hides "Demand by quality"; nothing else disappears.
import React, { useMemo } from 'react';
import Icon from '../Icon';
import { Pill, Track, effTone, fmt, inr, time, type Tone } from '../ui';
import { Calm, LiveNow, StockFlow, fmtMeters } from './Today';
import { CATS, catOfAgent, useAttentionCount, useAttentionItems, type CatKey } from '../AgentInbox';
import type { Ctx } from '../ctx';
import type { Tab } from '@/lib/access';
import { supervisorFor, rules, owner, can } from '@/lib/access';
import { sectionRows } from '@/lib/derive';
import { openLink, useApi } from '@/lib/useApi';

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

/** GET /api/stock → stockSummary (provided by the stock API; null until it is available). */
interface StockSummary { on_hand_m: number; active_lots: number; low_lots: { lot_id: string; quality: string; balance: number }[] }
/** GET /api/overview */
interface OverviewFigures {
  orders: { open: number; open_m: number; late: number; due_today: number; due_week: number };
  money: { outstanding: number; overdue: number; parties_overdue: number } | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

// ---------------- Overview ----------------
export function Overview({ ctx }: { ctx: Ctx }) {
  const { d, days, go, role } = ctx;
  const compact = ctx.density === 'compact';
  const stock = (d as unknown as { stockSummary?: StockSummary | null }).stockSummary ?? null;
  const fig = useApi<OverviewFigures>(can(role, 'orders.view') ? '/api/overview' : null, d.lastSync).data ?? null;
  const sections = sectionRows(days, d.jobCards);
  const running = sections.filter((s) => s.open > 0).length;
  const allot = days.reduce((s, x) => s + x.allotted, 0);
  const done = days.reduce((s, x) => s + x.done, 0);
  const floorEff = allot > 0 ? Math.round((done / allot) * 100) : null;
  const n = useAttentionCount(ctx);

  const dateLine = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  const needs = n.alerts + (n.reads ? 1 : 0);
  const sub = [dateLine, needs ? `${plural(needs, 'thing')} need${needs === 1 ? 's' : ''} you` : 'nothing needs you', running ? `${plural(running, 'section')} working` : null]
    .filter(Boolean).join(' · ');

  const o = fig?.orders;
  const m = fig?.money ?? null;

  return (
    <div className="page fade ov">
      <div className="page-head ov-head">
        <div className="page-head-text">
          <h1>{greeting()}, {owner().name.split(' ')[0]}</h1>
          <p>{sub}</p>
        </div>
        <div className="page-head-actions ov-actions">
          <button className="ib" aria-label="Refresh" title={d.lastSync ? `Refresh · updated ${time(d.lastSync.toISOString())}` : 'Refresh'} onClick={() => d.refresh()}><Icon name="refresh" size={17} strokeWidth={2} /></button>
          <button className="btn primary" onClick={() => ctx.openSheet('stock')}><Icon name="plus" size={16} strokeWidth={2} />New entry</button>
        </div>
      </div>

      <div className="grid-kpi ov-figs">
        <Figure label="Stock on hand" to="stock" go={go}
          value={stock ? fmtMeters(stock.on_hand_m) : '—'}
          sub={stock ? `${plural(stock.active_lots, 'lot')} in stock${stock.low_lots.length ? ` · ${fmt(stock.low_lots.length)} running low` : ''}` : 'Open the stock ledger'}
          />
        <Figure label="Sent out today" to="stock" go={go}
          value={d.today ? fmtMeters(d.today.out_m) : '—'}
          sub={d.today ? `${fmtMeters(d.today.in_m)} received` : ' '} />
        {can(role, 'orders.view') && (
          <Figure label="Orders to deliver" to="orders" go={go}
            value={o ? fmt(o.open) : '—'}
            sub={!o ? ' ' : o.late ? `${fmt(o.late)} late${o.due_today ? ` · ${fmt(o.due_today)} due today` : ''}` : o.due_today ? `${fmt(o.due_today)} due today` : o.due_week ? `${fmt(o.due_week)} due this week` : o.open ? 'All on time' : 'No open orders'}
            tone={o?.late ? 'bad' : o?.due_today ? 'warn' : o ? 'good' : undefined} />
        )}
        {m || (!fig && role === 'owner' && can(role, 'finance.view')) ? (
          <Figure label="Payments overdue" to="money" go={go}
            value={!m ? '—' : m.overdue > 0 ? inr(m.overdue) : '₹ 0'}
            sub={!m ? ' ' : m.overdue > 0 ? `${plural(m.parties_overdue, 'party', 'parties')} · ${inr(m.outstanding)} due in all` : m.outstanding > 0 ? `${inr(m.outstanding)} due, none late` : 'Nothing due'}
            tone={!m ? undefined : m.overdue > 0 ? 'bad' : 'good'} />
        ) : (
          <Figure label="Floor today" to="people" go={go}
            value={floorEff == null ? '—' : `${floorEff}%`}
            sub={floorEff == null ? 'No work allotted yet' : `of ${fmtMeters(allot)} allotted is done`}
            tone={floorEff == null ? undefined : effTone(floorEff)} />
        )}
      </div>

      <div className="ov-split">
        <Attention ctx={ctx} limit={compact ? 3 : 5} />
        <LiveNow ctx={ctx} rows={compact ? 4 : 6} />
      </div>

      <StockFlow ctx={ctx} showDemand={!compact} />

      <section className="card pad stack-14">
        <div className="card-head"><h2>Sections</h2><span className="muted small">today</span></div>
        <div className="ov-secs">
          {sections.map((s) => (
            <button key={s.name} className="ov-sec" onClick={() => go('jobs')}>
              <div className="ov-sec-top">
                <span className="strong">{s.name}</span>
                <span className="muted small ellipsis">{supervisorFor(s.name)}</span>
              </div>
              <div className="ov-sec-nums">
                <div className="stack-2"><span className="ov-big num">{fmt(s.open)}</span><span className="muted tiny">open card{s.open === 1 ? '' : 's'}</span></div>
                <div className="stack-2"><span className="ov-big num">{fmtMeters(s.openM)}</span><span className="muted tiny">on the floor</span></div>
                <div className="stack-2"><span className="ov-big num">{s.shortage == null ? '—' : `${s.shortage.toFixed(1)}%`}</span><span className="muted tiny">shortage{s.shortage != null ? <> · <Pill tone={s.shortTone}>{s.shortTone === 'good' ? 'OK' : s.shortTone === 'warn' ? 'Watch' : 'High'}</Pill></> : null}</span></div>
              </div>
              {s.eff == null
                ? <span className="muted small">No work allotted today</span>
                : <div className="stack-6"><Track pct={s.eff} tone={effTone(s.eff)} /><span className="small t2"><span className="num">{s.eff}%</span> done · {fmtMeters(s.done)} of {fmtMeters(s.allot)} (target {rules().efficiencyTargetPct}%)</span></div>}
            </button>
          ))}
          {!sections.length && <Calm text="No sections set up yet. Add them in My firm." />}
        </div>
      </section>

      <TimeSaved ctx={ctx} />
    </div>
  );
}

function Figure({ label, value, sub, tone, to, go }: { label: string; value: React.ReactNode; sub: React.ReactNode; tone?: Tone; to: Tab; go: (t: Tab) => void }) {
  return (
    <button className="card kpi ov-fig" onClick={() => go(to)}>
      <span className="kpi-label">{label}<Icon name="arrow" size={14} className="ov-chev" /></span>
      <span className="kpi-value num">{value}</span>
      <span className={`kpi-sub ${tone ?? ''}`}>{sub}</span>
    </button>
  );
}

/** The top few items (worst first), for the owner's Overview and the supervisor's Floor. Everything, with accept / dismiss, lives in the bell panel. */
/** Owner/supervisor home: what needs attention, one line per category (worst item shown), opens the bell panel. */
export function Attention({ ctx, limit }: { ctx: Ctx; limit: number }) {
  const items = useAttentionItems(ctx);
  const agents = ctx.agents.list;
  const groups = useMemo(() => {
    const rank: Record<string, number> = { bad: 0, warn: 1, info: 2 };
    type Row = { key: string; tone: string; title: string; open: () => void };
    const by = new Map<CatKey, Row[]>();
    const add = (c: CatKey, r: Row) => { const l = by.get(c) ?? []; l.push(r); by.set(c, l); };
    items.forEach((a) => add(a.cat ?? 'other', { key: a.key, tone: a.tone, title: a.title, open: () => { if (a.hash) openLink(ctx.go, a.tab, a.hash); else ctx.go(a.tab); } }));
    agents.forEach((s) => add(catOfAgent(s.agent), { key: `s${s.id}`, tone: s.severity, title: s.title, open: () => ctx.openAttention('alerts') }));
    return CATS.filter((c) => by.has(c.key)).map((c) => {
      const rows = by.get(c.key)!.sort((a, b) => rank[a.tone] - rank[b.tone]);
      return { ...c, rows, worst: rows[0] };
    }).sort((a, b) => rank[a.worst.tone] - rank[b.worst.tone] || b.rows.length - a.rows.length);
  }, [items, agents, ctx]);
  const total = groups.reduce((t, g) => t + g.rows.length, 0);
  const shown = groups.slice(0, Math.max(limit, 3));

  return (
    <section className="card pad stack-14 ov-attn">
      <div className="card-head">
        <h2>Needs your attention</h2>
        {total > 0 && <span className="ov-badge num">{total}</span>}
      </div>
      {shown.length ? (
        <div className="ov-list">
          {shown.map((g) => (
            <button key={g.key} className="ov-item ov-cat" onClick={g.rows.length === 1 ? g.worst.open : () => ctx.openAttention('alerts')}>
              <span className={`dot-sm ${g.worst.tone}`} aria-hidden="true" />
              <span className="grow min0 stack-2">
                <span className="ov-item-title"><Icon name={g.icon} size={14} strokeWidth={2} /> {g.label} <span className="muted num">· {g.rows.length}</span></span>
                <span className="muted small ellipsis">{g.worst.title}{g.rows.length > 1 ? ` · +${g.rows.length - 1} more` : ''}</span>
              </span>
              <Icon name="arrow" size={16} className="ov-chev" />
            </button>
          ))}
        </div>
      ) : (
        <Calm text={ctx.agents.loaded ? 'All clear. Nothing needs you right now.' : 'Checking…'} />
      )}
      {total > 0 && (
        <button className="linkbtn small left ov-more" onClick={() => ctx.openAttention('alerts')}>
          {groups.length > shown.length ? `See all ${total}` : 'Open all alerts'}
        </button>
      )}
    </section>
  );
}

function TimeSaved({ ctx }: { ctx: Ctx }) {
  const v = ctx.d.value?.month;
  if (!v || v.savedMin <= 0) return null;
  const hours = v.savedMin / 60;
  return (
    <p className="muted small ov-foot">
      <Icon name="camera" size={14} /> Photo reads saved about {hours >= 1 ? `${fmt(hours, 1)} hours` : `${fmt(v.savedMin, 0)} minutes`} of typing in the last 30 days ({plural(v.captures, 'read')}).
    </p>
  );
}
