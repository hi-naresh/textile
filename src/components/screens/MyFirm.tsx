'use client';

// My firm (owner): everything about the firm itself, in five parts —
//  Firm & billing · Parties · Markets & locations · Policy (rules, stock alerts, firm knowledge) ·
//  Team (sign ups waiting for approval first, then owner & supervisors, workers, sections, sign-ins).
// Settings keeps only things about you and this device (account, preferences, connections).
import React, { useCallback, useEffect, useState } from 'react';
import Icon from '../Icon';
import { Empty, PageHead, Pill } from '../ui';
import type { Ctx } from '../ctx';
import { LIMITS } from '@/lib/config';
import { sectionName } from '@/lib/access';
import { useTakeHash } from '@/lib/useApi';
import type { Worker } from '@/lib/types';
import { FirmBilling, FirmParties } from './MasterData';
import { UsersAndSignUps } from './Team';
import { PolicyPart } from './Policy';

type Part = 'firm' | 'parties' | 'places' | 'policy' | 'team';
const PARTS: { value: Part; label: string; icon: string }[] = [
  { value: 'firm', label: 'Firm & billing', icon: 'factory' },
  { value: 'parties', label: 'Parties', icon: 'users' },
  { value: 'places', label: 'Markets & locations', icon: 'box' },
  { value: 'policy', label: 'Policy', icon: 'shield' },
  { value: 'team', label: 'Team', icon: 'userPlus' },
];
const isPart = (v: string | null): v is Part => PARTS.some((p) => p.value === v);
const store = {
  get() { try { return localStorage.getItem('tb-firm-part'); } catch { return null; } },
  set(v: Part) { try { localStorage.setItem('tb-firm-part', v); } catch { /* storage unavailable */ } },
};

export function MyFirm({ ctx }: { ctx: Ctx }) {
  // Deep link: #firm=team (e.g. from an agent alert about a section).
  const link = useTakeHash('firm');
  const [part, setPartState] = useState<Part>(isPart(link) ? link : 'firm');
  useEffect(() => {
    if (isPart(link)) return;
    const saved = store.get();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restore the last sub-tab after hydration
    if (isPart(saved)) setPartState(saved);
  }, [link]);
  const setPart = (p: Part) => { setPartState(p); store.set(p); };

  if (ctx.role !== 'owner') {
    return <div className="page fade"><PageHead title="My firm" /><Empty title="Not available" text="Only the owner can change the firm." /></div>;
  }
  return (
    <div className="page fade settings">
      <PageHead title="My firm" sub="Firm details, parties, places, policy and people. Changes apply for everyone straight away." />
      <nav className="firm-tabs" aria-label="My firm">
        {PARTS.map((p) => (
          <button key={p.value} type="button" className={`firm-tab ${part === p.value ? 'on' : ''}`} aria-current={part === p.value ? 'page' : undefined} onClick={() => setPart(p.value)}>
            <Icon name={p.icon} size={16} strokeWidth={2} /><span>{p.label}</span>
            {p.value === 'team' && ctx.signups > 0 && <span className="seg-count num" aria-label={`${ctx.signups} waiting for approval`}>{ctx.signups}</span>}
          </button>
        ))}
      </nav>
      {part === 'firm' && <FirmPart ctx={ctx} />}
      {part === 'parties' && <FirmParties ctx={ctx} />}
      {part === 'places' && <PlacesPart ctx={ctx} />}
      {part === 'policy' && <PolicyPart ctx={ctx} />}
      {part === 'team' && <TeamPart ctx={ctx} />}
    </div>
  );
}

// ---------- small shared controls (also used by Settings) ----------
/** Bin button with a confirm step (in place, no browser pop-up): "Remove Ramesh? · Remove · Cancel". */
export function RemoveButton({ name, what, onRemove }: { name: string; what: string; onRemove: () => Promise<boolean> }) {
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!ask) return <button type="button" className="ib sm-ib danger-ib" aria-label={`Remove ${name}`} title={`Remove ${what}`} onClick={() => setAsk(true)}><Icon name="trash" size={15} /></button>;
  return (
    <span className="remove-ask" role="group" aria-label={`Remove ${name}?`}>
      <span className="small">Remove {name}? They are signed out and can’t sign in; history keeps the name.</span>
      <button type="button" className="btn sm danger" disabled={busy} onClick={async () => { setBusy(true); const ok = await onRemove(); setBusy(false); if (!ok) setAsk(false); }}>Remove</button>
      <button type="button" className="btn sm" disabled={busy} onClick={() => setAsk(false)}>Cancel</button>
    </span>
  );
}

/** Name shown as text with an Edit button; switches to an input + Save. */
export function EditableName({ value, label, onSave }: { value: string; label: string; onSave: (v: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  const [busy, setBusy] = useState(false);
  if (!editing) {
    return (
      <span className="edit-name">
        <span className="strong">{value}</span>
        <button type="button" className="ib sm-ib" aria-label={`Edit ${label}`} onClick={() => { setV(value); setEditing(true); }}><Icon name="edit" size={15} /></button>
      </span>
    );
  }
  return (
    <form className="edit-name" onSubmit={async (e) => { e.preventDefault(); if (!v.trim() || v.trim() === value) { setEditing(false); return; } setBusy(true); const ok = await onSave(v.trim()); setBusy(false); if (ok) setEditing(false); }}>
      <input className="input" aria-label={label} value={v} maxLength={LIMITS.nameMax} onChange={(e) => setV(e.target.value)} autoFocus />
      <button className="btn sm primary" type="submit" disabled={busy}>Save</button>
      <button className="btn sm" type="button" onClick={() => setEditing(false)}>Cancel</button>
    </form>
  );
}

export function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
      <span className="switch-knob" />
    </button>
  );
}

function AddRow({ placeholder, button, onAdd, children }: { placeholder: string; button: string; onAdd: (v: string) => Promise<boolean>; children?: React.ReactNode }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form className="add-row" onSubmit={async (e) => { e.preventDefault(); if (!v.trim()) return; setBusy(true); const ok = await onAdd(v.trim()); setBusy(false); if (ok) setV(''); }}>
      <input className="input" aria-label={placeholder} placeholder={placeholder} value={v} maxLength={LIMITS.nameMax} onChange={(e) => setV(e.target.value)} />
      {children}
      <button className="btn primary" type="submit" disabled={busy || !v.trim()}><Icon name="plus" size={16} strokeWidth={2} />{button}</button>
    </form>
  );
}

/** Editable list of short names shown as removable chips, saved with one button. */
function ChipList({ title, sub, items, max, placeholder, normalize, onSave, saveLabel, emptyText, allowEmpty }: {
  title: string; sub: React.ReactNode; items: string[]; max: number; placeholder: string; normalize?: (v: string) => string;
  onSave: (list: string[]) => Promise<boolean>; saveLabel: string; emptyText: string; allowEmpty: boolean;
}) {
  const [list, setList] = useState<string[]>(items);
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = list.join('|') !== items.join('|');
  const norm = normalize ?? ((x: string) => x);
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const x = norm(v.trim().replace(/\s+/g, ' '));
    if (x && !list.some((y) => y.toLowerCase() === x.toLowerCase()) && list.length < max) setList([...list, x]);
    setV('');
  };
  return (
    <section className="card pad stack-16">
      <div className="stack-4"><h2 className="h2">{title}</h2><span className="muted small">{sub}</span></div>
      <div className="chips">
        {list.map((l) => (
          <span key={l} className="chip-tag">{l}<button type="button" aria-label={`Remove ${l}`} onClick={() => setList(list.filter((x) => x !== l))}><Icon name="x" size={14} strokeWidth={2} /></button></span>
        ))}
        {!list.length && <span className="muted small">{emptyText}</span>}
      </div>
      <form className="add-row" onSubmit={add}>
        <input className="input" aria-label={placeholder} placeholder={placeholder} value={v} maxLength={60} onChange={(e) => setV(e.target.value)} />
        <button className="btn" type="submit" disabled={!v.trim() || list.length >= max}><Icon name="plus" size={16} strokeWidth={2} />Add</button>
      </form>
      {list.length >= max && <span className="muted small">Up to {max}.</span>}
      <div className="row-8">
        <button className="btn primary" disabled={busy || !dirty || (!allowEmpty && !list.length)} onClick={async () => { setBusy(true); await onSave(list); setBusy(false); }}>{saveLabel}</button>
        {dirty && <button className="btn" type="button" onClick={() => setList(items)}>Undo</button>}
      </div>
    </section>
  );
}

// ---------- Firm & billing ----------
function FirmPart({ ctx }: { ctx: Ctx }) {
  const cfg = ctx.d.config;
  const api = ctx.d.settingsApi;
  const [firmName, setFirmName] = useState(cfg.firm.name);
  const [firmCity, setFirmCity] = useState(cfg.firm.city);
  const dirty = firmName !== cfg.firm.name || firmCity !== cfg.firm.city;
  return (
    <div className="stack-16">
      <section className="card pad stack-16">
        <div className="stack-4"><h2 className="h2">Firm</h2><span className="muted small">Shown in the header and the browser tab.</span></div>
        <div className="two-col">
          <label className="fld">Firm name<input value={firmName} maxLength={LIMITS.nameMax} onChange={(e) => setFirmName(e.target.value)} /></label>
          <label className="fld">City / area<input value={firmCity} maxLength={100} onChange={(e) => setFirmCity(e.target.value)} placeholder="e.g. Surat" /></label>
        </div>
        <div className="row-8"><button className="btn primary" disabled={!dirty || !firmName.trim()} onClick={() => api.updateFirm({ firm_name: firmName, firm_city: firmCity })}>Save firm</button></div>
      </section>
      <FirmBilling ctx={ctx} />
    </div>
  );
}

// ---------- Markets & locations ----------
function PlacesPart({ ctx }: { ctx: Ctx }) {
  const cfg = ctx.d.config;
  const api = ctx.d.settingsApi;
  const markets = cfg.markets ?? [];
  const example = markets[0] ?? 'RRTM';
  return (
    <div className="settings-grid">
      <ChipList
        key={`m:${markets.join('|')}`}
        title="Markets"
        sub={<>Textile markets where the firm has shops. A lot kept in a shop gets a place like <b>{example} 245 · Pipe 3</b>.</>}
        items={markets} max={LIMITS.marketsMax} placeholder="e.g. RRTM" normalize={(v) => v.toUpperCase()}
        onSave={(list) => api.updateFirm({ markets: list })} saveLabel="Save markets" emptyText="No markets yet." allowEmpty
      />
      <ChipList
        key={`l:${cfg.locationPresets.join('|')}`}
        title="Fixed places"
        sub="Other places a lot can be, like a godown. Floor is used by job cards; Dispatched is set by the app."
        items={cfg.locationPresets} max={LIMITS.locationPresetsMax} placeholder="e.g. Godown 2"
        onSave={(list) => api.updateFirm({ location_presets: list })} saveLabel="Save places" emptyText="No places yet." allowEmpty={false}
      />
    </div>
  );
}

// ---------- Team ----------
type WorkerRow = Worker & { active: boolean };

function TeamPart({ ctx }: { ctx: Ctx }) {
  const cfg = ctx.d.config;
  const api = ctx.d.settingsApi;
  const activeSections = cfg.sections.filter((s) => s.active);
  const offSections = cfg.sections.filter((s) => !s.active);
  const [showOff, setShowOff] = useState(false);

  const [workers, setWorkers] = useState<WorkerRow[] | null>(null);
  const [newWorkerSection, setNewWorkerSection] = useState('');
  const [newSupSections, setNewSupSections] = useState<number[]>([]);
  const loadWorkers = useCallback(async () => {
    try { setWorkers(await api.allWorkers()); } catch { setWorkers([]); }
  }, [api]);
  useEffect(() => { let alive = true; api.allWorkers().then((w) => { if (alive) setWorkers(w); }).catch(() => { if (alive) setWorkers([]); }); return () => { alive = false; }; }, [api]);
  const workerSection = newWorkerSection || activeSections[0]?.name || '';
  const inActive = (sec: string) => activeSections.some((s) => s.name.toLowerCase() === sectionName(sec).toLowerCase());

  return (
    <div className="stack-16">
      {/* Waiting for approval: first, because someone is waiting (shown only when there are any). */}
      <UsersAndSignUps ctx={ctx} part="pending" />

      <div className="settings-grid">
        {/* Sections */}
        <section className="card pad stack-16">
          <div className="stack-4"><h2 className="h2">Sections</h2><span className="muted small">The work the floor does. Only these show in job cards, allotment and reports. Renaming also updates workers and job cards.</span></div>
          <div className="list">
            {activeSections.map((s) => (
              <div key={s.id} className="list-row">
                <EditableName value={s.name} label={`${s.name} name`} onSave={(v) => api.updateSection(s.id, { name: v })} />
                <div className="grow" />
                <Toggle on label={`${s.name} in use`} onChange={(v) => api.updateSection(s.id, { active: v })} />
              </div>
            ))}
            {!activeSections.length && <span className="muted small" style={{ padding: 14 }}>No sections in use.</span>}
            {showOff && offSections.map((s) => (
              <div key={s.id} className="list-row off">
                <span className="strong">{s.name}</span>
                <div className="grow" />
                <Pill>Off</Pill>
                <Toggle on={false} label={`${s.name} in use`} onChange={(v) => api.updateSection(s.id, { active: v })} />
              </div>
            ))}
          </div>
          {offSections.length > 0 && (
            <button type="button" className="linkbtn small left" onClick={() => setShowOff(!showOff)}>
              {showOff ? 'Hide sections not in use' : `Show ${offSections.length} section${offSections.length === 1 ? '' : 's'} not in use`}
            </button>
          )}
          <AddRow placeholder="New section, e.g. Cutting" button="Add section" onAdd={(v) => api.addSection(v)} />
        </section>

        {/* Owner & supervisors */}
        <section className="card pad stack-16">
          <div className="stack-4"><h2 className="h2">Owner & supervisors</h2><span className="muted small">Supervisors only see and manage the sections ticked here.</span></div>
          <div className="list">
            <div className="list-row">
              <span className="av owner sm">{cfg.owner.name.slice(0, 1).toUpperCase()}</span>
              <EditableName value={cfg.owner.name} label="Owner name" onSave={(v) => api.updateUser(cfg.owner.id, { name: v })} />
              <div className="grow" />
              <Pill tone="good">Owner</Pill>
            </div>
            {cfg.supervisors.map((s) => (
              <div key={s.id} className={`list-row wrap ${s.active ? '' : 'off'}`}>
                <span className="av supervisor sm">{s.name.slice(0, 1).toUpperCase()}</span>
                <EditableName value={s.name} label={`${s.name} name`} onSave={(v) => api.updateUser(s.id, { name: v })} />
                <div className="grow" />
                <div className="chips sec-chips" role="group" aria-label={`${s.name} sections`}>
                  {activeSections.map((sec) => {
                    const on = s.sections.includes(sec.name);
                    const ids = activeSections.filter((x) => s.sections.includes(x.name)).map((x) => x.id);
                    return (
                      <button key={sec.id} type="button" className={`chip ${on ? 'on' : ''}`} aria-pressed={on}
                        onClick={() => api.updateUser(s.id, { sections: on ? ids.filter((i) => i !== sec.id) : [...ids, sec.id] })}>
                        {on && <Icon name="check" size={13} strokeWidth={2.4} />}{sec.name}
                      </button>
                    );
                  })}
                </div>
                <Toggle on={s.active} label={`${s.name} active`} onChange={(v) => api.updateUser(s.id, { active: v })} />
                <RemoveButton name={s.name} what="supervisor" onRemove={() => api.removeSupervisor(s.id, s.name)} />
              </div>
            ))}
          </div>
          <AddRow placeholder="New supervisor name" button="Add supervisor" onAdd={async (v) => { const ok = await api.addSupervisor(v, newSupSections); if (ok) setNewSupSections([]); return ok; }}>
            <div className="chips sec-chips" role="group" aria-label="Sections for new supervisor">
              {activeSections.map((sec) => {
                const on = newSupSections.includes(sec.id);
                return <button key={sec.id} type="button" className={`chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => setNewSupSections(on ? newSupSections.filter((i) => i !== sec.id) : [...newSupSections, sec.id])}>{sec.name}</button>;
              })}
            </div>
          </AddRow>
        </section>
      </div>

      {/* Workers */}
      <section className="card pad stack-16">
        <div className="stack-4"><h2 className="h2">Workers</h2><span className="muted small">Switch a worker off for a while, or remove them if they have left. Their job cards and history stay.</span></div>
        <div className="list">
          {workers == null && <span className="muted small" style={{ padding: 14 }}>Loading…</span>}
          {workers?.map((w) => (
            <div key={w.id} className={`list-row wrap ${w.active ? '' : 'off'}`}>
              <span className="av worker sm">{w.name.slice(0, 1).toUpperCase()}</span>
              <EditableName value={w.name} label={`${w.name} name`} onSave={async (v) => { const ok = await api.updateWorker(w.id, { name: v }); if (ok) loadWorkers(); return ok; }} />
              <div className="grow" />
              <select className="input sel" aria-label={`${w.name} section`} value={activeSections.find((s) => s.name.toLowerCase() === sectionName(w.section).toLowerCase())?.name ?? ''}
                onChange={async (e) => { if (e.target.value && await api.updateWorker(w.id, { section: e.target.value })) loadWorkers(); }}>
                {!inActive(w.section) && <option value="">{sectionName(w.section)} (not in use)</option>}
                {activeSections.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
              </select>
              <Toggle on={w.active} label={`${w.name} active`} onChange={async (v) => { if (await api.updateWorker(w.id, { active: v })) loadWorkers(); }} />
              <RemoveButton name={w.name} what="worker" onRemove={async () => { const ok = await api.removeWorker(w.id, w.name); if (ok) loadWorkers(); return ok; }} />
            </div>
          ))}
          {workers && !workers.length && <span className="muted small" style={{ padding: 14 }}>No workers yet.</span>}
        </div>
        <AddRow placeholder="New worker name" button="Add worker" onAdd={async (v) => { const ok = await api.addWorker(v, workerSection); if (ok) loadWorkers(); return ok; }}>
          <select className="input sel" aria-label="Section for new worker" value={workerSection} onChange={(e) => setNewWorkerSection(e.target.value)}>
            {activeSections.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
          </select>
        </AddRow>
      </section>

      <UsersAndSignUps ctx={ctx} part="people" />
    </div>
  );
}
