'use client';

import React, { useMemo, useState } from 'react';
import Icon from '../Icon';
import { Kpi, PageHead, Pill, Segmented, Sheet, Track, dayTime, effTone, fmt, fmtM, inr, initials, time } from '../ui';
import { LotLocationPanel } from './Shared';
import { LiveNow, StockFlow } from './Today';
import AgentInbox from '../AgentInbox';
import type { LedgerEntry } from '@/lib/types';
import type { Ctx } from '../ctx';
import { MATRIX, ROLE_LABEL, levelTone, supervisorFor, type Role, rules, activeSupervisors, owner, withFirm } from '@/lib/access';
import { STAGE_LABEL, camStatus, locationTone, sectionRows } from '@/lib/derive';

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
  const target = rules().efficiencyTargetPct;
  const flaggedWorkers = days.filter((x) => x.eff != null && x.eff < target).length;
  const sections = sectionRows(days, d.jobCards);
  const pending = d.captures.filter((c) => c.status === 'pending');
  const autoPct = rules().aiAutoConfirmPct;
  const lowConf = pending.filter((c) => c.confidence * 100 < autoPct).length;

  const attention = useMemo(() => {
    const items: { tone: 'bad' | 'warn' | 'info'; title: string; sub: string; action: string; onClick: () => void }[] = [];
    d.jobCards.filter((j) => j.flagged).slice(0, 2).forEach((j) =>
      items.push({ tone: 'bad', title: `Shortage ${j.shortage_pct.toFixed(1)}% on ${j.lot_id}`, sub: `${j.process} · JC-${j.id} · above ${rules().shortageLimitPct}% limit${rate && j.shortage ? ` · ${inr(j.shortage * rate)}` : ''}`, action: 'Open', onClick: () => go('jobs') }));
    if (pending.length) items.push({ tone: 'warn', title: `${pending.length} photo read${pending.length > 1 ? 's' : ''} waiting`, sub: lowConf ? `${lowConf} below ${autoPct}% confidence` : `All above ${autoPct}% confidence`, action: 'Review', onClick: () => go('review') });
    days.filter((x) => x.cam && x.cam.active_pct < 60).slice(0, 2).forEach((x) =>
      items.push({ tone: 'warn', title: `${x.worker.name} idle ${Math.round(x.cam!.idle_min)} min`, sub: `CCTV · ${x.cam!.station} · ${x.section}`, action: 'View', onClick: () => go('people') }));
    d.lots.filter((l) => l.balance > 0 && l.balance < 200).slice(0, 1).forEach((l) =>
      items.push({ tone: 'info', title: `${l.lot_id} running low`, sub: `${fmtM(l.balance)} left · ${l.quality}`, action: 'Ledger', onClick: () => go('stock') }));
    return items;
  }, [d.jobCards, d.lots, pending.length, lowConf, autoPct, days, go, rate]);


  return (
    <div className="page fade">
      <PageHead title={`${greeting()}, ${owner().name.split(' ')[0]}`} sub={`${sections.filter((s) => s.open > 0).length} section${sections.filter((s) => s.open > 0).length === 1 ? '' : 's'} running${d.lastSync ? ` · synced ${time(d.lastSync.toISOString())}` : ''}`}>
        <button className="btn" onClick={() => d.refresh()}><Icon name="refresh" size={16} strokeWidth={2} />Refresh</button>
        <button className="btn primary" onClick={() => ctx.openSheet('stock')}><Icon name="plus" size={16} strokeWidth={2} />New entry</button>
      </PageHead>

      <div className="grid-kpi">
        <Kpi label="Stock on hand" value={fmtM(onHand)} sub={`${activeLots} active lots`} />
        <RateKpi ctx={ctx} onHand={onHand} />
        <Kpi label="Dispatched today" value={fmtM(today?.out_m ?? 0)} sub={`In today: ${fmtM(today?.in_m ?? 0)}`} />
        <Kpi label="Floor efficiency" value={floorEff == null ? '—' : `${floorEff.toFixed(1)}%`} sub={floorEff == null ? 'No work allotted today' : flaggedWorkers ? `${flaggedWorkers} worker${flaggedWorkers > 1 ? 's' : ''} below ${target}%` : 'Everyone on track'} subTone={flaggedWorkers ? 'warn' : 'good'} />
        <TimeSavedKpi ctx={ctx} />
      </div>

      <div className="grid-split">
        <LiveNow ctx={ctx} />
        <section className="card pad stack-14">
          <div className="card-head"><h2>Needs your attention</h2>{attention.length > 0 && <Pill tone="bad"><span className="num">{attention.length}</span></Pill>}</div>

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
          <AgentInbox ctx={ctx} empty={attention.length === 0 ? <p className="muted" style={{ margin: 0 }}>All clear. Nothing needs you right now.</p> : null} />
        </section>
      </div>

      <StockFlow ctx={ctx} />

      <section className="card flush d">
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

    </div>
  );
}

function TimeSavedKpi({ ctx }: { ctx: Ctx }) {
  const v = ctx.d.value?.month;
  const hours = v ? v.savedMin / 60 : 0;
  return (
    <Kpi
      label="Time saved · 30 days"
      value={v ? (hours >= 1 ? `${fmt(hours, 1)} h` : `${fmt(v.savedMin, 0)} min`) : '—'}
      sub={v ? (v.captures ? `${v.captures} photo read${v.captures === 1 ? '' : 's'} vs manual entry` : 'No confirmed photo reads yet') : 'Loading…'}
      subTone={v && v.savedMin > 0 ? 'good' : undefined}
    />
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
    <Kpi label="Stock value" value={ctx.rate ? inr(onHand * ctx.rate) : '₹ —'} sub={ctx.rate ? <>at ₹{fmt(ctx.rate)}/m average · <button className="linkbtn" onClick={() => setEditing(true)}>edit</button></> : <button className="linkbtn" onClick={() => setEditing(true)}>Set average ₹/m rate</button>} />
  );
}

// ---------------- Stock ledger ----------------
export function Stock({ ctx }: { ctx: Ctx }) {
  const { d, rate } = ctx;
  const [view, setView] = useState<'moves' | 'lots'>('moves');
  const [dir, setDir] = useState<'ALL' | 'IN' | 'OUT'>('ALL');
  const [lotSheet, setLotSheet] = useState<string | null>(null);
  const rows = d.ledger.filter((l) => dir === 'ALL' || l.direction === dir);
  const today = d.flow[d.flow.length - 1];

  const exportHref = view === 'lots' ? '/api/stock/export?kind=lots' : `/api/stock/export?kind=challans${dir === 'ALL' ? '' : `&direction=${dir}`}`;

  return (
    <div className="page fade">
      <PageHead title="Stock ledger" sub="Every challan in and out">
        <a className="btn" href={exportHref} download><Icon name="download" size={16} strokeWidth={2} />Excel</a>
        <button className="btn" onClick={() => ctx.openSheet('import')}><Icon name="upload" size={16} strokeWidth={2} />Import</button>
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
            <thead><tr><th className="r">S.No</th><th>Time</th><th>Dir</th><th>Lot</th><th className="d">Quality · Design</th><th className="r">Meters</th><th className="r d">Grey → Finished</th><th>From (mill · weaver) / To (party)</th><th>Challan</th><th className="d">Source</th><th className="r d">Value ₹</th></tr></thead>
            <tbody>
              {rows.map((l, i) => (
                <tr key={l.id}>
                  <td data-label="S.No" className="r num muted">{i + 1}</td>
                  <td data-label="Time" className="num t2">{dayTime(l.ts)}</td>
                  <td data-label="Dir"><Pill tone={l.direction === 'IN' ? 'info' : 'warn'}>{l.direction}</Pill></td>
                  <td data-label="Lot" className="num strong">{l.lot_id}</td>
                  <td data-label="Quality" className="d"><div>{l.quality ?? '—'}</div><div className="muted small">{l.design}</div></td>
                  <td data-label="Meters" className="r num">{fmt(l.meters, 1)}</td>
                  <td data-label="Grey → Finished" className="r num t2 d">{l.direction === 'IN' && (l.grey_meters != null || l.finished_meters != null) ? `${fmt(l.grey_meters, 1)} → ${fmt(l.finished_meters, 1)}` : '—'}</td>
                  <td data-label={l.direction === 'IN' ? 'From' : 'To'} className="t2">{l.direction === 'IN' ? <InSource l={l} /> : <span>→ {l.party ?? '—'}</span>}</td>
                  <td data-label="Challan" className="num t2">{l.source_doc_id ?? '—'}</td>
                  <td data-label="Source" className="d"><Pill>{l.capture_event_id ? 'Photo' : 'Manual'}</Pill></td>
                  <td data-label="Value" className="r num d">{rate ? inr(l.meters * rate) : '—'}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={11} className="muted center">No movements</td></tr>}
            </tbody>
          </table>
        </section>
      ) : (
        <section className="card flush">
          <table className="tbl rtbl">
            <thead><tr><th className="r">S.No</th><th>Lot</th><th>Quality</th><th className="d">Design</th><th className="d">Grade</th><th className="d">Status</th><th>Location</th><th className="r">Balance</th><th className="r">Action</th></tr></thead>
            <tbody>
              {d.lots.map((l, i) => (
                <tr key={l.lot_id}>
                  <td data-label="S.No" className="r num muted">{i + 1}</td>
                  <td data-label="Lot" className="num strong">{l.lot_id}</td>
                  <td data-label="Quality">{l.quality}</td>
                  <td data-label="Design" className="t2 d">{l.design}</td>
                  <td data-label="Grade" className="d">{l.grade}</td>
                  <td data-label="Status" className="d"><Pill tone={l.status === 'active' ? 'good' : l.status === 'hold' ? 'warn' : 'neutral'}>{l.status}</Pill></td>
                  <td data-label="Location"><div className="loc-cell"><Pill tone={locationTone(l.location)}>{l.location ?? 'Not recorded'}</Pill>{l.location_stage && <span className="muted tiny">{STAGE_LABEL[l.location_stage]} · {dayTime(l.location_ts!)}</span>}</div></td>
                  <td data-label="Balance" className="r num strong">{fmt(l.balance, 1)} m</td>
                  <td data-label="Action" className="r"><button className="btn sm" onClick={() => setLotSheet(l.lot_id)}>{l.location === 'Dispatched' ? 'History' : 'Move'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <Sheet open={lotSheet != null} title={lotSheet ? `${lotSheet} · location` : ''} onClose={() => setLotSheet(null)}>
        {lotSheet && <LotLocationPanel ctx={ctx} lotId={lotSheet} onDone={() => setLotSheet(null)} />}
      </Sheet>
    </div>
  );
}

function InSource({ l }: { l: LedgerEntry }) {
  if (!l.mill_name && !l.weaver_name) return <span>{l.party ? <>{l.party} <span className="muted tiny">(old entry)</span></> : '—'}</span>;
  const same = l.mill_name && l.weaver_name && l.mill_name === l.weaver_name;
  return (
    <div className="stack-0">
      <span>{l.mill_name ?? '—'}</span>
      <span className="muted small">{same ? 'Weaver: same as mill' : `Weaver: ${l.weaver_name ?? '—'}`}</span>
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
  const counts: Record<Role, number> = { owner: 1, supervisor: activeSupervisors().length, worker: ctx.d.workers.length };
  const blurb: Record<Role, string> = {
    owner: 'Whole firm. Money, rates, CCTV, users. Can override any read.',
    supervisor: 'Incoming and outgoing challan photos. Own sections: reviews, job cards, allotment. Meters, not money.',
    worker: 'Job card (cut) photos only.',
  };
  return (
    <div className="page fade">
      <PageHead title="Access & roles" sub="Who sees what, and who can change it" />
      <div className="grid-3">
        {(['owner', 'supervisor', 'worker'] as Role[]).map((r) => (
          <div className="card pad role-card" key={r}>
            <span className={`av ${r} lg`}>{counts[r]}</span>
            <div className="stack-4">
              <span className="role-name">{ROLE_LABEL[r]}{r !== 'owner' ? 's' : ''}</span>
              <span className="t2 small lh">{blurb[r]}</span>
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
                <td data-label="Capability" className="strong">{withFirm(m.label)}</td>
                <td data-label="Owner"><Pill tone={levelTone(m.owner)}>{m.owner}</Pill></td>
                <td data-label="Supervisor"><Pill tone={levelTone(m.supervisor)}>{m.supervisor}</Pill></td>
                <td data-label="Worker"><Pill tone={levelTone(m.worker)}>{m.worker}</Pill></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
