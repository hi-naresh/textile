'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Icon from '../Icon';
import { Empty, PageHead, Pill, Segmented, Track, dayTime, fmt, inr } from '../ui';
import type { Ctx } from '../ctx';
import { can, captureInScope, inSupervisorScope, jobInScope, sectionName, activeSupervisor, rules, sectionNames, allLocations, markets } from '@/lib/access';
import { formatMarketLocation, parseMarketLocation, validPart } from '@/lib/location';
import { checkImportFile, commitImport, type ImportOutcome, type ImportProgress, type ValidateResult } from '@/lib/stockImportClient';
import { CAPTURE_LABEL, ENGINE_LABEL, FIELDS_FOR, FIELD_LABEL, NUMERIC_FIELDS, OPTIONAL_FIELDS, STAGE_LABEL, STATUS_LABEL, STATUS_TONE, locationTone, shortTone } from '@/lib/derive';
import type { StockEntry } from '@/lib/useTextileData';
import { LotPicker, matchLots } from '../LotPicker';
import type { CaptureEvent, JobCard, LotLocationEntry } from '@/lib/types';

// ---------------- Job cards ----------------
export function JobCards({ ctx }: { ctx: Ctx }) {
  const { d, role, rate } = ctx;
  const [status, setStatus] = useState<'all' | 'open' | 'in-process' | 'closed'>('all');
  const [closing, setClosing] = useState<number | null>(null);
  const [metersOut, setMetersOut] = useState('');
  const manage = can(role, 'jobs.manage');
  const isOwner = role === 'owner';

  const rows = d.jobCards.filter((j) => jobInScope(role, j)).filter((j) => status === 'all' || j.status === status || (status === 'in-process' && j.status === 'folded'));

  const startClose = (j: JobCard) => { setClosing(j.id); setMetersOut(String(j.meters_in)); };
  const submitClose = async (e: React.FormEvent) => {
    e.preventDefault();
    if (closing == null || !metersOut) return;
    if (await d.closeJobCard(role, closing, metersOut)) setClosing(null);
  };

  return (
    <div className="page fade">
      <PageHead title="Job cards" sub="Meters in, meters out and shortage for every process step">
        {manage && <button className="btn primary" onClick={() => ctx.openSheet('job')}><Icon name="plus" size={16} strokeWidth={2} />New job card</button>}
      </PageHead>
      <div className="toolbar">
        <Segmented label="Status" value={status} onChange={setStatus} options={[{ value: 'all', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'in-process', label: 'In process' }, { value: 'closed', label: 'Closed' }]} />
      </div>
      <section className="card flush">
        <table className="tbl rtbl">
          <thead><tr><th>Card</th><th>Lot</th><th>Process</th><th>Worker</th><th className="r">In</th><th className="r">Out</th><th className="r">Shortage</th><th>Status</th>{isOwner && <th className="r d">Loss ₹</th>}{manage && <th className="r">Action</th>}</tr></thead>
          <tbody>
            {rows.map((j) => {
              const loss = j.shortage != null && j.shortage > 0 && rate ? inr(j.shortage * rate) : '—';
              return (
                <React.Fragment key={j.id}>
                  <tr>
                    <td data-label="Card" className="num strong">JC-{j.id}</td>
                    <td data-label="Lot" className="num">{j.lot_id}</td>
                    <td data-label="Process">{j.process}</td>
                    <td data-label="Worker" className="t2">{j.worker_name}</td>
                    <td data-label="In" className="r num">{fmt(j.meters_in, 1)}</td>
                    <td data-label="Out" className="r num">{j.meters_out == null ? '—' : fmt(j.meters_out, 1)}</td>
                    <td data-label="Shortage" className="r"><Pill tone={j.meters_out == null ? 'neutral' : shortTone(j.shortage_pct)}><span className="num">{j.meters_out == null ? '—' : `${j.shortage_pct.toFixed(1)}%`}</span></Pill></td>
                    <td data-label="Status"><Pill tone={STATUS_TONE[j.status]}>{STATUS_LABEL[j.status]}</Pill></td>
                    {isOwner && <td data-label="Loss ₹" className="r num d">{loss}</td>}
                    {manage && <td data-label="Action" className="r">{j.status !== 'closed' ? <button className="btn sm" onClick={() => startClose(j)}>Close</button> : <span className="muted small">{j.ts_closed ? dayTime(j.ts_closed) : ''}</span>}</td>}
                  </tr>
                  {closing === j.id && (
                    <tr className="inline-row">
                      <td colSpan={manage ? 10 : 9}>
                        <form className="inline-form" onSubmit={submitClose}>
                          <label className="fld inline">Meters out for JC-{j.id}
                            <input className="num" inputMode="decimal" value={metersOut} onChange={(e) => setMetersOut(e.target.value)} autoFocus />
                          </label>
                          <span className="muted small">In: {fmt(j.meters_in, 1)} m · shortage over {rules().shortageLimitPct}% gets flagged</span>
                          <div className="grow" />
                          <button type="button" className="btn sm" onClick={() => setClosing(null)}>Cancel</button>
                          <button type="submit" className="btn sm primary"><Icon name="check" size={14} strokeWidth={2} />Close card</button>
                        </form>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {!rows.length && <tr><td colSpan={10} className="muted center">No job cards in your view</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}

// ---------------- Review queue ----------------
function fieldValue(v: unknown) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return fmt(v, 2);
  return String(v);
}

/** Whole seconds since a timestamp (null if unknown). Called from event handlers only. */
function secondsSince(t: number | undefined): number | null {
  return t ? Math.round((Date.now() - t) / 1000) : null;
}

/** Photo reads waiting for a check. Lives in the bell's "Needs your attention" panel (Review queue tab). */
export function ReviewQueue({ ctx }: { ctx: Ctx }) {
  const { d, role } = ctx;
  const pending = useMemo(() => d.captures.filter((c) => c.status === 'pending' && captureInScope(role, c.type)), [d.captures, role]);
  const [selId, setSelId] = useState<number | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [badImg, setBadImg] = useState<Record<number, boolean>>({});
  const sel: CaptureEvent | undefined = pending.find((c) => c.id === selId) ?? pending[0];
  // Time spent on each read (for the time-saved figure): from when it was first shown to confirm/reject.
  const shownAt = React.useRef<Record<number, number>>({});
  useEffect(() => { if (sel && !shownAt.current[sel.id]) shownAt.current[sel.id] = Date.now(); }, [sel]);
  const reviewSeconds = () => (sel ? secondsSince(shownAt.current[sel.id]) : null);
  const editing = !!sel && editId === sel.id;
  const setEditing = (on: boolean) => setEditId(on && sel ? sel.id : null);
  const imgOk = !!sel && !badImg[sel.id];
  const setImgOk = (ok: boolean) => { if (sel) setBadImg((b) => ({ ...b, [sel.id]: !ok })); };

  if (!pending.length) {
    return (
      <Empty title="Queue clear" text="Every photo read in your scope has been handled."><button className="btn sm" onClick={() => d.refresh()}><Icon name="refresh" size={14} />Check again</button></Empty>
    );
  }

  const conf = Math.round((sel!.confidence ?? 0) * 100);
  const auto = rules().aiAutoConfirmPct;
  const tone = conf >= auto + 5 ? 'good' : conf >= auto ? 'warn' : 'bad';
  const data = (sel!.ai_json ?? {}) as Record<string, unknown>;
  const base = FIELDS_FOR[sel!.type] as readonly string[];
  // Older incoming reads used `meters` + `party` (supplier); show them so nothing is hidden.
  const legacy = sel!.type === 'incoming_stock' ? ['meters', 'party'].filter((k) => fieldValue(data[k]) != null) : [];
  const keys = [...base, ...legacy];
  const label = (k: string) => (sel!.type === 'incoming_stock' && k === 'party' ? 'Supplier (old read → mill)' : sel!.type === 'incoming_stock' && k === 'meters' ? 'Meters (old read)' : FIELD_LABEL[k] ?? k);
  const hasQty = sel!.type !== 'incoming_stock' || ['grey_meters', 'finished_meters', 'meters'].some((k) => fieldValue(data[k]) != null);
  const missing = [...base.filter((k) => !OPTIONAL_FIELDS.has(k) && fieldValue(data[k]) == null), ...(hasQty ? [] : ['grey or finished meters'])];

  const startEdit = () => {
    const x: Record<string, string> = {};
    keys.forEach((k) => { x[k] = data[k] == null ? '' : String(data[k]); });
    setDraft(x);
    setEditing(true);
  };
  const act = async (fn: () => Promise<boolean>) => { setBusy(true); const ok = await fn(); setBusy(false); if (ok) setSelId(null); };
  const confirm = () => {
    if (!editing) return act(() => d.confirmCapture(role, sel!, undefined, reviewSeconds()));
    const out: Record<string, unknown> = { ...data };
    keys.forEach((k) => {
      const v = draft[k]?.trim();
      out[k] = v === '' ? null : NUMERIC_FIELDS.has(k) && !Number.isNaN(Number(v.replace(/,/g, ''))) ? Number(v.replace(/,/g, '')) : v;
    });
    return act(() => d.confirmCapture(role, sel!, out, reviewSeconds()));
  };

  return (
    <div className="stack-12">
      <span className="muted small">Photo reads waiting for a check before they reach the ledger.</span>
      <div className="review in-panel">
        <div className="review-list">
          <span className="eyebrow mob-only">Up next</span>
          {pending.map((c) => {
            const p = Math.round(c.confidence * 100);
            return (
              <button key={c.id} className={`q ${sel?.id === c.id ? 'on' : ''}`} onClick={() => setSelId(c.id)}>
                <div className="q-top"><span className="num strong small grow">#{c.id} · {String((c.ai_json as Record<string, unknown> | null)?.lot_id ?? 'Lot ?')}</span><Pill tone={p >= rules().aiAutoConfirmPct + 5 ? 'good' : p >= rules().aiAutoConfirmPct ? 'warn' : 'bad'}><span className="num">{p}%</span></Pill></div>
                <span className="strong">{CAPTURE_LABEL[c.type]}</span>
                <span className="muted small">{dayTime(c.ts)}</span>
              </button>
            );
          })}
        </div>
        <section className="card review-detail">
          <div className="photo review-photo">
            {sel!.photo_url && imgOk ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={sel!.photo_url} alt={`Photo of ${CAPTURE_LABEL[sel!.type]}`} onError={() => setImgOk(false)} />
            ) : null}
            <Pill className="photo-tag">{!sel!.photo_url ? 'Photo is being saved…' : imgOk ? CAPTURE_LABEL[sel!.type] : 'Photo not available'}</Pill>
          </div>
          <div className="stack-16">
            <div className="card-head"><h2>{CAPTURE_LABEL[sel!.type]}</h2><Pill tone={tone}><span className="num">{conf}%</span> overall</Pill></div>
            <span className="muted small" style={{ marginTop: -8 }}>Read #{sel!.id} · {dayTime(sel!.ts)}{sel!.read_engine ? ` · ${ENGINE_LABEL[sel!.read_engine] ?? sel!.read_engine}` : ''}</span>
            <div className="bar-row"><Track pct={conf} tone={tone} /><span className="num small">{conf}%</span></div>
            <div className="fields">
              {keys.map((k) => {
                const v = fieldValue(data[k]);
                const required = !OPTIONAL_FIELDS.has(k) && !legacy.includes(k);
                return (
                  <div key={k} className={`field-row ${v == null && required ? 'miss' : ''}`}>
                    <span className="t2 small">{label(k)}</span>
                    {editing ? (
                      <input className="input num" aria-label={label(k)} inputMode={NUMERIC_FIELDS.has(k) ? 'decimal' : undefined} value={draft[k] ?? ''} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
                    ) : (
                      <span className={`num ${v == null ? 'muted' : 'strong'}`}>{v ?? (required ? 'Not read' : '—')}</span>
                    )}
                  </div>
                );
              })}
            </div>
            {(conf < auto || missing.length > 0) && !editing && (
              <div className="alert bad">{missing.length ? `Could not read: ${missing.map((m) => FIELD_LABEL[m] ?? m).join(', ')}. ` : ''}{conf < auto ? `Confidence is under ${auto}%. ` : ''}Check against the photo before confirming.</div>
            )}
            <div className="actions">
              <button className="btn danger" disabled={busy} onClick={() => act(() => d.rejectCapture(role, sel!, reviewSeconds()))}>Reject</button>
              {editing ? <button className="btn" disabled={busy} onClick={() => setEditing(false)}>Cancel edit</button> : <button className="btn" disabled={busy} onClick={startEdit}>Correct fields</button>}
              <div className="grow" />
              <button className="btn primary" disabled={busy} onClick={confirm}><Icon name="check" size={16} strokeWidth={2} />{editing ? 'Save & confirm' : 'Confirm to ledger'}</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------------- Allot work / new job card ----------------
export function AllotForm({ ctx, onDone }: { ctx: Ctx; onDone?: () => void }) {
  const { d, role } = ctx;
  const workers = d.workers.filter((w) => role === 'owner' || inSupervisorScope(w.section));
  const processes = role === 'owner' ? sectionNames() : sectionNames().filter((s) => activeSupervisor().sections.includes(s));
  const lots = d.lots.filter((l) => l.status !== 'dispatched' && l.balance > 0);
  const [workerId, setWorkerId] = useState('');
  const [lotId, setLotId] = useState('');
  const [process, setProcess] = useState('');
  const [meters, setMeters] = useState('');
  const [shift, setShift] = useState<'Morning' | 'Evening' | 'Night'>('Morning');
  const [busy, setBusy] = useState(false);

  const w = workers.find((x) => x.id === workerId) ?? workers[0];
  const proc = process || (w && processes.includes(sectionName(w.section)) ? sectionName(w.section) : processes[0]);
  const lot = lotId || (lots.length <= 60 ? lots[0]?.lot_id ?? '' : '');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!w || !lot || !meters) { d.showToast('Pick a worker, a lot and meters.', 'warning'); return; }
    if (!lots.some((l) => l.lot_id === lot.trim())) { d.showToast(`${lot.trim()} is not a lot with stock. Pick one from the list.`, 'warning'); return; }
    setBusy(true);
    const ok = await d.createJobCard(role, { lot_id: lot, process: proc, worker_id: w.id, meters_in: meters, shift }, w.name);
    setBusy(false);
    if (ok) { setMeters(''); onDone?.(); }
  };

  return (
    <form className="stack-16" onSubmit={submit}>
      <label className="fld">Worker
        <select value={w?.id ?? ''} onChange={(e) => setWorkerId(e.target.value)}>
          {workers.map((x) => <option key={x.id} value={x.id}>{x.name} · {sectionName(x.section)}</option>)}
        </select>
      </label>
      <label className="fld">Lot
        <LotPicker lots={lots} value={lot} onChange={setLotId} />
      </label>
      <label className="fld">Process
        <select value={proc} onChange={(e) => setProcess(e.target.value)}>
          {processes.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>
      <label className="fld">Meters
        <input className="num" inputMode="decimal" placeholder="e.g. 300" value={meters} onChange={(e) => setMeters(e.target.value)} />
      </label>
      <div className="fld">Shift
        <Segmented label="Shift" value={shift} onChange={setShift} className="fit" options={[{ value: 'Morning', label: 'Morning' }, { value: 'Evening', label: 'Evening' }, { value: 'Night', label: 'Night' }]} />
      </div>
      <button className="btn primary big" type="submit" disabled={busy}>{meters ? `Allot ${fmt(Number(meters) || 0)} m` : 'Allot work'}</button>
    </form>
  );
}

export function Allot({ ctx }: { ctx: Ctx }) {
  const { d, role } = ctx;
  const inScope = (workerId: string) => {
    const w = d.workers.find((x) => x.id === workerId);
    return role === 'owner' || (w ? inSupervisorScope(w.section) : false);
  };
  const today = d.allotments.filter((a) => a.is_today && inScope(a.worker_id));
  return (
    <div className="page fade">
      <PageHead title="Allot work" sub="Create a job card and assign its meters to one of your workers" />
      <div className="grid-form">
        <section className="card pad"><AllotForm ctx={ctx} /></section>
        <section className="card flush">
          <div className="card-head pad-x"><h2>Today’s allotments</h2><span className="muted small num">{fmt(today.reduce((s, a) => s + a.meters_allotted, 0))} m</span></div>
          <table className="tbl rtbl">
            <thead><tr><th>Worker</th><th>Card</th><th>Process</th><th className="r">Meters</th><th>Shift</th></tr></thead>
            <tbody>
              {today.map((a) => (
                <tr key={a.id}>
                  <td data-label="Worker" className="strong">{a.worker_name}</td>
                  <td data-label="Card" className="num">JC-{a.job_card_id} · {a.lot_id}</td>
                  <td data-label="Process" className="t2">{a.process}</td>
                  <td data-label="Meters" className="r num">{fmt(a.meters_allotted)}</td>
                  <td data-label="Shift"><Pill>{a.shift}</Pill></td>
                </tr>
              ))}
              {!today.length && <tr><td colSpan={5} className="muted center">Nothing allotted yet today</td></tr>}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

// ---------------- Manual stock entry (owner) ----------------
const EMPTY_ENTRY: StockEntry = { direction: 'IN', lot_id: '', grey_meters: '', finished_meters: '', mill_name: '', weaver_name: '', location: 'Godown', quality: '', design: '', meters: '', party: '', source_doc: '', sr_no: '', pieces: '' };

interface SrInfo { next: number; taken?: { lot_id: string; ts: string } | null; sr?: number }

export function StockForm({ ctx, onDone, initialDirection = 'IN' }: { ctx: Ctx; onDone?: () => void; initialDirection?: 'IN' | 'OUT' }) {
  const { d, role } = ctx;
  const [f, setF] = useState<StockEntry>({ ...EMPTY_ENTRY, direction: initialDirection });
  const [sameAsMill, setSameAsMill] = useState(false);
  const [busy, setBusy] = useState(false);
  const [srTouched, setSrTouched] = useState(false);
  const [sr, setSr] = useState<SrInfo | null>(null);
  const [round, setRound] = useState(0); // bumps after each save: fresh SR suggestion + reset location picker
  const known = d.lots.find((l) => l.lot_id === f.lot_id.trim());
  const lotMatches = useMemo(() => matchLots(d.lots, f.lot_id), [d.lots, f.lot_id]);
  const set = (k: keyof StockEntry) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const isIn = f.direction === 'IN';
  const grey = parseFloat(f.grey_meters);
  const fin = parseFloat(f.finished_meters);
  const diff = Number.isFinite(grey) && Number.isFinite(fin) && grey > 0 ? ((grey - fin) / grey) * 100 : null;

  // Suggest the next SR no. (last + 1) for this direction; the person can still type another.
  useEffect(() => {
    let alive = true;
    fetch(`/api/stock/next-sr?direction=${f.direction}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((x: SrInfo | null) => {
        if (!alive || !x) return;
        setSr({ next: x.next });
        if (!srTouched) setF((cur) => (cur.direction === f.direction ? { ...cur, sr_no: String(x.next) } : cur));
      })
      .catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on direction change / after a save
  }, [f.direction, round]);

  // Typed SR no.: check it is free (debounced).
  const srText = f.sr_no.trim();
  useEffect(() => {
    if (!srTouched || !/^\d{1,9}$/.test(srText)) return;
    let alive = true;
    const t = setTimeout(() => {
      fetch(`/api/stock/next-sr?direction=${f.direction}&sr=${srText}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((x: SrInfo | null) => { if (alive && x) setSr(x); })
        .catch(() => {});
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [srText, srTouched, f.direction]);
  const srTaken = sr?.taken && String(sr.sr) === srText ? sr.taken : null;
  const srBad = srText !== '' && !/^\d{1,9}$/.test(srText);
  const piecesBad = f.pieces.trim() !== '' && !/^\d{1,7}$/.test(f.pieces.trim());

  const switchDirection = (v: 'IN' | 'OUT') => { setSrTouched(false); setSr(null); setF({ ...f, direction: v, sr_no: '' }); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const entry = { ...f, lot_id: f.lot_id.trim(), weaver_name: sameAsMill ? f.mill_name : f.weaver_name };
    if (!entry.lot_id) return d.showToast('Lot number is required.', 'warning');
    if (srBad || entry.sr_no.trim() === '0') return d.showToast('SR no. must be a whole number above 0.', 'warning');
    if (srTaken) return d.showToast(`SR no. ${srText} is already used. Next free: ${sr?.next}.`, 'warning');
    if (piecesBad) return d.showToast('Pieces (taka) must be a whole number.', 'warning');
    if (isIn && !entry.grey_meters && !entry.finished_meters) return d.showToast('Enter grey meters or finished meters.', 'warning');
    if (isIn && !entry.mill_name.trim()) return d.showToast('Mill name is required.', 'warning');
    if (isIn && !entry.location) return d.showToast('Pick a location. For a market, type the shop number.', 'warning');
    if (isIn && !known && (!entry.quality.trim() || !entry.design.trim())) return d.showToast('New lot: enter quality and design.', 'warning');
    if (!isIn && (!entry.meters || !entry.party.trim())) return d.showToast('Meters and party (client) are required.', 'warning');
    setBusy(true);
    const ok = await d.addStock(role, entry);
    setBusy(false);
    if (ok) { setF({ ...EMPTY_ENTRY, direction: f.direction }); setSameAsMill(false); setSrTouched(false); setRound((r) => r + 1); onDone?.(); }
    else setRound((r) => r + (srTouched ? 0 : 1)); // e.g. someone else took the SR no. meanwhile: suggest a fresh one
  };

  const srField = (
    <label className="fld">SR no.
      <input className="num" inputMode="numeric" value={f.sr_no} aria-invalid={srBad || !!srTaken}
        onChange={(e) => { setSrTouched(true); setF({ ...f, sr_no: e.target.value }); }} placeholder={sr ? String(sr.next) : ''} />
      {srBad ? <span className="err small">Whole number only, e.g. 1542.</span> : srTaken ? (
        <span className="sr-note bad">Used on {srTaken.lot_id} ({srTaken.ts}). <button type="button" className="linkbtn" onClick={() => { setSrTouched(false); setF({ ...f, sr_no: String(sr!.next) }); }}>Use {sr!.next}</button></span>
      ) : (
        <span className="sr-note">{srTouched && sr && srText !== String(sr.next) ? <>Next in register: {sr.next}</> : 'From your paper register'}</span>
      )}
    </label>
  );
  const piecesField = (
    <label className="fld">Pieces (taka)<input className="num" inputMode="numeric" value={f.pieces} aria-invalid={piecesBad} onChange={(e) => setF({ ...f, pieces: e.target.value })} placeholder="optional" />{piecesBad && <span className="err small">Whole number only, e.g. 12.</span>}</label>
  );

  return (
    <form className="stack-16" onSubmit={submit}>
      <div className="fld">Direction
        <Segmented label="Direction" value={f.direction} onChange={switchDirection} className="fit" options={[{ value: 'IN', label: 'Incoming (IN)' }, { value: 'OUT', label: 'Outgoing (OUT)' }]} />
      </div>
      <div className="two-col sr-row">
        {srField}
        <label className="fld">Lot number
          <input className="num" list="lot-list" value={f.lot_id} onChange={set('lot_id')} placeholder="e.g. LOT-5030" autoComplete="off" />
          <datalist id="lot-list">{lotMatches.map((l) => <option key={l.lot_id} value={l.lot_id}>{l.quality}</option>)}</datalist>
        </label>
      </div>
      {known && <span className="muted small hint">{known.lot_id}: {known.quality} · balance {fmt(known.balance, 1)} m{known.location ? ` · at ${known.location}` : ''}</span>}

      {isIn ? (
        <>
          <div className="two-col">
            <label className="fld">Grey meters<input className="num" inputMode="decimal" value={f.grey_meters} onChange={set('grey_meters')} placeholder="0.0" /></label>
            <label className="fld">Finished meters<input className="num" inputMode="decimal" value={f.finished_meters} onChange={set('finished_meters')} placeholder="0.0" /></label>
          </div>
          <span className="muted small hint">Stock is counted in finished meters (grey if finished isn’t known yet).{diff != null ? ` Grey → finished difference: ${diff.toFixed(1)}%.` : ''}</span>
          <div className="two-col">
            {piecesField}
            <label className="fld">Challan no.<input className="num" value={f.source_doc} onChange={set('source_doc')} /></label>
          </div>
          <label className="fld">Mill name
            <input list="mill-list" value={f.mill_name} onChange={set('mill_name')} autoComplete="off" />
            <datalist id="mill-list">{d.names.mills.map((n) => <option key={n} value={n} />)}</datalist>
          </label>
          <div className="fld">
            <label htmlFor="weaver">Weaver name</label>
            <input id="weaver" list="weaver-list" value={sameAsMill ? f.mill_name : f.weaver_name} onChange={set('weaver_name')} disabled={sameAsMill} autoComplete="off" />
            <datalist id="weaver-list">{d.names.weavers.map((n) => <option key={n} value={n} />)}</datalist>
            <label className="check"><input type="checkbox" checked={sameAsMill} onChange={(e) => setSameAsMill(e.target.checked)} />Same as mill</label>
          </div>
          <div className="fld">Location on arrival
            <LocationPicker key={round} value={f.location} onChange={(v) => setF((cur) => ({ ...cur, location: v }))} />
          </div>
          {!known && f.lot_id.trim() && (
            <div className="two-col">
              <label className="fld">Quality (new lot)<input name="quality" value={f.quality} onChange={set('quality')} /></label>
              <label className="fld">Design (new lot)<input name="design" value={f.design} onChange={set('design')} /></label>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="two-col">
            <label className="fld">Meters<input className="num" inputMode="decimal" value={f.meters} onChange={set('meters')} placeholder="0.0" /></label>
            {piecesField}
          </div>
          <label className="fld">Party (client receiving the goods)
            <input list="party-list" value={f.party} onChange={set('party')} autoComplete="off" />
            <datalist id="party-list">{d.names.parties.map((n) => <option key={n} value={n} />)}</datalist>
          </label>
          <label className="fld">Dispatch challan / invoice no.<input className="num" value={f.source_doc} onChange={set('source_doc')} /></label>
          {known && <span className="muted small hint">If this empties the lot, its location becomes “Dispatched”.</span>}
        </>
      )}
      <button className="btn primary big" type="submit" disabled={busy}>{isIn ? 'Record incoming' : 'Record dispatch'}</button>
    </form>
  );
}

// ---------------- Lot location ----------------

/**
 * A place from the firm's fixed list (My firm → Markets & locations), or a market address:
 * market + shop no. + pipe no. (optional) → "RRTM 245 · Pipe 3". "Dispatched" is set by the system.
 * onChange gets "" while a market address is incomplete. Remount (key) to reset it.
 */
export function LocationPicker({ value, onChange, exclude }: { value: string; onChange: (v: string) => void; exclude?: string | null }) {
  const list = allLocations().filter((l) => l !== exclude);
  const mks = markets();
  const parsed = value ? parseMarketLocation(value, mks) : null;
  const [mode, setMode] = useState<'fixed' | 'market'>(parsed ? 'market' : 'fixed');
  const [market, setMarket] = useState(parsed?.market ?? mks[0] ?? '');
  const [shop, setShop] = useState(parsed?.shop ?? '');
  const [pipe, setPipe] = useState(parsed?.pipe ?? '');
  const shopOk = validPart(shop);
  const pipeOk = !pipe.trim() || validPart(pipe);
  const address = market && shopOk && pipeOk ? formatMarketLocation(market, shop.trim().toUpperCase(), pipe.trim().toUpperCase() || null) : '';
  const same = !!address && address === exclude;

  const emit = (m: string, s: string, p: string) => {
    const ok = m && validPart(s) && (!p.trim() || validPart(p));
    onChange(ok ? formatMarketLocation(m, s.trim().toUpperCase(), p.trim().toUpperCase() || null) : '');
  };

  return (
    <div className="stack-10">
      <div role="group" aria-label="Location" className="loc-opts">
        {list.map((l) => (
          <button key={l} type="button" className={`opt ${mode === 'fixed' && value === l ? 'on' : ''}`} aria-pressed={mode === 'fixed' && value === l} onClick={() => { setMode('fixed'); onChange(l); }}>{l}</button>
        ))}
        {mks.length > 0 && (
          <button type="button" className={`opt ${mode === 'market' ? 'on' : ''}`} aria-pressed={mode === 'market'} aria-label="Market: shop and pipe number" onClick={() => { setMode('market'); emit(market, shop, pipe); }}>
            Market<span className="opt-sub">shop · pipe</span>
          </button>
        )}
      </div>
      {mode === 'market' && mks.length > 0 && (
        <div className="loc-market">
          <label className="fld">Market
            <select value={market} onChange={(e) => { setMarket(e.target.value); emit(e.target.value, shop, pipe); }}>
              {mks.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="fld">Shop no.
            <input className="num" value={shop} onChange={(e) => { setShop(e.target.value); emit(market, e.target.value, pipe); }} placeholder="e.g. 245" autoComplete="off" aria-invalid={shop !== '' && !shopOk} />
          </label>
          <label className="fld">Pipe no.
            <input className="num" value={pipe} onChange={(e) => { setPipe(e.target.value); emit(market, shop, e.target.value); }} placeholder="optional" autoComplete="off" aria-invalid={!pipeOk} />
          </label>
          <span className={`loc-preview small ${(shop && !shopOk) || !pipeOk || same ? 'bad' : ''}`}>
            {!shop.trim() ? 'Type the shop number.'
              : !shopOk ? 'Shop no.: letters, digits, "-" or "/" only (up to 12).'
              : !pipeOk ? 'Pipe no.: letters, digits, "-" or "/" only (up to 12).'
              : same ? `Already at ${address}.`
              : <>Saved as <span className="strong">{address}</span></>}
          </span>
        </div>
      )}
    </div>
  );
}

export function LotLocationPanel({ ctx, lotId, onDone }: { ctx: Ctx; lotId: string; onDone?: () => void }) {
  const { d, role } = ctx;
  const lot = d.lots.find((l) => l.lot_id === lotId);
  const [history, setHistory] = useState<LotLocationEntry[] | null>(null);
  const [loc, setLoc] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const canMove = role === 'owner'; // supervisors move lots only through job cards (see MATRIX)

  useEffect(() => {
    let alive = true;
    d.lotHistory(lotId).then((h) => { if (alive) setHistory(h); }).catch(() => { if (alive) setHistory([]); });
    return () => { alive = false; };
  }, [d, lotId, lot?.location_ts]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loc.trim()) return d.showToast('Pick a location. For a market, type the shop number.', 'warning');
    if (loc.trim() === lot?.location) return d.showToast(`${lotId} is already at ${loc.trim()}.`, 'warning');
    setBusy(true);
    const ok = await d.moveLot(role, lotId, loc.trim(), note.trim());
    setBusy(false);
    if (ok) { setNote(''); onDone?.(); }
  };

  return (
    <div className="stack-16">
      <div className="card pad stack-6 flat">
        <span className="muted small">Now at</span>
        <span className="loc-now"><Pill tone={locationTone(lot?.location ?? null)} className="tall">{lot?.location ?? 'Not recorded'}</Pill>{lot?.location_ts && <span className="muted small">since {dayTime(lot.location_ts)}</span>}</span>
        {lot && <span className="muted small">{lot.quality} · {fmt(lot.balance, 1)} m in stock</span>}
      </div>
      {canMove && lot?.location !== 'Dispatched' && (
        <form className="stack-12" onSubmit={submit}>
          <span className="fld">Move to</span>
          <LocationPicker value={loc} onChange={setLoc} exclude={lot?.location} />
          <label className="fld">Note (optional)<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. for cutting, customer viewing" /></label>
          <button className="btn primary big" type="submit" disabled={busy}>{loc ? `Move to ${loc}` : 'Move lot'}</button>
        </form>
      )}
      <div className="stack-10">
        <span className="eyebrow">History</span>
        {history == null && <span className="muted small">Loading…</span>}
        {history && !history.length && <span className="muted small">No moves recorded yet.</span>}
        <ol className="timeline">
          {history?.map((h) => (
            <li key={h.id}>
              <span className={`tl-dot ${locationTone(h.location)}`} />
              <div className="stack-2">
                <span className="strong">{h.location} <span className="muted small">· {STAGE_LABEL[h.stage] ?? h.stage}</span></span>
                {h.note && <span className="t2 small">{h.note}</span>}
                <span className="muted tiny">{dayTime(h.ts)}{h.moved_by_name ? ` · ${h.moved_by_name}` : ''}</span>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

// ---------------- Excel import (owner) ----------------
// 1. Check: the server reads the file and lists every problem (header + rows). Nothing is saved.
// 2. Import: checked rows go back in chunks of 500, each saved all-or-nothing, with a progress bar.
type ImportPhase =
  | { k: 'pick' }
  | { k: 'checking'; name: string }
  | { k: 'checked'; name: string; r: ValidateResult }
  | { k: 'importing'; name: string; r: ValidateResult; p: ImportProgress }
  | { k: 'done'; name: string; r: ValidateResult; out: ImportOutcome };

const n0 = (n: number) => n.toLocaleString('en-IN');

function problemsCsv(r: ValidateResult) {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines = ['Row,Column,Problem', ...r.headerProblems.map((h) => `header,${esc(h.column)},${esc(h.message)}`), ...r.problems.map((p) => `${p.row},${esc(p.field)},${esc(p.message)}`)];
  return URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
}

export function StockImport({ ctx, onDone }: { ctx: Ctx; onDone?: () => void }) {
  const { d } = ctx;
  const [ph, setPh] = useState<ImportPhase>({ k: 'pick' });
  const [inputKey, setInputKey] = useState(0);
  const stop = React.useRef(false);
  const [csvUrl, setCsvUrl] = useState<string | null>(null);
  useEffect(() => () => { if (csvUrl) URL.revokeObjectURL(csvUrl); }, [csvUrl]);

  const check = async (file: File | null) => {
    if (!file) return;
    setPh({ k: 'checking', name: file.name });
    try {
      const r = await checkImportFile(file);
      setCsvUrl(r.ok ? null : problemsCsv(r));
      setPh({ k: 'checked', name: file.name, r });
    } catch (e) {
      d.showToast(e instanceof Error ? e.message : 'Could not check the file.', 'danger');
      setPh({ k: 'pick' });
      setInputKey((k) => k + 1);
    }
  };

  const start = async () => {
    if (ph.k !== 'checked' || !ph.r.ok || !ph.r.batch || !ph.r.rows) return;
    const { name, r } = ph;
    stop.current = false;
    const out = await commitImport(r.batch!, r.rows!, (p) => setPh({ k: 'importing', name, r, p }), () => stop.current);
    setPh({ k: 'done', name, r, out });
    if (out.saved > 0) await d.afterImport(out.saved);
  };

  const again = () => { setPh({ k: 'pick' }); setInputKey((k) => k + 1); };
  const busy = ph.k === 'checking' || ph.k === 'importing';

  return (
    <div className="stack-16 imp">
      <ol className="steps">
        <li><a className="linkbtn" href="/api/stock/export?kind=template" download>Download the template</a> — SR no., pieces (taka), dropdowns for IN/OUT and locations.</li>
        <li>One row per challan. Save as .xlsx (up to 20,000 rows).</li>
        <li>Upload: the whole file is checked first. Nothing is saved until every row is right.</li>
      </ol>
      <label className="fld">Excel file
        <input key={inputKey} type="file" name="file" disabled={busy} accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => check(e.target.files?.[0] ?? null)} />
      </label>

      {ph.k === 'checking' && <div className="imp-box" role="status"><span className="spinner" aria-hidden /> Checking {ph.name}…</div>}

      {ph.k === 'checked' && !ph.r.ok && (
        <div className="alert bad stack-8" role="alert">
          <span className="strong">
            {ph.r.headerProblems.length > 0 && `${ph.r.headerProblems.length} column problem${ph.r.headerProblems.length > 1 ? 's' : ''}`}
            {ph.r.headerProblems.length > 0 && ph.r.problemCount > 0 && ' · '}
            {ph.r.problemCount > 0 && `${n0(ph.r.problemCount)} problem${ph.r.problemCount > 1 ? 's' : ''} in ${n0(ph.r.problemRows)} of ${n0(ph.r.total)} rows`}
            {' — nothing was saved. Fix the file and upload it again.'}
          </span>
          {ph.r.headerProblems.length > 0 && (
            <ul className="err-list">{ph.r.headerProblems.map((h, i) => <li key={i}>{h.message}</li>)}</ul>
          )}
          {ph.r.byField.length > 1 && (
            <div className="imp-fields">{ph.r.byField.map((b) => <Pill key={b.field} tone="bad">{b.field}: <span className="num">{n0(b.count)}</span></Pill>)}</div>
          )}
          {ph.r.problems.length > 0 && (
            <ul className="err-list imp-rows">
              {ph.r.problems.slice(0, 300).map((p, i) => <li key={i}><span className="num strong">Row {p.row}</span>{p.field ? <span className="t2"> · {p.field}</span> : null}: {p.message}</li>)}
              {ph.r.problemCount > 300 && <li className="muted">…and {n0(ph.r.problemCount - 300)} more — download the full list.</li>}
            </ul>
          )}
          <div className="imp-actions">
            {csvUrl && <a className="btn sm" href={csvUrl} download={`problems-${ph.name.replace(/\.xlsx$/i, '')}.csv`}><Icon name="download" size={14} />Problem list (.csv)</a>}
            <button type="button" className="btn sm" onClick={again}>Choose another file</button>
          </div>
        </div>
      )}

      {(ph.k === 'checked' || ph.k === 'importing') && ph.r.notes.length > 0 && (
        <ul className="imp-notes muted small">{ph.r.notes.map((x, i) => <li key={i}>{x}</li>)}</ul>
      )}

      {ph.k === 'checked' && ph.r.ok && (
        <div className="imp-box good stack-8">
          {ph.r.rows!.length ? (
            <>
              <span className="strong"><Icon name="check" size={16} strokeWidth={2} /> {ph.name}: all {n0(ph.r.rows!.length)} rows are ready</span>
              <span className="t2 small">{n0(ph.r.counts.in)} incoming · {n0(ph.r.counts.out)} outgoing{ph.r.counts.newLots ? ` · ${n0(ph.r.counts.newLots)} new lots` : ''}</span>
              <div className="imp-actions">
                <button type="button" className="btn primary" onClick={start}>Import {n0(ph.r.rows!.length)} rows</button>
                <button type="button" className="btn" onClick={again}>Cancel</button>
              </div>
            </>
          ) : (
            <>
              <span className="strong">Every row of this file was already imported. Nothing to add.</span>
              <div className="imp-actions"><button type="button" className="btn" onClick={again}>Choose another file</button></div>
            </>
          )}
        </div>
      )}

      {ph.k === 'importing' && (
        <div className="imp-box stack-8" role="status" aria-live="polite">
          <span className="strong">Importing {ph.name}…</span>
          <div className="imp-bar" role="progressbar" aria-label="Import progress" aria-valuemin={0} aria-valuemax={ph.p.total} aria-valuenow={ph.p.done} aria-valuetext={`${ph.p.done.toLocaleString('en-IN')} of ${ph.p.total.toLocaleString('en-IN')} rows`}><Track pct={ph.p.total ? (ph.p.done / ph.p.total) * 100 : 0} tone="info" height={10} /><span className="num small">{ph.p.total ? Math.floor((ph.p.done / ph.p.total) * 100) : 0}%</span></div>
          <span className="num">{n0(ph.p.done)} of {n0(ph.p.total)} rows</span>
          <span className="muted small">Keep this window open. Each part of 500 rows is saved as a whole.</span>
          <div className="imp-actions"><button type="button" className="btn sm" onClick={() => { stop.current = true; }}>Stop after this part</button></div>
        </div>
      )}

      {ph.k === 'done' && (
        <div className={`imp-box stack-8 ${ph.out.ok ? 'good' : 'bad'}`} role="status">
          {ph.out.ok ? (
            <span className="strong"><Icon name="check" size={16} strokeWidth={2} /> Imported {n0(ph.out.saved)} rows from {ph.name}</span>
          ) : (
            <span className="strong">Import stopped{ph.out.failedChunk ? ` at rows ${n0(ph.out.failedChunk.from)}–${n0(ph.out.failedChunk.to)}` : ''}</span>
          )}
          {!ph.out.ok && ph.out.error && <span>{ph.out.error}</span>}
          <span className="t2 small">
            Saved: {n0(ph.out.saved)} rows ({n0(ph.out.in)} incoming · {n0(ph.out.out)} outgoing){ph.out.skipped ? ` · ${n0(ph.out.skipped)} already there, skipped` : ''}.
            {!ph.out.ok && ph.out.failedChunk && ` Nothing from rows ${n0(ph.out.failedChunk.from)} onwards was saved.`}
          </span>
          {!ph.out.ok && <span className="t2 small">To finish: upload the same file again (saved rows are skipped automatically), or delete the saved rows from the file, fix the problem and upload it.</span>}
          <div className="imp-actions">
            {ph.out.ok ? <button type="button" className="btn primary" onClick={() => onDone?.()}>Done</button> : <button type="button" className="btn" onClick={again}>Upload again</button>}
          </div>
        </div>
      )}
    </div>
  );
}
