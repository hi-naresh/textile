'use client';

import React, { useState } from 'react';
import Icon from '../Icon';
import { Kpi, PageHead, Pill, Segmented, Sheet, Track, dayTime, effTone, fmt, fmtM, inr, initials, time } from '../ui';
import { LotLocationPanel } from './Shared';
import { LedgerFilterBar } from './StockLedger';
import { EMPTY_FILTERS, filtersActive, ledgerParams, useDebounced, useLedger, type LedgerFilterState, type LedgerRow } from '@/lib/useLedger';
import { EditBar, EditCell, EditedMarker, LOT_STATUSES, NO_DRAFTS, UnsavedDialog, checkCell, countDrafts, gridKeyDown, setDraft, str, type Drafts, type OnEdit, type RowDraft } from './StockEdit';
import { LiveNow, StockFlow } from './Today';
import { AttentionList, useAttentionCount } from '../AgentInbox';
import type { LedgerEntry, Lot } from '@/lib/types';
import type { Ctx } from '../ctx';
import { can, supervisorFor, rules, owner } from '@/lib/access';
import { STAGE_LABEL, camStatus, locationTone, sectionRows } from '@/lib/derive';

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

// ---------------- Overview ----------------
export function Overview({ ctx }: { ctx: Ctx }) {
  const { d, days } = ctx;
  const onHand = d.lots.reduce((s, l) => s + Math.max(0, l.balance), 0);
  const activeLots = d.lots.filter((l) => l.balance > 0).length;
  const today = d.flow[d.flow.length - 1];
  const allot = days.reduce((s, x) => s + x.allotted, 0);
  const done = days.reduce((s, x) => s + x.done, 0);
  const floorEff = allot > 0 ? (done / allot) * 100 : null;
  const target = rules().efficiencyTargetPct;
  const flaggedWorkers = days.filter((x) => x.eff != null && x.eff < target).length;
  const sections = sectionRows(days, d.jobCards);
  const n = useAttentionCount(ctx);
  const attention = n.alerts + (n.reads ? 1 : 0); // the list below shows waiting photo reads as one line

  return (
    <div className="page fade">
      <PageHead title={`${greeting()}, ${owner().name.split(' ')[0]}`} sub={`${sections.filter((s) => s.open > 0).length} section${sections.filter((s) => s.open > 0).length === 1 ? '' : 's'} running${d.lastSync ? ` · synced ${time(d.lastSync.toISOString())}` : ''}`}>
        <button className="btn" onClick={() => d.refresh()}><Icon name="refresh" size={16} strokeWidth={2} />Refresh</button>
        <button className="btn primary" onClick={() => ctx.openSheet('stock')}><Icon name="plus" size={16} strokeWidth={2} />New entry</button>
      </PageHead>

      <div className="grid-kpi">
        <Kpi label="Stock on hand" value={fmtM(onHand)} sub={`${activeLots} active lots`} />
        <Kpi label="Dispatched today" value={fmtM(today?.out_m ?? 0)} sub={`In today: ${fmtM(today?.in_m ?? 0)}`} />
        <Kpi label="Floor efficiency" value={floorEff == null ? '—' : `${floorEff.toFixed(1)}%`} sub={floorEff == null ? 'No work allotted today' : flaggedWorkers ? `${flaggedWorkers} worker${flaggedWorkers > 1 ? 's' : ''} below ${target}%` : 'Everyone on track'} subTone={flaggedWorkers ? 'warn' : 'good'} />
        <TimeSavedKpi ctx={ctx} />
      </div>

      <div className="grid-split">
        <LiveNow ctx={ctx} />
        <section className="card pad stack-14">
          <div className="card-head"><h2>Needs your attention</h2>{attention > 0 && <Pill tone="bad"><span className="num">{attention}</span></Pill>}</div>
          <AttentionList ctx={ctx} />
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

// ---------------- Stock ledger ----------------
type SavedLot = { lot_id: string; quality: string; design: string; grade: string | null; status: string | null };
type Problem = { target: 'movement' | 'lot'; id: number | string; field: string; message: string };

export function Stock({ ctx }: { ctx: Ctx }) {
  const { d, rate } = ctx;
  const canEdit = can(ctx.role, 'ledger.edit'); // owner only; supervisors never see edit mode
  const [view, setView] = useState<'moves' | 'lots'>('moves');
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const editing = canEdit && mode === 'edit';
  const [filters, setFilters] = useState<LedgerFilterState>(EMPTY_FILTERS);
  const [lotSheet, setLotSheet] = useState<string | null>(null);
  const applied = useDebounced(filters, 300); // typing in search / lot waits 300 ms
  const lg = useLedger(applied, d.lastSync?.getTime());
  const today = d.flow[d.flow.length - 1];
  const lotIds = React.useMemo(() => d.lots.map((l) => l.lot_id), [d.lots]);
  const [lotQ, setLotQ] = useState('');
  const [lotCap, setLotCap] = useState(200);
  const lotRows = React.useMemo(() => {
    const t = lotQ.trim().toLowerCase();
    return t ? d.lots.filter((l) => l.lot_id.toLowerCase().includes(t) || (l.quality ?? '').toLowerCase().includes(t) || (l.design ?? '').toLowerCase().includes(t) || (l.location ?? '').toLowerCase().includes(t)) : d.lots;
  }, [d.lots, lotQ]);

  // ----- edit mode: drafts (only cells that differ), server problems, save -----
  const [drafts, setDrafts] = useState<Drafts>(NO_DRAFTS);
  const [problems, setProblems] = useState<Drafts>(NO_DRAFTS); // same shape: field → message from the last save
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<null | (() => void)>(null); // action waiting on "save or discard?"
  const count = countDrafts(drafts);
  const lotHint = Object.keys(drafts.l).length > 0 && view === 'moves';

  const onEdit = React.useCallback<OnEdit>((kind, id, field, value, orig) => {
    setDrafts((x) => setDraft(x, kind, id, field, value, orig));
    setProblems((x) => (x[kind] as Record<string | number, RowDraft>)[id]?.[field] ? setDraft(x, kind, id, field, '', '') : x);
  }, []);
  const discard = () => { setDrafts(NO_DRAFTS); setProblems(NO_DRAFTS); };

  // Run `action` now, or after the owner saves / discards unsaved changes.
  const guard = (action: () => void) => {
    if (count > 0) setPending(() => action);
    else action();
  };

  // Going to another screen with unsaved edits: ask to save or discard first (page.tsx calls this guard).
  const { setLeaveGuard } = ctx;
  React.useEffect(() => {
    if (!count) { setLeaveGuard(null); return; }
    setLeaveGuard((proceed) => { setPending(() => proceed); return false; });
    return () => setLeaveGuard(null);
  }, [count, setLeaveGuard]);

  // Closing / reloading the tab with unsaved edits: the browser asks.
  React.useEffect(() => {
    if (!count) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [count]);

  const save = async (): Promise<boolean> => {
    if (!count || saving) return !count;
    const changes: { target: 'movement' | 'lot'; id: number | string; field: string; value: string }[] = [];
    let bad = 0;
    for (const [id, row] of Object.entries(drafts.m)) for (const [field, v] of Object.entries(row)) { if (checkCell(field, v ?? '')) bad++; changes.push({ target: 'movement', id: Number(id), field, value: v ?? '' }); }
    for (const [id, row] of Object.entries(drafts.l)) for (const [field, v] of Object.entries(row)) { if (checkCell(field, v ?? '')) bad++; changes.push({ target: 'lot', id, field, value: v ?? '' }); }
    if (bad) {
      d.showToast(`Fix ${bad} highlighted ${bad === 1 ? 'cell' : 'cells'} first. Nothing was saved.`, 'danger');
      (document.querySelector('.se-in[aria-invalid="true"]') as HTMLElement | null)?.focus();
      return false;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/stock/edit', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes }) });
      const data = await res.json().catch(() => ({}));
      if (res.status === 422 && Array.isArray(data.problems)) {
        let p: Drafts = NO_DRAFTS;
        for (const x of data.problems as Problem[]) {
          // A lot problem raised from a movement change shows on that lot's cells.
          p = setDraft(p, x.target === 'lot' ? 'l' : 'm', x.target === 'lot' ? String(x.id) : Number(x.id), x.field, x.message, '');
        }
        setProblems(p);
        d.showToast(data.error || 'Some changes need fixing. Nothing was saved.', 'danger');
        requestAnimationFrame(() => (document.querySelector('.se-in[aria-invalid="true"]') as HTMLElement | null)?.focus());
        return false;
      }
      if (!res.ok) throw new Error(data?.error || 'Could not save. Nothing was changed.');
      lg.patchRows(data.rows ?? [], (data.lots ?? []) as SavedLot[]);
      lg.holdRefresh(); // the data refresh below must not reload the ledger pages
      await d.refresh(); // lots / balances elsewhere stay in sync
      discard();
      const n = Number(data.saved ?? 0);
      d.showToast(n ? `Saved ${n} ${n === 1 ? 'change' : 'changes'}` : 'Nothing changed');
      return true;
    } catch (e) {
      d.showToast(e instanceof Error ? e.message : 'Could not save. Nothing was changed.', 'danger');
      return false;
    } finally {
      setSaving(false);
    }
  };

  // Infinite scroll: load the next page when the end of the table comes into view.
  const endRef = React.useRef<HTMLDivElement | null>(null);
  const { hasMore, loadMore, loading, loadingMore } = lg;
  React.useEffect(() => {
    const el = endRef.current;
    if (!el || !hasMore || loading || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loadMore(); }, { rootMargin: '400px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore, loading, loadingMore]);

  const qs = ledgerParams(applied).toString();
  const exportHref = view === 'lots' ? '/api/stock/export?kind=lots' : `/api/stock/export?kind=challans${qs ? `&${qs}` : ''}`;
  const active = filtersActive(applied);
  const n = (x: number) => x.toLocaleString('en-IN');
  const cols = rate ? 11 : 10;

  return (
    <div className={`page fade ${editing ? 'se-editing' : ''}`}>
      <PageHead title="Stock ledger" sub="Every challan in and out">
        <a className="btn" href={exportHref} download title={view === 'moves' && active ? 'Excel of the filtered rows' : undefined}><Icon name="download" size={16} strokeWidth={2} />Excel</a>
        <button className="btn" onClick={() => ctx.openSheet('import')}><Icon name="upload" size={16} strokeWidth={2} />Import</button>
        <button className="btn primary" onClick={() => ctx.openSheet('stock')}><Icon name="plus" size={16} strokeWidth={2} />Manual entry</button>
      </PageHead>
      <div className="toolbar">
        <Segmented label="View" value={view} onChange={(v) => guard(() => setView(v))} options={[{ value: 'moves', label: 'Movements' }, { value: 'lots', label: 'Lots & balance' }]} />
        {canEdit && (
          <Segmented label="Mode" value={mode} onChange={(v) => (v === 'view' ? guard(() => { discard(); setMode('view'); }) : setMode('edit'))}
            options={[{ value: 'view', label: 'View' }, { value: 'edit', label: <><Icon name="edit" size={13} strokeWidth={2} /> Edit</> }]} />
        )}
        <div className="grow" />
        <span className="t2 small">Today: <span className="num strong">+{fmt(today?.in_m ?? 0)} m</span> in · <span className="num strong">−{fmt(today?.out_m ?? 0)} m</span> out</span>
      </div>
      {editing && (
        <p className="se-note small t2">
          Edit mode: change cells like a sheet, then Save. Meters, direction, lot no. and date can’t be edited here; location has its own Move.
          {view === 'moves' ? ' Quality and design belong to the lot, so changing them on one row changes every row of that lot.' : ''}
        </p>
      )}
      {view === 'moves' ? (
        <>
          <LedgerFilterBar value={filters} onChange={(f) => guard(() => setFilters(f))} facets={lg.facets} lots={lotIds} />
          <div className="lf-count small t2" aria-live="polite">
            {lg.loading ? 'Loading…'
              : lg.total == null ? ''
              : <><span className="num strong">{n(lg.total)}</span> {lg.total === 1 ? 'movement' : 'movements'}{active ? ' match' : ''}{lg.total > lg.rows.length ? <> · showing {n(lg.rows.length)}</> : null}</>}
          </div>
          {lg.error && <div className="alert bad" role="alert">{lg.error}</div>}
          <section className={`card flush ${lg.loading && lg.rows.length ? 'lf-stale' : ''}`}>
            <div className="ledger-scroll">
            <table className={`tbl rtbl ledger-tbl ${editing ? 'se-tbl' : ''}`} onKeyDown={editing ? gridKeyDown : undefined}>
              <thead><tr><th className="r">SR</th><th>Time</th><th>Dir</th><th>Lot · Quality</th><th className="r">Meters</th><th className="r">Taka</th><th className="r d">Grey → Finished</th><th>From (mill · weaver) / To (party)</th><th>Location</th><th>Challan · entry</th>{rate ? <th className="r d">Value ₹</th> : null}</tr></thead>
              <tbody>
                {lg.rows.map((l, i) => (
                  <MoveRow key={l.id} l={l} i={i} rate={rate} editing={editing} canEdit={canEdit} onEdit={onEdit}
                    draft={drafts.m[l.id]} lotDraft={drafts.l[l.lot_id]} probs={problems.m[l.id]} lotProbs={problems.l[l.lot_id]} />
                ))}
                {!lg.rows.length && !lg.loading && <tr><td colSpan={cols} className="muted center">{active ? 'No movements match these filters' : 'No movements yet'}</td></tr>}
              </tbody>
            </table>
            </div>
            {lg.hasMore && (
              <div ref={endRef} className="lf-more">
                <button type="button" className="btn sm" disabled={lg.loadingMore} onClick={() => lg.loadMore()}>{lg.loadingMore ? 'Loading…' : `Load more (${n(Math.max(0, (lg.total ?? 0) - lg.rows.length))} left)`}</button>
              </div>
            )}
          </section>
        </>
      ) : (
        <>
        <div className="lf" role="search" aria-label="Find a lot">
          <label className="lf-search">
            <Icon name="search" size={16} />
            <input type="search" value={lotQ} onChange={(e) => { setLotQ(e.target.value); setLotCap(200); }} placeholder="Search lot, quality, design, location…" aria-label="Search lots" />
          </label>
        </div>
        <div className="lf-count small t2" aria-live="polite"><span className="num strong">{n(lotRows.length)}</span> {lotRows.length === 1 ? 'lot' : 'lots'}{lotRows.length > lotCap ? <> · showing {n(lotCap)}</> : null}</div>
        <section className="card flush">
          <div className="ledger-scroll">
          <table className={`tbl rtbl ${editing ? 'se-tbl' : ''}`} onKeyDown={editing ? gridKeyDown : undefined}>
            <thead><tr><th className="r">S.No</th><th>Lot</th><th>Quality</th><th className={editing ? '' : 'd'}>Design</th><th className={editing ? '' : 'd'}>Grade</th><th className={editing ? '' : 'd'}>Status</th><th>Location</th><th className="r">Balance</th><th className="r">Action</th></tr></thead>
            <tbody>
              {lotRows.slice(0, lotCap).map((l, i) => (
                <LotRow key={l.lot_id} l={l} i={i} editing={editing} onEdit={onEdit} draft={drafts.l[l.lot_id]} probs={problems.l[l.lot_id]} onMove={setLotSheet} />
              ))}
              {!lotRows.length && <tr><td colSpan={9} className="muted center">{lotQ.trim() ? 'No lots match' : 'No lots yet'}</td></tr>}
            </tbody>
          </table>
          </div>
          {lotRows.length > lotCap && (
            <div className="lf-more"><button type="button" className="btn sm" onClick={() => setLotCap((c) => c + 500)}>Show more ({n(lotRows.length - lotCap)} left)</button></div>
          )}
        </section>
        </>
      )}
      {editing && (
        <>
          <datalist id="se-qualities">{lg.facets?.qualities.map((x) => <option key={x} value={x} />)}</datalist>
          <datalist id="se-designs">{lg.facets?.designs.map((x) => <option key={x} value={x} />)}</datalist>
          <datalist id="se-mills">{[...new Set([...d.names.mills, ...d.names.weavers])].map((x) => <option key={x} value={x} />)}</datalist>
          <datalist id="se-parties">{d.names.parties.map((x) => <option key={x} value={x} />)}</datalist>
          <EditBar count={count} saving={saving} onSave={() => { void save(); }} onDiscard={discard} lotHint={lotHint} />
        </>
      )}
      {pending && (
        <UnsavedDialog count={count} saving={saving}
          onCancel={() => setPending(null)}
          onDiscard={() => { const go = pending; setPending(null); discard(); go(); }}
          onSave={async () => { const go = pending; if (await save()) { setPending(null); go(); } else setPending(null); }} />
      )}
      <Sheet open={lotSheet != null} title={lotSheet ? `${lotSheet} · location` : ''} onClose={() => setLotSheet(null)}>
        {lotSheet && <LotLocationPanel ctx={ctx} lotId={lotSheet} onDone={() => setLotSheet(null)} />}
      </Sheet>
    </div>
  );
}

/** One ledger movement. Memoised: typing in one row's cell doesn't re-render the others. */
const MoveRow = React.memo(function MoveRow({ l, i, rate, editing, canEdit, onEdit, draft, lotDraft, probs, lotProbs }: {
  l: LedgerRow; i: number; rate: number | null; editing: boolean; canEdit: boolean; onEdit: OnEdit;
  draft?: RowDraft; lotDraft?: RowDraft; probs?: RowDraft; lotProbs?: RowDraft;
}) {
  const source = <div className="muted tiny">{l.capture_event_id ? 'Photo' : l.imported ? 'Excel' : 'Manual'}</div>;
  if (!editing) {
    return (
      <tr>
        <td data-label="SR" className="r num strong">
          {l.sr_no ?? <span className="muted">—</span>}
          {canEdit && l.edited ? <EditedMarker target="movement" id={l.id} /> : null}
        </td>
        <td data-label="Time" className="num t2">{dayTime(l.ts)}</td>
        <td data-label="Dir"><Pill tone={l.direction === 'IN' ? 'info' : 'warn'}>{l.direction}</Pill></td>
        <td data-label="Lot"><div className="num strong">{l.lot_id}</div><div className="muted small">{l.quality || '—'} · {l.design}</div></td>
        <td data-label="Meters" className="r num">{fmt(l.meters, 1)}</td>
        <td data-label="Taka" className="r num">{l.pieces ?? <span className="muted">—</span>}</td>
        <td data-label="Grey → Finished" className="r num t2 d">{l.direction === 'IN' && (l.grey_meters != null || l.finished_meters != null) ? `${fmt(l.grey_meters, 1)} → ${fmt(l.finished_meters, 1)}` : '—'}</td>
        <td data-label={l.direction === 'IN' ? 'From' : 'To'} className="t2">{l.direction === 'IN' ? <InSource l={l} /> : <span>→ {l.party ?? '—'}</span>}</td>
        <td data-label="Location">{l.location ? <Pill tone={locationTone(l.location)}>{l.location}</Pill> : <span className="muted">—</span>}</td>
        <td data-label="Challan"><div className="num t2">{l.source_doc_id ?? '—'}</div>{source}</td>
        {rate ? <td data-label="Value" className="r num d">{inr(l.meters * rate)}</td> : null}
      </tr>
    );
  }
  const row = `row ${i + 1} (lot ${l.lot_id})`;
  const cell = (field: string, label: string, extra: { num?: boolean; list?: string } = {}) => (
    <EditCell kind="m" id={l.id} field={field} orig={str(l[field as keyof LedgerRow])} draft={draft?.[field]} problem={probs?.[field]} label={`${label} for ${row}`} onEdit={onEdit} {...extra} />
  );
  const lotCell = (field: 'quality' | 'design', label: string, list: string) => (
    <EditCell kind="l" id={l.lot_id} field={field} orig={l[field] ?? ''} draft={lotDraft?.[field]} problem={lotProbs?.[field]} label={`${label} of lot ${l.lot_id} (${row})`}
      onEdit={onEdit} list={list} hint={`Changes ${label.toLowerCase()} for every row of lot ${l.lot_id}`} />
  );
  return (
    <tr className={draft || lotDraft ? 'se-row-changed' : undefined}>
      <td data-label="SR" className="r">{cell('sr_no', 'SR no.', { num: true })}</td>
      <td data-label="Time" className="num t2 se-ro">{dayTime(l.ts)}</td>
      <td data-label="Dir" className="se-ro"><Pill tone={l.direction === 'IN' ? 'info' : 'warn'}>{l.direction}</Pill></td>
      <td data-label="Lot">
        <div className="se-stack">
          <span className="num strong se-ro-text">{l.lot_id}</span>
          {lotCell('quality', 'Quality', 'se-qualities')}
          {lotCell('design', 'Design', 'se-designs')}
          <span className="muted tiny se-lot-hint">Quality · design: whole lot</span>
        </div>
      </td>
      <td data-label="Meters" className="r num se-ro">{fmt(l.meters, 1)}</td>
      <td data-label="Taka" className="r">{cell('pieces', 'Taka (pieces)', { num: true })}</td>
      <td data-label="Grey → Finished" className="r num t2 d se-ro">{l.direction === 'IN' && (l.grey_meters != null || l.finished_meters != null) ? `${fmt(l.grey_meters, 1)} → ${fmt(l.finished_meters, 1)}` : '—'}</td>
      <td data-label={l.direction === 'IN' ? 'Mill · weaver' : 'Party'}>
        {l.direction === 'IN'
          ? <div className="se-stack">{cell('mill_name', 'Mill', { list: 'se-mills' })}{cell('weaver_name', 'Weaver', { list: 'se-mills' })}</div>
          : cell('party', 'Party', { list: 'se-parties' })}
      </td>
      <td data-label="Location" className="se-ro">{l.location ? <Pill tone={locationTone(l.location)}>{l.location}</Pill> : <span className="muted">—</span>}</td>
      <td data-label="Challan"><div className="se-stack">{cell('source_doc_id', 'Challan no.')}{source}</div></td>
      {rate ? <td data-label="Value" className="r num d se-ro">{inr(l.meters * rate)}</td> : null}
    </tr>
  );
});

/** One lot in "Lots & balance". Memoised like MoveRow. */
const LotRow = React.memo(function LotRow({ l, i, editing, onEdit, draft, probs, onMove }: {
  l: Lot; i: number; editing: boolean; onEdit: OnEdit; draft?: RowDraft; probs?: RowDraft; onMove: (lotId: string) => void;
}) {
  const cell = (field: 'quality' | 'design' | 'grade' | 'status', label: string, extra: { list?: string; options?: readonly string[] } = {}) => (
    <EditCell kind="l" id={l.lot_id} field={field} orig={l[field] ?? ''} draft={draft?.[field]} problem={probs?.[field]} label={`${label} of lot ${l.lot_id}`} onEdit={onEdit}
      {...extra} options={extra.options && !extra.options.includes(l[field] ?? '') ? [l[field] ?? '', ...extra.options] : extra.options} />
  );
  return (
    <tr className={editing && draft ? 'se-row-changed' : undefined}>
      <td data-label="S.No" className="r num muted">{i + 1}</td>
      <td data-label="Lot" className="num strong">{l.lot_id}</td>
      {editing ? (
        <>
          <td data-label="Quality">{cell('quality', 'Quality', { list: 'se-qualities' })}</td>
          <td data-label="Design">{cell('design', 'Design', { list: 'se-designs' })}</td>
          <td data-label="Grade">{cell('grade', 'Grade')}</td>
          <td data-label="Status">{cell('status', 'Status', { options: LOT_STATUSES })}</td>
        </>
      ) : (
        <>
          <td data-label="Quality">{l.quality}</td>
          <td data-label="Design" className="t2 d">{l.design}</td>
          <td data-label="Grade" className="d">{l.grade}</td>
          <td data-label="Status" className="d"><Pill tone={l.status === 'active' ? 'good' : l.status === 'hold' ? 'warn' : 'neutral'}>{l.status}</Pill></td>
        </>
      )}
      <td data-label="Location" className={editing ? 'se-ro' : undefined}><div className="loc-cell"><Pill tone={locationTone(l.location)}>{l.location ?? 'Not recorded'}</Pill>{l.location_stage && <span className="muted tiny">{STAGE_LABEL[l.location_stage]} · {dayTime(l.location_ts!)}</span>}</div></td>
      <td data-label="Balance" className={`r num strong ${editing ? 'se-ro' : ''}`}>{fmt(l.balance, 1)} m</td>
      <td data-label="Action" className="r"><button className="btn sm" onClick={() => onMove(l.lot_id)}>{l.location === 'Dispatched' ? 'History' : 'Move'}</button></td>
    </tr>
  );
});

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
