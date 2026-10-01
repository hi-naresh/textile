'use client';

import React from 'react';
import { Kpi, PageHead, Pill, Track, effTone, fmt, fmtM } from '../ui';
import { Attention } from './Overview';
import type { Ctx } from '../ctx';
import { captureInScope, jobInScope, activeSupervisor, rules } from '@/lib/access';
import { avg, camStatus } from '@/lib/derive';

export function Floor({ ctx }: { ctx: Ctx }) {
  const { d, go, days, role } = ctx;
  const crew = days.filter((x) => activeSupervisor().sections.includes(x.section));
  const allot = crew.reduce((s, x) => s + x.allotted, 0);
  const done = crew.reduce((s, x) => s + x.done, 0);
  const pct = allot > 0 ? Math.round((done / allot) * 100) : 0;
  const cards = d.jobCards.filter((j) => jobInScope(role, j));
  const openCards = cards.filter((j) => j.status !== 'closed').length;
  const shortage = avg(cards.filter((j) => j.status === 'closed' && j.meters_out != null).map((j) => j.shortage_pct));
  const over = cards.filter((j) => j.flagged);
  const pending = d.captures.filter((c) => c.status === 'pending' && captureInScope(role, c.type)).length;

  return (
    <div className="page fade">
      <PageHead title={activeSupervisor().sections.length ? `${activeSupervisor().sections.join(' & ')} floor` : 'My floor'} sub={`${crew.length} worker${crew.length === 1 ? "" : "s"} · ${openCards} open job card${openCards === 1 ? "" : "s"}`}>
        <button className={`btn ${pending ? '' : 'primary'}`} onClick={() => go('allot')}>Allot work</button>
        {pending > 0 && <button className="btn primary" onClick={() => go('review')}>Review <span className="num">{pending}</span> read{pending === 1 ? '' : 's'}</button>}
      </PageHead>

      <div className="grid-4">
        <Kpi label="Allotted today" value={fmtM(allot)} sub={`across ${crew.filter((x) => x.allotted > 0).length} workers`} />
        <Kpi label="Done so far" value={fmtM(done)}><Track pct={pct} tone="info" /></Kpi>
        <Kpi label="Section shortage" value={shortage == null ? '—' : `${shortage.toFixed(1)}%`} sub={`limit ${rules().shortageLimitPct}% · ${over.length} card${over.length === 1 ? '' : 's'} over`} subTone={over.length ? 'warn' : 'good'} />
        <Kpi label="Open job cards" value={<span className="num">{openCards}</span>} sub={pending ? `${pending} photo read${pending === 1 ? '' : 's'} to confirm` : 'No reads waiting'} subTone={pending ? 'warn' : 'good'} />
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

        <Attention ctx={ctx} limit={ctx.density === 'compact' ? 3 : 5} />
      </div>
    </div>
  );
}
