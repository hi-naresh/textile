'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Icon from '../Icon';
import { Empty, LockTag, PageHead, Pill, Segmented, Track, dayTime, fmt, inr, time } from '../ui';
import type { Ctx } from '../ctx';
import { ACTIVE_SUPERVISOR, SCOPE_TEXT, SECTIONS, SHORTAGE_LIMIT_PCT, can, captureInScope, captureSection, inSupervisorScope, jobInScope, sectionName } from '@/lib/access';
import { CAPTURE_LABEL, FIELDS_FOR, FIELD_LABEL, STATUS_LABEL, STATUS_TONE, shortTone } from '@/lib/derive';
import type { CaptureEvent, JobCard } from '@/lib/types';

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
    if (await d.closeJobCard(closing, metersOut)) setClosing(null);
  };

  return (
    <div className="page fade">
      <PageHead title="Job cards" sub="Meters in, meters out and shortage for every process step">
        {manage && <button className="btn primary" onClick={() => ctx.openSheet('job')}><Icon name="plus" size={16} strokeWidth={2} />New job card</button>}
      </PageHead>
      <div className="toolbar">
        <Segmented label="Status" value={status} onChange={setStatus} options={[{ value: 'all', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'in-process', label: 'In process' }, { value: 'closed', label: 'Closed' }]} />
        <div className="grow" />
        <Pill tone="info" className="tall"><Icon name="filter" size={12} strokeWidth={2} />{SCOPE_TEXT[role].chip}</Pill>
      </div>
      <section className="card flush">
        <table className="tbl rtbl">
          <thead><tr><th>Card</th><th>Lot</th><th>Process</th><th>Worker</th><th className="r">In</th><th className="r">Out</th><th className="r">Shortage</th><th>Status</th><th className="r"><span className="lock th-lock"><Icon name="lock" size={12} strokeWidth={2} />Loss ₹</span></th>{manage && <th className="r">Action</th>}</tr></thead>
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
                    <td data-label="Loss ₹" className="r num" style={{ color: isOwner ? 'var(--text)' : 'var(--muted)' }}>{isOwner ? loss : '••••'}</td>
                    {manage && <td data-label="Action" className="r">{j.status !== 'closed' ? <button className="btn sm" onClick={() => startClose(j)}>Close</button> : <span className="muted small">{j.ts_closed ? dayTime(j.ts_closed) : ''}</span>}</td>}
                  </tr>
                  {closing === j.id && (
                    <tr className="inline-row">
                      <td colSpan={manage ? 10 : 9}>
                        <form className="inline-form" onSubmit={submitClose}>
                          <label className="fld inline">Meters out for JC-{j.id}
                            <input className="num" inputMode="decimal" value={metersOut} onChange={(e) => setMetersOut(e.target.value)} autoFocus />
                          </label>
                          <span className="muted small">In: {fmt(j.meters_in, 1)} m · shortage over {SHORTAGE_LIMIT_PCT}% gets flagged</span>
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
      {!isOwner && <p className="muted small note"><Icon name="lock" size={14} strokeWidth={2} />Rupee loss and party rates are visible to the owner only. Cards outside {ACTIVE_SUPERVISOR.sections.join(' and ')} are hidden from your view.</p>}
    </div>
  );
}

// ---------------- Review queue ----------------
function fieldValue(v: unknown) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return fmt(v, 2);
  return String(v);
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
  const editing = !!sel && editId === sel.id;
  const setEditing = (on: boolean) => setEditId(on && sel ? sel.id : null);
  const imgOk = !!sel && !badImg[sel.id];
  const setImgOk = (ok: boolean) => { if (sel) setBadImg((b) => ({ ...b, [sel.id]: !ok })); };

  if (!pending.length) {
    return (
      <div className="page fade">
        <PageHead title="Review queue" sub="AI reads from challan and job-card photos. Nothing reaches the ledger until someone confirms it."><Pill tone="info" className="tall">{SCOPE_TEXT[role].chip}</Pill></PageHead>
        <Empty title="Queue clear" text="Every photo read in your scope has been handled."><button className="btn sm" onClick={() => d.refresh()}><Icon name="refresh" size={14} />Check again</button></Empty>
      </div>
    );
  }

  const conf = Math.round((sel!.confidence ?? 0) * 100);
  const tone = conf >= 85 ? 'good' : conf >= 80 ? 'warn' : 'bad';
  const keys = FIELDS_FOR[sel!.type] as readonly string[];
  const data = (sel!.ai_json ?? {}) as Record<string, unknown>;
  const missing = keys.filter((k) => fieldValue(data[k]) == null);

  const startEdit = () => {
    const x: Record<string, string> = {};
    keys.forEach((k) => { x[k] = data[k] == null ? '' : String(data[k]); });
    setDraft(x);
    setEditing(true);
  };
  const act = async (fn: () => Promise<boolean>) => { setBusy(true); const ok = await fn(); setBusy(false); if (ok) setSelId(null); };
  const confirm = () => {
    if (!editing) return act(() => d.confirmCapture(role, sel!));
    const out: Record<string, unknown> = { ...data };
    keys.forEach((k) => {
      const v = draft[k]?.trim();
      out[k] = v === '' ? null : ['meters', 'meters_out', 'job_card_id'].includes(k) && !Number.isNaN(Number(v)) ? Number(v) : v;
    });
    return act(() => d.confirmCapture(role, sel!, out));
  };

  return (
    <div className="page fade">
      <PageHead title="Review queue" sub="AI reads from challan and job-card photos. Nothing reaches the ledger until someone confirms it."><Pill tone="info" className="tall">{SCOPE_TEXT[role].chip}</Pill></PageHead>
      <div className="review">
        <div className="review-list">
          <span className="eyebrow mob-only">Up next</span>
          {pending.map((c) => {
            const p = Math.round(c.confidence * 100);
            return (
              <button key={c.id} className={`q ${sel?.id === c.id ? 'on' : ''}`} onClick={() => setSelId(c.id)}>
                <div className="q-top"><span className="num strong small grow">#{c.id} · {String((c.ai_json as Record<string, unknown> | null)?.lot_id ?? 'Lot ?')}</span><Pill tone={p >= 85 ? 'good' : p >= 80 ? 'warn' : 'bad'}><span className="num">{p}%</span></Pill></div>
                <span className="strong">{CAPTURE_LABEL[c.type]}</span>
                <span className="muted small">{captureSection(c.type)} · {dayTime(c.ts)}</span>
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
            <Pill className="photo-tag">{imgOk ? CAPTURE_LABEL[sel!.type] : 'Photo not available'}</Pill>
          </div>
          <div className="stack-16">
            <div className="card-head"><h2>{CAPTURE_LABEL[sel!.type]}</h2><Pill tone={tone}><span className="num">{conf}%</span> overall</Pill></div>
            <span className="muted small" style={{ marginTop: -8 }}>Read #{sel!.id} · {captureSection(sel!.type)} · captured {dayTime(sel!.ts)}</span>
            <div className="bar-row"><Track pct={conf} tone={tone} /><span className="num small">{conf}%</span></div>
            <div className="fields">
              {keys.map((k) => {
                const v = fieldValue(data[k]);
                return (
                  <div key={k} className={`field-row ${v == null ? 'miss' : ''}`}>
                    <span className="t2 small">{FIELD_LABEL[k] ?? k}</span>
                    {editing ? (
                      <input className="input num" aria-label={FIELD_LABEL[k] ?? k} value={draft[k] ?? ''} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
                    ) : (
                      <span className="num strong">{v ?? 'Not read'}</span>
                    )}
                  </div>
                );
              })}
            </div>
            {(conf < 80 || missing.length > 0) && !editing && (
              <div className="alert bad">{missing.length ? `${missing.length} field${missing.length > 1 ? 's' : ''} could not be read. ` : ''}{conf < 80 ? 'Confidence is under 80%. ' : ''}Check against the photo before confirming.</div>
            )}
            <div className="actions">
              <button className="btn danger" disabled={busy} onClick={() => act(() => d.rejectCapture(role, sel!))}>Reject</button>
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

// ---------------- Ask Textile Brain ----------------
export function Ask({ ctx }: { ctx: Ctx }) {
  const { d, role } = ctx;
  const [q, setQ] = useState('');
  const [showSql, setShowSql] = useState<number | null>(null);
  const endRef = React.useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [d.messages.length]);
  const suggestions = role === 'owner'
    ? ['Which lots have less than 500 meters?', 'Top 5 workers by efficiency', 'Total shortage by process']
    : ['Open job cards in folding', 'Meters allotted today by worker', 'Which folding cards have shortage over 3%?'];
  const submit = (text: string) => { if (!text.trim()) return; d.ask(role, text.trim()); setQ(''); };

  return (
    <div className="page fade ask-page">
      <PageHead title="Ask Textile Brain" sub={role === 'owner' ? 'Plain-language questions over the live database. Every query is logged.' : 'Meters and job cards for your sections. Every query is logged.'} />
      <section className="card chat">
        <div className="chat-thread">
          {d.messages.map((m, i) => (
            <div key={i} className={`msg ${m.sender} ${m.error ? 'err' : ''}`}>
              <div className="bubble">
                <span className={m.loading ? 'muted' : ''}>{m.text}</span>
                {m.rows && m.rows.length > 0 && (
                  <div className="mini-table">
                    <table className="tbl">
                      <thead><tr>{Object.keys(m.rows[0]).map((k) => <th key={k}>{k}</th>)}</tr></thead>
                      <tbody>{m.rows.slice(0, 8).map((r, ri) => <tr key={ri}>{Object.values(r).map((v, vi) => <td key={vi} className="num">{v == null ? '—' : String(v)}</td>)}</tr>)}</tbody>
                    </table>
                    {m.rows.length > 8 && <span className="muted small">+{m.rows.length - 8} more rows</span>}
                  </div>
                )}
                {m.sql && (
                  <div className="sql">
                    <button className="linkbtn small" onClick={() => setShowSql(showSql === i ? null : i)}><Icon name="code" size={12} strokeWidth={2} />{showSql === i ? 'Hide query' : 'Show query · audited'}</button>
                    {showSql === i && <pre>{m.sql}</pre>}
                  </div>
                )}
              </div>
              <span className="muted tiny">{time(m.timestamp.toISOString())}</span>
            </div>
          ))}
          <div ref={endRef} />
        </div>
        <div className="chat-foot">
          <div className="chips scroll-x">{suggestions.map((s) => <button key={s} className="chip" onClick={() => submit(s)}>{s}</button>)}</div>
          <form className="askbox" onSubmit={(e) => { e.preventDefault(); submit(q); }}>
            <input aria-label="Ask a question" placeholder="Ask in English, हिंदी or ગુજરાતી…" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn primary sm icon-only" aria-label="Send" type="submit"><Icon name="arrow" size={16} strokeWidth={2} /></button>
          </form>
        </div>
      </section>
    </div>
  );
}

// ---------------- Allot work / new job card ----------------
export function AllotForm({ ctx, onDone }: { ctx: Ctx; onDone?: () => void }) {
  const { d, role } = ctx;
  const workers = d.workers.filter((w) => role === 'owner' || inSupervisorScope(w.section));
  const processes = role === 'owner' ? SECTIONS : SECTIONS.filter((s) => ACTIVE_SUPERVISOR.sections.includes(s));
  const lots = d.lots.filter((l) => l.status !== 'dispatched');
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
    const ok = await d.createJobCard({ lot_id: lot, process: proc, worker_id: w.id, meters_in: meters, shift }, w.name);
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
          {lots.map((l) => <option key={l.lot_id} value={l.lot_id}>{l.lot_id} · {l.quality} · {fmt(l.balance)} m</option>)}
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
export function StockForm({ ctx, onDone }: { ctx: Ctx; onDone?: () => void }) {
  const { d } = ctx;
  const [f, setF] = useState({ lot_id: '', direction: 'IN' as 'IN' | 'OUT', meters: '', party: '', source_doc: '', quality: '', design: '' });
  const [busy, setBusy] = useState(false);
  const known = d.lots.find((l) => l.lot_id === f.lot_id);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.lot_id || !f.meters) { d.showToast('Lot and meters are required.', 'warning'); return; }
    setBusy(true);
    const ok = await d.addStock(f);
    setBusy(false);
    if (ok) { setF({ ...f, lot_id: '', meters: '', party: '', source_doc: '', quality: '', design: '' }); onDone?.(); }
  };
  return (
    <form className="stack-16" onSubmit={submit}>
      <div className="fld">Direction
        <Segmented label="Direction" value={f.direction} onChange={(v) => setF({ ...f, direction: v })} className="fit" options={[{ value: 'IN', label: 'Inward (IN)' }, { value: 'OUT', label: 'Outward (OUT)' }]} />
      </div>
      <label className="fld">Lot number
        <input className="num" list="lot-list" value={f.lot_id} onChange={set('lot_id')} placeholder="e.g. LOT-5030" />
        <datalist id="lot-list">{d.lots.map((l) => <option key={l.lot_id} value={l.lot_id}>{l.quality}</option>)}</datalist>
        {known && <span className="muted small">{known.quality} · balance {fmt(known.balance, 1)} m</span>}
      </label>
      <label className="fld">Meters<input className="num" inputMode="decimal" value={f.meters} onChange={set('meters')} placeholder="0.0" /></label>
      <label className="fld">{f.direction === 'IN' ? 'Supplier' : 'Buyer'}<input value={f.party} onChange={set('party')} /></label>
      <label className="fld">Challan / ref no.<input className="num" value={f.source_doc} onChange={set('source_doc')} /></label>
      {f.direction === 'IN' && !known && f.lot_id && (
        <>
          <label className="fld">Quality (new lot)<input value={f.quality} onChange={set('quality')} /></label>
          <label className="fld">Design (new lot)<input value={f.design} onChange={set('design')} /></label>
        </>
      )}
      <button className="btn primary big" type="submit" disabled={busy}>Record {f.direction}</button>
      <LockTag label="Manual ledger entries are owner only" />
    </form>
  );
}
