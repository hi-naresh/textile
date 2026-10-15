'use client';

import React, { useState } from 'react';
import Icon from '../Icon';
import { PageHead, Pill, Segmented, Sheet, Track, dayTime, effTone, fmt, inr, initials } from '../ui';
import { LotLocationPanel } from './Shared';
import { LedgerFilterBar } from './StockLedger';
import { EMPTY_FILTERS, filtersActive, ledgerParams, useDebounced, useLedger, type LedgerFilterState, type LedgerRow } from '@/lib/useLedger';
import { EMPTY_LOT_FILTERS, lotParams, useLots, type LotFilterState } from '@/lib/useLots';
import { apiSend, flashWhenReady, useHashLink } from '@/lib/useApi';
import { ConfirmDialog, EditBar, EditCell, EditedMarker, LOT_STATUSES, NO_DRAFTS, UnsavedDialog, checkCell, countDrafts, gridKeyDown, setDraft, str, type Drafts, type OnEdit, type RowDraft } from './StockEdit';
import type { LedgerEntry, Lot } from '@/lib/types';
import type { Ctx } from '../ctx';
import { can } from '@/lib/access';
import { STAGE_LABEL, camStatus } from '@/lib/derive';
import { LocationPill } from '../MarketLocationPicker';
import { ADJUSTMENT_HINT, ADJUSTMENT_LABEL, CLOSING_HINT, CLOSING_LABEL, ENTRY_STATUSES, ENTRY_STATUS_LABEL, L_HINT, PCT_HINT, lotSHint } from '@/lib/registers';
import { EntryStatusPill } from '../EntryStatus';

type SavedLot = { lot_id: string; quality: string; design: string; grade: string | null; status: string | null };
type Problem = { target: 'movement' | 'lot'; id: number | string; field: string; message: string };

export function Stock({ ctx }: { ctx: Ctx }) {
  const { d, rate } = ctx;
  const canEdit = can(ctx.role, 'ledger.edit'); // owner only; supervisors never see edit mode
  const canClosed = can(ctx.role, 'stock.closed'); // owner: Closed lots view
  const [view, setView] = useState<'moves' | 'lots'>('moves');
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const editing = canEdit && mode === 'edit';
  const [filters, setFilters] = useState<LedgerFilterState>(EMPTY_FILTERS);
  const [lotSheet, setLotSheet] = useState<string | null>(null);
  const applied = useDebounced(filters, 300); // typing in search / lot waits 300 ms
  // Lists reload only when stock changed on the server (d.stockRev), not on every app refresh.
  const lg = useLedger(applied, d.stockRev);
  const today = d.flow[d.flow.length - 1];
  // Lots & balance: filtered + paged on the server (GET /api/lots); nothing loads until the view is opened.
  const [lotFilters, setLotFilters] = useState<LotFilterState>(EMPTY_LOT_FILTERS);
  const lotApplied = useDebounced(lotFilters, 250);
  const lt = useLots(lotApplied, d.stockRev, view === 'lots');

  // Deep link: #ledger=<view=moves|lots&q=&lot=&direction=&quality=&design=&party=&from=&to=&focus=>
  const link = useHashLink('ledger');
  const [focus, setFocus] = useState<{ id: string; view: 'moves' | 'lots' } | null>(null);
  const flashCancel = React.useRef<(() => void) | null>(null);
  React.useEffect(() => {
    if (link.value == null) return;
    const p = new URLSearchParams(link.value);
    const g = (k: string) => (p.get(k) ?? '').trim();
    const v = g('view') === 'lots' ? 'lots' : 'moves';
    const dir = g('direction').toUpperCase();
    /* eslint-disable react-hooks/set-state-in-effect -- applying a deep link once per link */
    if (v === 'lots') {
      setLotFilters({ ...EMPTY_LOT_FILTERS, q: g('q') || g('lot') });
    } else {
      setFilters({ ...EMPTY_FILTERS, q: g('q'), lot: g('lot'), direction: dir === 'IN' || dir === 'OUT' ? dir : '', quality: g('quality'), design: g('design'), party: g('party'), from: g('from'), to: g('to') });
    }
    setView(v);
    setFocus(g('focus') ? { id: g('focus'), view: v } : null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [link.n, link.value]);
  // Scroll to + briefly highlight the linked row once its list has loaded.
  const listLoading = view === 'lots' ? lt.loading : lg.loading;
  React.useEffect(() => {
    if (!focus || focus.view !== view || listLoading) return;
    const id = focus.id;
    const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '');
    const sel = view === 'lots' ? `tr[data-lot="${esc}"]` : /^\d+$/.test(id) ? `tr[data-mv="${esc}"], tr[data-lot="${esc}"]` : `tr[data-lot="${esc}"]`;
    flashCancel.current?.();
    flashCancel.current = flashWhenReady(sel, 6000); // polls until the (filtered) rows show the item
    setFocus(null); // eslint-disable-line react-hooks/set-state-in-effect -- one-shot
  }, [focus, view, listLoading]);
  React.useEffect(() => () => flashCancel.current?.(), []);

  // ----- edit mode: drafts (only cells that differ), server problems, save -----
  const [drafts, setDrafts] = useState<Drafts>(NO_DRAFTS);
  const [problems, setProblems] = useState<Drafts>(NO_DRAFTS); // same shape: field → message from the last save
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<null | (() => void)>(null); // action waiting on "save or discard?"
  // Saving a status change that closes / reopens a lot asks first; so do Close lot / Reopen.
  const [statusConfirm, setStatusConfirm] = useState<string[] | null>(null);
  const [lotAction, setLotAction] = useState<{ kind: 'close' | 'reopen'; lot: Lot } | null>(null);
  const [lotNote, setLotNote] = useState('');
  const [lotBusy, setLotBusy] = useState(false);
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

  /** What saving will do to lots: an entry set to End closes its lot; End taken off may reopen it. */
  const statusEffects = (): string[] => {
    const out: string[] = [];
    for (const [id, row] of Object.entries(drafts.m)) {
      const v = row.entry_status;
      if (v === undefined) continue;
      const r = lg.rows.find((x) => x.id === Number(id));
      if (!r) continue;
      if (v === 'end' && r.entry_status !== 'end') out.push(`Lot ${r.lot_id} will close: what is left is written off so its balance is 0, and it leaves current stock.`);
      else if (r.entry_status === 'end' && v !== 'end') out.push(`Lot ${r.lot_id} will reopen if this entry closed it: the closing adjustment is removed and the lot is back in stock.`);
    }
    return out;
  };

  const save = async (confirmed = false): Promise<boolean> => {
    if (!count || saving) return !count;
    if (!confirmed) {
      const fx = statusEffects();
      if (fx.length) { setStatusConfirm(fx); return false; }
    }
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
      lt.patchLots((data.lots ?? []) as Partial<Lot>[]);
      if (!data.reload) { // a lot closed / reopened: let the refresh below reload the lists (closing rows came or went)
        lg.holdRefresh(); // the refresh below must not reload the loaded pages (rows are patched in place)
        lt.holdRefresh();
      }
      await d.refreshStock(); // summary / names / qualities stay in sync (only the small stock snapshot)
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

  const runLotAction = async () => {
    if (!lotAction || lotBusy) return;
    setLotBusy(true);
    try {
      const r = await apiSend<{ adjustment_m?: number; balance?: number }>('/api/lots/close', 'POST', { lot_id: lotAction.lot.lot_id, action: lotAction.kind, note: lotNote.trim() || null });
      d.showToast(lotAction.kind === 'close'
        ? `Lot ${lotAction.lot.lot_id} closed${r.adjustment_m ? ` · ${fmt(Math.abs(r.adjustment_m), 1)} m ${r.adjustment_m > 0 ? 'written off' : 'written back'}` : ''}`
        : `Lot ${lotAction.lot.lot_id} reopened · ${fmt(r.balance ?? 0, 1)} m in stock`);
      setLotAction(null);
      await d.refreshStock(); // stock changed: the lists reload
    } catch (e) {
      d.showToast(e instanceof Error ? e.message : 'Could not save. Nothing was changed.', 'danger');
    } finally {
      setLotBusy(false);
    }
  };
  const askLot = (kind: 'close' | 'reopen', lot: Lot) => { setLotNote(''); setLotAction({ kind, lot }); };

  // Infinite scroll: load the next page when the end of the table comes into view.
  const endRef = React.useRef<HTMLDivElement | null>(null);
  const cur = view === 'lots' ? lt : lg;
  const { hasMore, loadMore, loading, loadingMore } = cur;
  React.useEffect(() => {
    const el = endRef.current;
    if (!el || !hasMore || loading || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loadMore(); }, { rootMargin: '400px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore, loading, loadingMore, view]);

  const qs = ledgerParams(applied).toString();
  const lqs = lotParams(lotApplied).toString();
  const exportHref = view === 'lots' ? `/api/stock/export?kind=lots${lqs ? `&${lqs}` : ''}` : `/api/stock/export?kind=challans${qs ? `&${qs}` : ''}`;
  const active = filtersActive(applied);
  const lotActive = lqs !== '';
  const n = (x: number) => x.toLocaleString('en-IN');
  // "12,345" or, past the count cap, "10,000+"
  const countText = (total: number | null, capped: boolean) => (total == null ? '' : `${n(total)}${capped ? '+' : ''}`);
  const left = (total: number | null, capped: boolean, shown: number) => (capped ? 'more' : `${n(Math.max(0, (total ?? 0) - shown))} left`);
  const cols = rate ? 12 : 11;

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
          Edit mode: change cells like a sheet, then Save. Set a sale’s status (Packed / Running / End) in the Status column; End closes the lot. Meters, direction, lot no. and date can’t be edited here; location has its own Move.
          {view === 'moves' ? ' Quality and design belong to the lot, so changing them on one row changes every row of that lot.' : ''}
        </p>
      )}
      {view === 'moves' ? (
        <>
          <LedgerFilterBar value={filters} onChange={(f) => guard(() => setFilters(f))} facets={lg.facets} />
          <div className="lf-count small t2" aria-live="polite">
            {lg.loading ? (lg.rows.length ? 'Searching…' : 'Loading…')
              : lg.total == null ? ''
              : <><span className="num strong">{countText(lg.total, lg.totalCapped)}</span> {lg.total === 1 && !lg.totalCapped ? 'movement' : 'movements'}{active ? ' match' : ''}{lg.totalCapped || lg.total > lg.rows.length ? <> · showing {n(lg.rows.length)}</> : null}</>}
          </div>
          {lg.error && <div className="alert bad" role="alert">{lg.error}</div>}
          <section className={`card flush ${lg.loading && lg.rows.length ? 'lf-stale' : ''}`}>
            <div className="ledger-scroll">
            <table className={`tbl rtbl ledger-tbl ${editing ? 'se-tbl' : ''}`} onKeyDown={editing ? gridKeyDown : undefined}>
              <thead><tr><th className="r">SR</th><th>Time</th><th>Dir</th><th>Status</th><th>Lot · Quality</th><th className="r">Meters</th><th className="r">Taka</th><th className="r d">Grey → Finished</th><th>From (mill · weaver) / To (party)</th><th>Location</th><th>Challan · entry</th>{rate ? <th className="r d">Value ₹</th> : null}</tr></thead>
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
                <button type="button" className="btn sm" disabled={lg.loadingMore} onClick={() => lg.loadMore()}>{lg.loadingMore ? 'Loading…' : `Load more (${left(lg.total, lg.totalCapped, lg.rows.length)})`}</button>
              </div>
            )}
          </section>
        </>
      ) : (
        <>
        <div className="lf" role="search" aria-label="Find a lot">
          <label className="lf-search">
            <Icon name="search" size={16} />
            <input type="search" value={lotFilters.q} onChange={(e) => { const q = e.target.value; guard(() => setLotFilters((f) => ({ ...f, q }))); }} placeholder="Search lot, quality, design, location…" aria-label="Search lots" />
          </label>
          <div className="lf-row">
            <Segmented label="Stock" value={lotFilters.stock || 'all'} onChange={(v) => guard(() => setLotFilters((f) => ({ ...f, stock: v === 'in' || v === 'closed' ? v : '' })))}
              options={[{ value: 'all', label: 'All lots' }, { value: 'in', label: 'In stock' }, ...(canClosed ? [{ value: 'closed' as const, label: 'Closed' }] : [])]} />
          </div>
        </div>
        <div className="lf-count small t2" aria-live="polite">
          {lt.loading ? (lt.rows.length ? 'Searching…' : 'Loading…')
            : lt.total == null ? ''
            : <><span className="num strong">{countText(lt.total, lt.totalCapped)}</span> {lt.total === 1 && !lt.totalCapped ? 'lot' : 'lots'}{lotActive ? ' match' : ''}{lt.totalCapped || lt.total > lt.rows.length ? <> · showing {n(lt.rows.length)}</> : null}</>}
        </div>
        {lt.error && <div className="alert bad" role="alert">{lt.error}</div>}
        {lotApplied.stock === 'closed' && <p className="small t2">Closed lots are your internal records: they don’t count in stock, and supervisors don’t see them. Each one shows what was written off so its balance is 0.</p>}
        <section className={`card flush ${lt.loading && lt.rows.length ? 'lf-stale' : ''}`}>
          <div className="ledger-scroll">
          {lotApplied.stock === 'closed' ? (
          <table className="tbl rtbl">
            <thead><tr><th className="r">S.No</th><th>Lot</th><th>Quality · design</th><th>Closed</th><th>How</th><th className="r">Written off</th><th className="r">Action</th></tr></thead>
            <tbody>
              {lt.rows.map((l, i) => <ClosedLotRow key={l.lot_id} l={l} i={i} onHistory={setLotSheet} onReopen={(x) => askLot('reopen', x)} />)}
              {!lt.rows.length && !lt.loading && <tr><td colSpan={7} className="muted center">{lotFilters.q ? 'No closed lots match' : 'No closed lots yet'}</td></tr>}
            </tbody>
          </table>
          ) : (
          <table className={`tbl rtbl ${editing ? 'se-tbl' : ''}`} onKeyDown={editing ? gridKeyDown : undefined}>
            <thead><tr><th className="r">S.No</th><th>Lot</th><th>Quality</th><th className={editing ? '' : 'd'}>Design</th><th className={editing ? '' : 'd'}>Grade</th><th className={editing ? '' : 'd'}>Status</th><th>Location</th><th className="r">Balance</th><th className="r">Action</th></tr></thead>
            <tbody>
              {lt.rows.map((l, i) => (
                <LotRow key={l.lot_id} l={l} i={i} editing={editing} onEdit={onEdit} draft={drafts.l[l.lot_id]} probs={problems.l[l.lot_id]} onMove={setLotSheet}
                  onClose={canClosed ? (x) => askLot('close', x) : undefined} />
              ))}
              {!lt.rows.length && !lt.loading && <tr><td colSpan={9} className="muted center">{lotActive ? 'No lots match' : 'No lots yet'}</td></tr>}
            </tbody>
          </table>
          )}
          </div>
          {lt.hasMore && (
            <div ref={endRef} className="lf-more">
              <button type="button" className="btn sm" disabled={lt.loadingMore} onClick={() => lt.loadMore()}>{lt.loadingMore ? 'Loading…' : `Show more (${left(lt.total, lt.totalCapped, lt.rows.length)})`}</button>
            </div>
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
      {statusConfirm && (
        <ConfirmDialog title="Close or reopen lots?" confirmLabel="Save" busy={saving}
          onCancel={() => setStatusConfirm(null)}
          onConfirm={async () => { setStatusConfirm(null); await save(true); }}>
          {statusConfirm.map((x) => <p key={x}>{x}</p>)}
        </ConfirmDialog>
      )}
      {lotAction && (
        <ConfirmDialog busy={lotBusy} danger={lotAction.kind === 'close'} onCancel={() => setLotAction(null)} onConfirm={() => { void runLotAction(); }}
          title={lotAction.kind === 'close' ? `Close lot ${lotAction.lot.lot_id}?` : `Reopen lot ${lotAction.lot.lot_id}?`}
          confirmLabel={lotAction.kind === 'close' ? 'Close lot' : 'Reopen'}
          note={{ label: 'Note (optional)', value: lotNote, onChange: setLotNote }}>
          {lotAction.kind === 'close' ? (
            <>
              <p>{Math.abs(lotAction.lot.balance) < 0.01 ? 'Its balance is already 0.' : lotAction.lot.balance > 0
                ? <><span className="num strong">{fmt(lotAction.lot.balance, 1)} m</span> left in it will be written off, so its balance is 0.</>
                : <><span className="num strong">{fmt(-lotAction.lot.balance, 1)} m</span> sent beyond its balance will be written back, so its balance is 0.</>}</p>
              <p>Its last sale is marked End. The lot leaves current stock and supervisors won’t see it. You can reopen it from Lots &amp; balance → Closed.</p>
            </>
          ) : (
            <p>The closing adjustment{lotAction.lot.adjustment_m ? <> of <span className="num strong">{fmt(Math.abs(lotAction.lot.adjustment_m), 1)} m</span></> : null} is removed, the End entry that closed it becomes Running, and the lot is back in stock.</p>
          )}
        </ConfirmDialog>
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
  const adj = l.kind === 'adjustment';
  const closing = l.kind === 'closing'; // written when the lot closed; owner-only, never editable
  const source = <div className="muted tiny">{adj ? 'Register' : closing ? 'Lot closed' : l.capture_event_id ? 'Photo' : l.imported ? 'Excel' : 'Manual'}</div>;
  if (!editing || adj || closing) {
    return (
      <tr data-mv={l.id} data-lot={l.lot_id} className={adj || closing ? 'mv-adj' : undefined}>
        <td data-label="SR" className="r num strong">
          {l.sr_no ?? (l.linked_sr ? <span className="t2" title="SR.NO: the incoming SR of the lot sold">↳{l.linked_sr}</span> : <span className="muted">—</span>)}
          {canEdit && l.edited ? <EditedMarker target="movement" id={l.id} /> : null}
        </td>
        <td data-label="Time" className="num t2">{dayTime(l.ts)}</td>
        <td data-label="Dir">{adj ? <span title={ADJUSTMENT_HINT}><Pill tone="neutral">ADJ</Pill></span> : closing ? <span title={CLOSING_HINT}><Pill tone="neutral">CLOSE</Pill></span> : <Pill tone={l.direction === 'IN' ? 'info' : 'warn'}>{l.direction}</Pill>}</td>
        <td data-label="Status">{l.direction === 'OUT' && !adj && !closing ? <EntryStatusPill status={l.entry_status} unset /> : <span className="muted">—</span>}</td>
        <td data-label="Lot"><div className="num strong">{l.lot_id}</div><div className="muted small">{l.quality || '—'} · {l.design}</div>{l.reg_lot_no && l.reg_lot_no !== l.lot_id ? <div className="muted tiny">Register lot no. {l.reg_lot_no}</div> : null}</td>
        <td data-label="Meters" className="r num">{adj || (closing && l.direction === 'OUT') ? '−' : closing ? '+' : ''}{fmt(l.meters, 1)}</td>
        <td data-label="Taka" className="r num">{l.pieces ?? <span className="muted">—</span>}</td>
        <td data-label="Grey → Finished" className="r num t2 d">{l.direction === 'IN' && (l.grey_meters != null || l.finished_meters != null) ? `${fmt(l.grey_meters, 1)} → ${fmt(l.finished_meters, 1)}` : '—'}</td>
        <td data-label={adj || closing ? 'What' : l.direction === 'IN' ? 'From' : 'To'} className="t2">
          {adj ? (
            <div className="stack-0" title={ADJUSTMENT_HINT}><span className="adj-label">{ADJUSTMENT_LABEL}</span><span className="muted tiny">Taken out before import (S-1…S-10) · not a sale</span></div>
          ) : closing ? (
            <div className="stack-0" title={CLOSING_HINT}><span className="adj-label">{CLOSING_LABEL}</span><span className="muted tiny">{l.direction === 'OUT' ? 'Left over when the lot closed · written off' : 'Sent beyond what came in · written back'}</span></div>
          ) : l.direction === 'IN'
            ? <div className="stack-0"><InSource l={l} /><RegisterExtras l={l} /></div>
            : <div className="stack-0"><span>→ {l.party ?? <span className="muted">no party</span>}</span><RegisterExtras l={l} /></div>}
        </td>
        <td data-label="Location">{l.location ? <LocationPill location={l.location} /> : <span className="muted">—</span>}</td>
        <td data-label={l.direction === 'OUT' ? 'Bill / challan' : 'Challan'}><div className="num t2">{l.source_doc_id ?? '—'}</div>{source}{editing && (adj || closing) ? <div className="muted tiny">Not editable</div> : null}</td>
        {rate ? <td data-label="Value" className="r num d">{adj || closing ? <span className="muted">—</span> : inr(l.meters * rate)}</td> : null}
      </tr>
    );
  }
  const row = `row ${i + 1} (lot ${l.lot_id})`;
  const cell = (field: string, label: string, extra: { num?: boolean; list?: string; options?: readonly string[]; optionLabels?: Record<string, string> } = {}) => (
    <EditCell kind="m" id={l.id} field={field} orig={str(l[field as keyof LedgerRow])} draft={draft?.[field]} problem={probs?.[field]} label={`${label} for ${row}`} onEdit={onEdit} {...extra} />
  );
  const lotCell = (field: 'quality' | 'design', label: string, list: string) => (
    <EditCell kind="l" id={l.lot_id} field={field} orig={l[field] ?? ''} draft={lotDraft?.[field]} problem={lotProbs?.[field]} label={`${label} of lot ${l.lot_id} (${row})`}
      onEdit={onEdit} list={list} hint={`Changes ${label.toLowerCase()} for every row of lot ${l.lot_id}`} />
  );
  return (
    <tr data-mv={l.id} data-lot={l.lot_id} className={draft || lotDraft ? 'se-row-changed' : undefined}>
      <td data-label="SR" className="r">{cell('sr_no', 'SR no.', { num: true })}</td>
      <td data-label="Time" className="num t2 se-ro">{dayTime(l.ts)}</td>
      {l.direction === 'OUT' ? (
        <>
          <td data-label="Dir" className="se-ro"><Pill tone="warn">OUT</Pill></td>
          <td data-label="Status">{cell('entry_status', 'Status', { options: l.entry_status ? ENTRY_STATUSES : ['', ...ENTRY_STATUSES], optionLabels: { '': 'Not set', ...ENTRY_STATUS_LABEL } })}</td>
        </>
      ) : (
        <>
          <td data-label="Dir" className="se-ro"><Pill tone="info">IN</Pill></td>
          <td data-label="Status" className="se-ro"><span className="muted">—</span></td>
        </>
      )}
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
          ? <div className="se-stack">{cell('mill_name', 'Mill', { list: 'se-mills' })}{cell('weaver_name', 'Weaver', { list: 'se-mills' })}<span className="se-pair">{cell('register_pct', '%', { num: true })}{cell('loc_code', 'Location code')}</span><span className="muted tiny">% · location code</span></div>
          : <div className="se-stack">{cell('party', 'Party', { list: 'se-parties' })}<span className="se-pair">{cell('bill_pct', 'L', { num: true })}{cell('billed_meters', 'NQTY (billed meters)', { num: true })}{cell('lot_status_code', 'LOT S')}</span><span className="muted tiny">L · NQTY · LOT S</span></div>}
      </td>
      <td data-label="Location" className="se-ro">{l.location ? <LocationPill location={l.location} /> : <span className="muted">—</span>}</td>
      <td data-label="Challan"><div className="se-stack">{cell('source_doc_id', 'Challan no.')}{source}</div></td>
      {rate ? <td data-label="Value" className="r num d se-ro">{inr(l.meters * rate)}</td> : null}
    </tr>
  );
});

/** One lot in "Lots & balance". Memoised like MoveRow. */
const LotRow = React.memo(function LotRow({ l, i, editing, onEdit, draft, probs, onMove, onClose }: {
  l: Lot; i: number; editing: boolean; onEdit: OnEdit; draft?: RowDraft; probs?: RowDraft; onMove: (lotId: string) => void;
  onClose?: (lot: Lot) => void; // owner: close the lot by hand
}) {
  const cell = (field: 'quality' | 'design' | 'grade' | 'status', label: string, extra: { list?: string; options?: readonly string[] } = {}) => (
    <EditCell kind="l" id={l.lot_id} field={field} orig={l[field] ?? ''} draft={draft?.[field]} problem={probs?.[field]} label={`${label} of lot ${l.lot_id}`} onEdit={onEdit}
      {...extra} options={extra.options && !extra.options.includes(l[field] ?? '') ? [l[field] ?? '', ...extra.options] : extra.options} />
  );
  return (
    <tr data-lot={l.lot_id} className={editing && draft ? 'se-row-changed' : undefined}>
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
      <td data-label="Location" className={editing ? 'se-ro' : undefined}><div className="loc-cell"><LocationPill location={l.location} />{l.location_stage && <span className="muted tiny">{STAGE_LABEL[l.location_stage]} · {dayTime(l.location_ts!)}</span>}{l.loc_code && <span className="muted tiny" title="Location code from the Incoming register">Loc code {l.loc_code}</span>}</div></td>
      <td data-label="Balance" className={`r num strong ${editing ? 'se-ro' : ''}`}>{fmt(l.balance, 1)} m</td>
      <td data-label="Action" className="r">
        <div className="row-8 lot-acts">
          <button className="btn sm" onClick={() => onMove(l.lot_id)}>{l.location === 'Dispatched' ? 'History' : 'Move'}</button>
          {onClose && !editing && <button className="btn sm" onClick={() => onClose(l)} title="Finish this lot: write off what is left so its balance is 0">Close</button>}
        </div>
      </td>
    </tr>
  );
});

const CLOSE_HOW: Record<string, string> = { end_entry: 'End entry', manual: 'Closed by hand', register: 'Sales register' };

/** One closed lot (owner's Closed lots view): when, how, by whom, and what was written off. */
function ClosedLotRow({ l, i, onHistory, onReopen }: { l: Lot; i: number; onHistory: (lotId: string) => void; onReopen: (lot: Lot) => void }) {
  const adj = l.adjustment_m ?? 0;
  return (
    <tr data-lot={l.lot_id}>
      <td data-label="S.No" className="r num muted">{i + 1}</td>
      <td data-label="Lot" className="num strong">{l.lot_id}</td>
      <td data-label="Quality · design">{l.quality}<div className="muted small">{l.design}</div></td>
      <td data-label="Closed" className="num t2">{l.closed_at ? dayTime(l.closed_at) : '—'}{l.closed_by_name ? <div className="muted tiny">by {l.closed_by_name}</div> : null}</td>
      <td data-label="How">{CLOSE_HOW[l.close_reason ?? ''] ?? '—'}{l.close_note ? <div className="muted tiny">{l.close_note}</div> : null}</td>
      <td data-label="Written off" className="r num" title={adj > 0 ? 'Left over when the lot closed' : adj < 0 ? 'Sent beyond what came in' : 'Balance was already 0'}>
        {Math.abs(adj) < 0.01 ? <span className="muted">0</span> : <>{adj > 0 ? '−' : '+'}{fmt(Math.abs(adj), 1)} m<div className="muted tiny">{adj > 0 ? 'left over' : 'sent extra'}</div></>}
      </td>
      <td data-label="Action" className="r"><div className="row-8 lot-acts"><button className="btn sm" onClick={() => onHistory(l.lot_id)}>History</button><button className="btn sm" onClick={() => onReopen(l)}>Reopen</button></div></td>
    </tr>
  );
}

/** Register fields under From / To: IN → %, location code, S-1…S-10; OUT → bill no., L, NQTY, LOT S (with our guess). */
function RegisterExtras({ l }: { l: LedgerRow }) {
  const bits: React.ReactNode[] = [];
  if (l.direction === 'IN') {
    if (l.register_pct != null) bits.push(<span key="p" title={PCT_HINT}>{fmt(l.register_pct, 2)}%</span>);
    if (l.loc_code) bits.push(<span key="c" title="Location code from the Incoming register">Loc {l.loc_code}</span>);
    const t = (l.takes ?? []).filter((x) => x != null) as number[];
    if (t.length) bits.push(<span key="t" title={`S-1…S-10 in the register: ${(l.takes ?? []).map((x) => (x == null ? '·' : fmt(x, 2))).join(', ')}`}>Taken before import: {fmt(t.reduce((a, b) => a + b, 0), 1)} m ({t.length})</span>);
  } else {
    const reg = l.bill_pct != null || l.billed_meters != null || l.lot_status_code || l.linked_sr;
    if (reg && l.source_doc_id) bits.push(<span key="b">Bill {l.source_doc_id}</span>);
    if (l.bill_pct != null) bits.push(<span key="l" title={L_HINT}>L {fmt(l.bill_pct, 2)}</span>);
    if (l.billed_meters != null) bits.push(<span key="n" title="NQTY in the sales register (billed meters)">Billed {fmt(l.billed_meters, 2)} m</span>);
    if (l.lot_status_code) bits.push(<span key="s">LOT S <abbr className="mv-code" title={lotSHint(l.lot_status_code)} aria-label={lotSHint(l.lot_status_code)} tabIndex={0}>{l.lot_status_code}</abbr></span>);
    if (l.linked_sr) bits.push(<span key="r" title="SR.NO: the incoming SR of the lot sold">SR.NO {l.linked_sr}</span>);
  }
  return bits.length ? <div className="mv-extra muted tiny">{bits}</div> : null;
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
