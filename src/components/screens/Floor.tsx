'use client';

import React from 'react';
import Icon from '../Icon';
import { Kpi, PageHead, Pill, Track, effTone, fmt, fmtM } from '../ui';
import type { Ctx } from '../ctx';
import { ACTIVE_SUPERVISOR, SHORTAGE_LIMIT_PCT, captureInScope, jobInScope } from '@/lib/access';
import { avg, camStatus } from '@/lib/derive';

export function Floor({ ctx }: { ctx: Ctx }) {
  const { d, go, days, role } = ctx;
  const crew = days.filter((x) => ACTIVE_SUPERVISOR.sections.includes(x.section));
  const allot = crew.reduce((s, x) => s + x.allotted, 0);
  const done = crew.reduce((s, x) => s + x.done, 0);
  const pct = allot > 0 ? Math.round((done / allot) * 100) : 0;
  const cards = d.jobCards.filter((j) => jobInScope(role, j));
  const openCards = cards.filter((j) => j.status !== 'closed').length;
  const shortage = avg(cards.filter((j) => j.status === 'closed' && j.meters_out != null).map((j) => j.shortage_pct));
  const over = cards.filter((j) => j.flagged);
  const pending = d.captures.filter((c) => c.status === 'pending' && captureInScope(role, c.type)).length;
  const idle = crew.filter((x) => x.cam && x.cam.active_pct < 60);

  return (
    <div className="page fade">
      <PageHead title={`${ACTIVE_SUPERVISOR.sections.join(' & ')} floor`} sub={`${crew.length} workers · ${openCards} open job cards`}>
        <button className="btn" onClick={() => go('allot')}>Allot work</button>
        <button className="btn primary" onClick={() => go('review')}>Review <span className="num">{pending}</span> read{pending === 1 ? '' : 's'}</button>
      </PageHead>

      <div className="grid-4">
        <Kpi label="Allotted today" value={fmtM(allot)} sub={`across ${crew.filter((x) => x.allotted > 0).length} workers`} />
        <Kpi label="Done so far" value={fmtM(done)}><Track pct={pct} tone="info" /></Kpi>
        <Kpi label="Section shortage" value={shortage == null ? '—' : `${shortage.toFixed(1)}%`} sub={`limit ${SHORTAGE_LIMIT_PCT}% · ${over.length} card${over.length === 1 ? '' : 's'} over`} subTone={over.length ? 'warn' : 'good'} />
        <Kpi label="Stock value" lock value={<span className="muted">••••••</span>} sub="hidden for your role" />
      </div>

      <div className="grid-split">
        <section className="card flush">
          <div className="card-head pad-x"><h2>My workers</h2></div>
          <table className="tbl rtbl">
            <thead><tr><th>Worker</th><th>Station</th><th style={{ width: 200 }}>Allotted → done</th><th className="r">Eff.</th><th>CCTV</th></tr></thead>
            <tbody>
              {crew.map((x) => {
                const cam = camStatus(x.cam);
                return (
                  <tr key={x.worker.id}>
                    <td data-label="Worker" className="strong">{x.worker.name}</td>
                    <td data-label="Station" className="num t2">{x.cam?.station ?? x.section}</td>
                    <td data-label="Progress"><div className="stack-6"><Track pct={x.eff ?? 0} tone={x.eff == null ? 'info' : effTone(x.eff)} /><span className="num muted small">{fmt(x.done)} / {fmt(x.allotted)} m</span></div></td>
                    <td data-label="Eff." className="r num">{x.eff == null ? '—' : `${x.eff}%`}</td>
                    <td data-label="CCTV"><Pill tone={cam.tone}>{cam.text}</Pill></td>
                  </tr>
                );
              })}
              {!crew.length && <tr><td colSpan={5} className="muted center">No workers in your sections</td></tr>}
            </tbody>
          </table>
        </section>

        <section className="card pad stack-14">
          <h2 className="h2">Needs you</h2>
          {over.slice(0, 2).map((j) => (
            <div className="callout bad" key={j.id}>
              <span className="callout-title">JC-{j.id} over shortage limit</span>
              <span className="t2 small">{fmt(j.shortage ?? 0, 1)} m short on {fmt(j.meters_in)} m · {j.worker_name}</span>
              <div><button className="btn sm" onClick={() => go('jobs')}>Check card</button></div>
            </div>
          ))}
          {idle.slice(0, 2).map((x) => (
            <div className="callout warn" key={x.worker.id}>
              <span className="callout-title">{x.worker.name} idle {Math.round(x.cam!.idle_min)} min</span>
              <span className="t2 small">{x.cam!.station} · {fmt(x.done)} of {fmt(x.allotted)} m done</span>
              <div><button className="btn sm" onClick={() => go('allot')}>Reassign</button></div>
            </div>
          ))}
          <div className="callout info">
            <span className="callout-title"><span className="num">{pending}</span> photo read{pending === 1 ? '' : 's'} to confirm</span>
            <span className="t2 small">{ACTIVE_SUPERVISOR.sections.join(' and ')} job cards</span>
            <div><button className="btn sm" onClick={() => go('review')}>Open queue</button></div>
          </div>
          {!over.length && !idle.length && <p className="muted small" style={{ margin: 0 }}><Icon name="check" size={14} /> No shortage or idle alerts.</p>}
        </section>
      </div>
    </div>
  );
}
