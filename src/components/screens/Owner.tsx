'use client';

import React, { useMemo, useState } from 'react';
import Icon from '../Icon';
import { Kpi, PageHead, Pill, Segmented, Track, dayTime, effTone, fmt, fmtM, inr, initials, time } from '../ui';
import type { Ctx } from '../ctx';
import { MATRIX, OWNER, ROLE_LABEL, SCOPE_TEXT, SHORTAGE_LIMIT_PCT, SUPERVISORS, levelTone, supervisorFor, type Role } from '@/lib/access';
import { camStatus, sectionRows } from '@/lib/derive';

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

// ---------------- Overview ----------------
export function Overview({ ctx }: { ctx: Ctx }) {
  const { d, go, days, rate } = ctx;
  const onHand = d.lots.reduce((s, l) => s + Math.max(0, l.balance), 0);
  const activeLots = d.lots.filter((l) => l.balance > 0).length;
  const today = d.flow[d.flow.length - 1];
  const allot = days.reduce((s, x) => s + x.allotted, 0);
  const done = days.reduce((s, x) => s + x.done, 0);
  const floorEff = allot > 0 ? (done / allot) * 100 : null;
  const flaggedWorkers = days.filter((x) => x.eff != null && x.eff < 85).length;
  const sections = sectionRows(days, d.jobCards);
  const pending = d.captures.filter((c) => c.status === 'pending');
  const lowConf = pending.filter((c) => c.confidence < 0.8).length;

  const attention = useMemo(() => {
    const items: { tone: 'bad' | 'warn' | 'info'; title: string; sub: string; action: string; onClick: () => void }[] = [];
    d.jobCards.filter((j) => j.flagged).slice(0, 2).forEach((j) =>
      items.push({ tone: 'bad', title: `Shortage ${j.shortage_pct.toFixed(1)}% on ${j.lot_id}`, sub: `${j.process} · JC-${j.id} · above ${SHORTAGE_LIMIT_PCT}% limit${rate && j.shortage ? ` · ${inr(j.shortage * rate)}` : ''}`, action: 'Open', onClick: () => go('jobs') }));
    if (pending.length) items.push({ tone: 'warn', title: `${pending.length} AI photo read${pending.length > 1 ? 's' : ''} waiting`, sub: lowConf ? `${lowConf} below 80% confidence` : 'All above 80% confidence', action: 'Review', onClick: () => go('review') });
    days.filter((x) => x.cam && x.cam.active_pct < 60).slice(0, 2).forEach((x) =>
      items.push({ tone: 'warn', title: `${x.worker.name} idle ${Math.round(x.cam!.idle_min)} min`, sub: `CCTV · ${x.cam!.station} · ${x.section}`, action: 'View', onClick: () => go('people') }));
    d.lots.filter((l) => l.balance > 0 && l.balance < 200).slice(0, 1).forEach((l) =>
      items.push({ tone: 'info', title: `${l.lot_id} running low`, sub: `${fmtM(l.balance)} left · ${l.quality}`, action: 'Ledger', onClick: () => go('stock') }));
    return items;
  }, [d.jobCards, d.lots, pending.length, lowConf, days, go, rate]);

  const max = Math.max(1, ...d.flow.map((f) => Math.max(f.in_m, f.out_m)));
  const lastQ = [...d.messages].reverse().find((m) => m.sender === 'user');
  const lastA = lastQ ? d.messages[d.messages.indexOf(lastQ) + 1] : undefined;

  return (
    <div className="page fade">
      <PageHead title={`${greeting()}, ${OWNER.name.split(' ')[0]}`} sub={`All units · ${sections.filter((s) => s.open > 0).length} section${sections.filter((s) => s.open > 0).length === 1 ? '' : 's'} running${d.lastSync ? ` · synced ${time(d.lastSync.toISOString())}` : ''}`}>
        <button className="btn" onClick={() => d.refresh()}><Icon name="refresh" size={16} strokeWidth={2} />Refresh</button>
        <button className="btn primary" onClick={() => ctx.openSheet('stock')}><Icon name="plus" size={16} strokeWidth={2} />New entry</button>
      </PageHead>

      <div className="grid-4">
        <Kpi label="Stock on hand" value={fmtM(onHand)} sub={`${activeLots} active lots`} />
        <RateKpi ctx={ctx} onHand={onHand} />
        <Kpi label="Dispatched today" value={fmtM(today?.out_m ?? 0)} sub={`In today: ${fmtM(today?.in_m ?? 0)}`} />
        <Kpi label="Floor efficiency" value={floorEff == null ? '—' : `${floorEff.toFixed(1)}%`} sub={floorEff == null ? 'No work allotted today' : flaggedWorkers ? `${flaggedWorkers} worker${flaggedWorkers > 1 ? 's' : ''} below 85%` : 'Everyone on track'} subTone={flaggedWorkers ? 'warn' : 'good'} />
      </div>

      <div className="grid-split">
        <section className="card pad">
          <div className="card-head">
            <h2>Stock flow · last 7 days</h2>
            <span className="legend"><i style={{ background: 'var(--accent)' }} />In</span>
            <span className="legend"><i style={{ background: 'var(--warn)' }} />Out</span>
          </div>
          <div className="chart">
            {d.flow.map((f) => {
              const label = new Date(f.day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' });
              return (
                <div className="chart-col" key={f.day} title={`${label}: in ${fmt(f.in_m)} m, out ${fmt(f.out_m)} m`}>
                  <div className="chart-bars">
                    <div className="chart-bar" style={{ height: `${(f.in_m / max) * 100}%`, background: 'var(--accent)' }} />
                    <div className="chart-bar" style={{ height: `${(f.out_m / max) * 100}%`, background: 'var(--warn)' }} />
                  </div>
                  <span className="chart-label">{label}</span>
                </div>
              );
            })}
            {!d.flow.length && <span className="muted">No movements yet</span>}
          </div>
        </section>

        <section className="card pad stack-14">
          <div className="card-head"><h2>Needs your attention</h2>{attention.length > 0 && <Pill tone="bad"><span className="num">{attention.length}</span></Pill>}</div>
          {attention.length === 0 && <p className="muted" style={{ margin: 0 }}>All clear. Nothing needs you right now.</p>}
          {attention.map((a, i) => (
            <div className="attn" key={i}>
              <span className={`dot-sm ${a.tone}`} />
              <div className="grow">
                <div className="attn-title">{a.title}</div>
                <div className="attn-sub">{a.sub}</div>
              </div>
              <button className="btn sm" onClick={a.onClick}>{a.action}</button>
            </div>
          ))}
        </section>
      </div>

      <div className="grid-split">
        <section className="card flush">
          <div className="card-head pad-x"><h2>Sections</h2><span className="muted small">today, live</span></div>
          <table className="tbl rtbl">
            <thead><tr><th>Section</th><th>Supervisor</th><th className="r">Open cards</th><th style={{ width: 180 }}>Efficiency</th><th className="r">Shortage</th></tr></thead>
            <tbody>
              {sections.map((s) => (
                <tr key={s.name}>
                  <td data-label="Section" className="strong">{s.name}</td>
                  <td data-label="Supervisor" className="t2">{supervisorFor(s.name)}</td>
                  <td data-label="Open cards" className="r num">{s.open}</td>
                  <td data-label="Efficiency">{s.eff == null ? <span className="muted">No allotment</span> : <div className="bar-row"><Track pct={s.eff} tone={effTone(s.eff)} /><span className="num small">{s.eff}%</span></div>}</td>
                  <td data-label="Shortage" className="r"><Pill tone={s.shortTone}><span className="num">{s.shortage == null ? '—' : `${s.shortage.toFixed(1)}%`}</span></Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card pad stack-14">
          <div className="card-head"><Icon name="chat" style={{ color: 'var(--accent)' }} /><h2>Ask Textile Brain</h2><Pill>Every answer audited</Pill></div>
          {lastQ && lastA && !lastA.loading ? (
            <div className="qa">
              <span className="muted small">You asked · {time(lastQ.timestamp.toISOString())}</span>
              <span className="strong">{lastQ.text}</span>
              <span className="t2">{lastA.text}</span>
            </div>
          ) : (
            <div className="qa"><span className="t2">Ask about stock, lots, job cards or workers in plain language. I query the live database.</span></div>
          )}
          <div className="chips">
            {['Which lots have less than 500 meters?', 'Top 5 workers by efficiency', 'Total shortage by process'].map((q) => (
              <button key={q} className="chip" onClick={() => { d.ask('owner', q); go('ask'); }}>{q}</button>
            ))}
          </div>
          <AskInline onAsk={(q) => { d.ask('owner', q); go('ask'); }} />
        </section>
      </div>
    </div>
  );
}

function RateKpi({ ctx, onHand }: { ctx: Ctx; onHand: number }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(ctx.rate ? String(ctx.rate) : '');
  if (editing) {
    return (
      <form className="card kpi" onSubmit={(e) => { e.preventDefault(); const n = parseFloat(val); ctx.setRate(Number.isFinite(n) && n > 0 ? n : null); setEditing(false); }}>
        <label className="kpi-label" htmlFor="rate">Average rate (₹ per meter)</label>
        <input id="rate" className="input num" inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} autoFocus placeholder="e.g. 185" />
        <div className="row-8"><button className="btn sm primary" type="submit">Save</button><button className="btn sm" type="button" onClick={() => setEditing(false)}>Cancel</button></div>
      </form>
    );
  }
  return (
    <Kpi label="Stock value" lock value={ctx.rate ? inr(onHand * ctx.rate) : '₹ —'} sub={ctx.rate ? <>at ₹{fmt(ctx.rate)}/m average · <button className="linkbtn" onClick={() => setEditing(true)}>edit</button></> : <button className="linkbtn" onClick={() => setEditing(true)}>Set average ₹/m rate</button>} />
  );
}

export function AskInline({ onAsk, placeholder = 'Ask in English, हिंदी or ગુજરાતી…' }: { onAsk: (q: string) => void; placeholder?: string }) {
  const [q, setQ] = useState('');
  return (
    <form className="askbox" onSubmit={(e) => { e.preventDefault(); if (q.trim()) { onAsk(q.trim()); setQ(''); } }}>
      <input aria-label="Ask a question" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
      <button className="btn primary sm icon-only" aria-label="Send" type="submit"><Icon name="arrow" size={16} strokeWidth={2} /></button>
    </form>
  );
}

// ---------------- Stock ledger ----------------
export function Stock({ ctx }: { ctx: Ctx }) {
  const { d, rate } = ctx;
  const [view, setView] = useState<'moves' | 'lots'>('moves');
  const [dir, setDir] = useState<'ALL' | 'IN' | 'OUT'>('ALL');
  const rows = d.ledger.filter((l) => dir === 'ALL' || l.direction === dir);
  const today = d.flow[d.flow.length - 1];

  const exportCsv = () => {
    const head = ['time', 'direction', 'lot', 'quality', 'design', 'meters', 'party', 'challan', 'source'];
    const lines = d.ledger.map((l) => [l.ts, l.direction, l.lot_id, l.quality ?? '', l.design ?? '', l.meters, l.party ?? '', l.source_doc_id ?? '', l.capture_event_id ? 'photo' : 'manual']
      .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `stock-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="page fade">
      <PageHead title="Stock ledger" sub="Every IN and OUT movement, from confirmed photo reads and manual entries">
        <button className="btn" onClick={exportCsv}><Icon name="download" size={16} strokeWidth={2} />Export CSV</button>
        <button className="btn primary" onClick={() => ctx.openSheet('stock')}><Icon name="plus" size={16} strokeWidth={2} />Manual entry</button>
      </PageHead>
      <div className="toolbar">
        <Segmented label="View" value={view} onChange={setView} options={[{ value: 'moves', label: 'Movements' }, { value: 'lots', label: 'Lots & balance' }]} />
        {view === 'moves' && <Segmented label="Direction" value={dir} onChange={setDir} options={[{ value: 'ALL', label: 'All' }, { value: 'IN', label: 'Inward' }, { value: 'OUT', label: 'Outward' }]} />}
        <div className="grow" />
        <span className="t2 small">Today: <span className="num strong">+{fmt(today?.in_m ?? 0)} m</span> in · <span className="num strong">−{fmt(today?.out_m ?? 0)} m</span> out</span>
      </div>
      {view === 'moves' ? (
        <section className="card flush">
          <table className="tbl rtbl">
            <thead><tr><th>Time</th><th>Dir</th><th>Lot</th><th>Quality · Design</th><th className="r">Meters</th><th>Party</th><th>Challan</th><th>Source</th><th className="r"><span className="lock th-lock"><Icon name="lock" size={12} strokeWidth={2} />Value</span></th></tr></thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id}>
                  <td data-label="Time" className="num t2">{dayTime(l.ts)}</td>
                  <td data-label="Dir"><Pill tone={l.direction === 'IN' ? 'info' : 'warn'}>{l.direction}</Pill></td>
                  <td data-label="Lot" className="num strong">{l.lot_id}</td>
                  <td data-label="Quality"><div>{l.quality ?? '—'}</div><div className="muted small">{l.design}</div></td>
                  <td data-label="Meters" className="r num">{fmt(l.meters, 1)}</td>
                  <td data-label="Party" className="t2">{l.party ?? '—'}</td>
                  <td data-label="Challan" className="num t2">{l.source_doc_id ?? '—'}</td>
                  <td data-label="Source"><Pill>{l.capture_event_id ? 'Photo · AI' : 'Manual'}</Pill></td>
                  <td data-label="Value" className="r num">{rate ? inr(l.meters * rate) : '—'}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={9} className="muted center">No movements</td></tr>}
            </tbody>
          </table>
        </section>
      ) : (
        <section className="card flush">
          <table className="tbl rtbl">
            <thead><tr><th>Lot</th><th>Quality</th><th>Design</th><th>Grade</th><th>Status</th><th className="r">Balance</th></tr></thead>
            <tbody>
              {d.lots.map((l) => (
                <tr key={l.lot_id}>
                  <td data-label="Lot" className="num strong">{l.lot_id}</td>
                  <td data-label="Quality">{l.quality}</td>
                  <td data-label="Design" className="t2">{l.design}</td>
                  <td data-label="Grade">{l.grade}</td>
                  <td data-label="Status"><Pill tone={l.status === 'active' ? 'good' : l.status === 'hold' ? 'warn' : 'neutral'}>{l.status}</Pill></td>
                  <td data-label="Balance" className="r num strong">{fmt(l.balance, 1)} m</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

// ---------------- People & CCTV ----------------
export function People({ ctx }: { ctx: Ctx }) {
  return (
    <div className="page fade">
      <PageHead title="People & CCTV" sub="Allotted vs done today, with active time from station cameras" />
      <section className="card flush">
        <table className="tbl rtbl">
          <thead><tr><th>Worker</th><th>Section · Station</th><th className="r">Allotted</th><th className="r">Done</th><th style={{ width: 200 }}>Efficiency</th><th>CCTV now</th></tr></thead>
          <tbody>
            {ctx.days.map((x) => {
              const cam = camStatus(x.cam);
              return (
                <tr key={x.worker.id}>
                  <td data-label="Worker"><div className="who"><span className="av worker sm">{initials(x.worker.name)}</span><span className="strong">{x.worker.name}</span></div></td>
                  <td data-label="Section" className="t2">{x.section}{x.cam ? <> · <span className="num">{x.cam.station}</span></> : null}</td>
                  <td data-label="Allotted" className="r num">{fmt(x.allotted)}</td>
                  <td data-label="Done" className="r num">{fmt(x.done)}</td>
                  <td data-label="Efficiency">{x.eff == null ? <span className="muted">Not allotted</span> : <div className="bar-row"><Track pct={x.eff} tone={effTone(x.eff)} /><span className="num small">{x.eff}%</span></div>}</td>
                  <td data-label="CCTV"><Pill tone={cam.tone}>{cam.text}</Pill></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

// ---------------- Access & roles ----------------
export function Access({ ctx }: { ctx: Ctx }) {
  const counts: Record<Role, number> = { owner: 1, supervisor: SUPERVISORS.length, worker: ctx.d.workers.length };
  const blurb: Record<Role, string> = {
    owner: 'Whole firm. Money, rates, CCTV, users. Can override any read.',
    supervisor: 'Assigned sections only. Meters, not money. Confirm reads, run job cards, allot work.',
    worker: 'Own allotments and history. Capture photos. Nothing about other workers.',
  };
  return (
    <div className="page fade">
      <PageHead title="Access & roles" sub="Who can see which data, and who can change it. Each layer only sees down, never up." />
      <div className="grid-3">
        {(['owner', 'supervisor', 'worker'] as Role[]).map((r) => (
          <div className="card pad role-card" key={r}>
            <span className={`av ${r} lg`}>{counts[r]}</span>
            <div className="stack-4">
              <span className="role-name">{ROLE_LABEL[r]}{r !== 'owner' ? 's' : ''}</span>
              <span className="t2 small lh">{blurb[r]}</span>
              <span className="muted small">{SCOPE_TEXT[r].scope}</span>
            </div>
          </div>
        ))}
      </div>
      <section className="card flush">
        <table className="tbl rtbl">
          <thead><tr><th>Layer</th><th>Capability</th><th>Owner</th><th>Supervisor</th><th>Worker</th></tr></thead>
          <tbody>
            {MATRIX.map((m) => (
              <tr key={m.cap}>
                <td data-label="Layer" className="muted caps">{m.layer}</td>
                <td data-label="Capability" className="strong">{m.label}</td>
                <td data-label="Owner"><Pill tone={levelTone(m.owner)}>{m.owner}</Pill></td>
                <td data-label="Supervisor"><Pill tone={levelTone(m.supervisor)}>{m.supervisor}</Pill></td>
                <td data-label="Worker"><Pill tone={levelTone(m.worker)}>{m.worker}</Pill></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p className="muted small note"><Icon name="lock" size={14} strokeWidth={2} />Supervisor sections: {SUPERVISORS.map((s) => `${s.name} — ${s.sections.join(' & ')}`).join(' · ')}</p>
    </div>
  );
}
