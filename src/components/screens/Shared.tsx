'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Icon from '../Icon';
import { Empty, PageHead, Pill, Segmented, Track, dayTime, fmt, inr } from '../ui';
import type { Ctx } from '../ctx';
import { can, captureInScope, inSupervisorScope, jobInScope, sectionName, activeSupervisor, rules, sectionNames, allLocations } from '@/lib/access';
import { CAPTURE_LABEL, ENGINE_LABEL, FIELDS_FOR, FIELD_LABEL, NUMERIC_FIELDS, OPTIONAL_FIELDS, STAGE_LABEL, STATUS_LABEL, STATUS_TONE, locationTone, shortTone } from '@/lib/derive';
import type { StockEntry } from '@/lib/useTextileData';
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

export function Review({ ctx }: { ctx: Ctx }) {
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
      <div className="page fade">
        <PageHead title="Review queue" sub="Photo reads waiting for a check before they reach the ledger" />
        <Empty title="Queue clear" text="Every photo read in your scope has been handled."><button className="btn sm" onClick={() => d.refresh()}><Icon name="refresh" size={14} />Check again</button></Empty>
      </div>
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
    <div className="page fade">
      <PageHead title="Review queue" sub="Photo reads waiting for a check before they reach the ledger" />
      <div className="review">
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
  const lot = lotId || lots[0]?.lot_id || '';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!w || !lot || !meters) { d.showToast('Pick a worker, a lot and meters.', 'warning'); return; }
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
        <select value={lot} onChange={(e) => setLotId(e.target.value)}>
          {lots.map((l) => <option key={l.lot_id} value={l.lot_id}>{l.lot_id} · {l.quality} · {fmt(l.balance)} m{l.location ? ` · ${l.location}` : ''}</option>)}
        </select>
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
const EMPTY_ENTRY: StockEntry = { direction: 'IN', lot_id: '', grey_meters: '', finished_meters: '', mill_name: '', weaver_name: '', location: 'Godown', quality: '', design: '', meters: '', party: '', source_doc: '' };

export function StockForm({ ctx, onDone, initialDirection = 'IN' }: { ctx: Ctx; onDone?: () => void; initialDirection?: 'IN' | 'OUT' }) {
  const { d, role } = ctx;
  const [f, setF] = useState<StockEntry>({ ...EMPTY_ENTRY, direction: initialDirection });
  const [sameAsMill, setSameAsMill] = useState(false);
  const [busy, setBusy] = useState(false);
  const known = d.lots.find((l) => l.lot_id === f.lot_id.trim());
  const set = (k: keyof StockEntry) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const isIn = f.direction === 'IN';
  const grey = parseFloat(f.grey_meters);
  const fin = parseFloat(f.finished_meters);
  const diff = Number.isFinite(grey) && Number.isFinite(fin) && grey > 0 ? ((grey - fin) / grey) * 100 : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const entry = { ...f, lot_id: f.lot_id.trim(), weaver_name: sameAsMill ? f.mill_name : f.weaver_name };
    if (!entry.lot_id) return d.showToast('Lot number is required.', 'warning');
    if (isIn && !entry.grey_meters && !entry.finished_meters) return d.showToast('Enter grey meters or finished meters.', 'warning');
    if (isIn && !entry.mill_name.trim()) return d.showToast('Mill name is required.', 'warning');
    if (isIn && !known && (!entry.quality.trim() || !entry.design.trim())) return d.showToast('New lot: enter quality and design.', 'warning');
    if (!isIn && (!entry.meters || !entry.party.trim())) return d.showToast('Meters and party (client) are required.', 'warning');
    setBusy(true);
    const ok = await d.addStock(role, entry);
    setBusy(false);
    if (ok) { setF({ ...EMPTY_ENTRY, direction: f.direction }); setSameAsMill(false); onDone?.(); }
  };

  return (
    <form className="stack-16" onSubmit={submit}>
      <div className="fld">Direction
        <Segmented label="Direction" value={f.direction} onChange={(v) => setF({ ...f, direction: v })} className="fit" options={[{ value: 'IN', label: 'Incoming (IN)' }, { value: 'OUT', label: 'Outgoing (OUT)' }]} />
      </div>
      <label className="fld">Lot number
        <input className="num" list="lot-list" value={f.lot_id} onChange={set('lot_id')} placeholder="e.g. LOT-5030" autoComplete="off" />
        <datalist id="lot-list">{d.lots.map((l) => <option key={l.lot_id} value={l.lot_id}>{l.quality}</option>)}</datalist>
        {known && <span className="muted small">{known.quality} · balance {fmt(known.balance, 1)} m{known.location ? ` · at ${known.location}` : ''}</span>}
      </label>

      {isIn ? (
        <>
          <div className="two-col">
            <label className="fld">Grey meters<input className="num" inputMode="decimal" value={f.grey_meters} onChange={set('grey_meters')} placeholder="0.0" /></label>
            <label className="fld">Finished meters<input className="num" inputMode="decimal" value={f.finished_meters} onChange={set('finished_meters')} placeholder="0.0" /></label>
          </div>
          <span className="muted small hint">Stock is counted in finished meters (grey if finished isn’t known yet).{diff != null ? ` Grey → finished difference: ${diff.toFixed(1)}%.` : ''}</span>
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
          <label className="fld">Challan no.<input className="num" value={f.source_doc} onChange={set('source_doc')} /></label>
          <div className="fld">Location on arrival
            <LocationPicker value={f.location} onChange={(v) => setF({ ...f, location: v })} />
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
          <label className="fld">Meters<input className="num" inputMode="decimal" value={f.meters} onChange={set('meters')} placeholder="0.0" /></label>
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

/** Fixed list only (Settings → Lot locations). "Dispatched" is set by the system. */
export function LocationPicker({ value, onChange, exclude }: { value: string; onChange: (v: string) => void; exclude?: string | null }) {
  const list = allLocations().filter((l) => l !== exclude);
  return (
    <div role="group" aria-label="Location" className="loc-opts">
      {list.map((l) => (
        <button key={l} type="button" className={`opt ${value === l ? 'on' : ''}`} aria-pressed={value === l} onClick={() => onChange(l)}>{l}</button>
      ))}
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
    if (!loc.trim()) return d.showToast('Pick a location.', 'warning');
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
          <button className="btn primary big" type="submit" disabled={busy}>Move lot</button>
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
export function StockImport({ ctx, onDone }: { ctx: Ctx; onDone?: () => void }) {
  const { d, role } = ctx;
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ row: number; error: string }[] | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return d.showToast('Choose the filled Excel file.', 'warning');
    setBusy(true);
    const r = await d.importStock(role, file);
    setBusy(false);
    if (r.ok) { setFile(null); setErrors(null); onDone?.(); } else setErrors(r.rows ?? null);
  };

  return (
    <form className="stack-16" onSubmit={submit}>
      <ol className="steps">
        <li><a className="linkbtn" href="/api/stock/export?kind=template" download>Download the template</a> (dropdowns for IN/OUT and locations).</li>
        <li>One row per challan. Save as .xlsx.</li>
        <li>Upload. If any row has a problem, nothing is saved and every problem is listed.</li>
      </ol>
      <label className="fld">Excel file
        <input type="file" name="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setErrors(null); }} />
      </label>
      {errors && errors.length > 0 && (
        <div className="alert bad stack-4" role="alert">
          <span className="strong">{errors.length} row{errors.length > 1 ? 's' : ''} to fix — nothing was imported</span>
          <ul className="err-list">{errors.slice(0, 50).map((x) => <li key={x.row}><span className="num strong">Row {x.row}:</span> {x.error}</li>)}</ul>
        </div>
      )}
      <button className="btn primary big" type="submit" disabled={busy || !file}>{busy ? 'Checking…' : 'Import'}</button>
    </form>
  );
}
