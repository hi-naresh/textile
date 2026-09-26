'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Icon from '../Icon';
import { PageHead, Pill } from '../ui';
import type { Ctx } from '../ctx';
import { LIMITS } from '@/lib/config';
import { sectionName } from '@/lib/access';
import type { Worker } from '@/lib/types';

type WorkerRow = Worker & { active: boolean };

/** Name shown as text with an Edit button; switches to an input + Save. */
function EditableName({ value, label, onSave }: { value: string; label: string; onSave: (v: string) => Promise<boolean> }) {
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

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
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

export function Settings({ ctx }: { ctx: Ctx }) {
  const { d } = ctx;
  const cfg = d.config;
  const api = d.settingsApi;
  const activeSections = cfg.sections.filter((s) => s.active);

  // ---------- firm + rules ----------
  const [firmName, setFirmName] = useState(cfg.firm.name);
  const [firmCity, setFirmCity] = useState(cfg.firm.city);
  const [shortage, setShortage] = useState(String(cfg.rules.shortageLimitPct));
  const [efficiency, setEfficiency] = useState(String(cfg.rules.efficiencyTargetPct));
  const [autoPct, setAutoPct] = useState(String(cfg.rules.aiAutoConfirmPct));
  const [locations, setLocations] = useState<string[]>(cfg.locationPresets);
  const [newLoc, setNewLoc] = useState('');

  // ---------- workers ----------
  const [workers, setWorkers] = useState<WorkerRow[] | null>(null);
  const [newWorkerSection, setNewWorkerSection] = useState('');
  const [newSupSections, setNewSupSections] = useState<number[]>([]);
  const loadWorkers = useCallback(async () => {
    try { setWorkers(await api.allWorkers()); } catch { setWorkers([]); }
  }, [api]);
  useEffect(() => { let alive = true; api.allWorkers().then((w) => { if (alive) setWorkers(w); }).catch(() => { if (alive) setWorkers([]); }); return () => { alive = false; }; }, [api]);

  const firmDirty = firmName !== cfg.firm.name || firmCity !== cfg.firm.city;
  const rulesDirty = shortage !== String(cfg.rules.shortageLimitPct) || efficiency !== String(cfg.rules.efficiencyTargetPct) || autoPct !== String(cfg.rules.aiAutoConfirmPct);
  const locDirty = locations.join('|') !== cfg.locationPresets.join('|');
  const workerSection = newWorkerSection || activeSections[0]?.name || '';

  return (
    <div className="page fade settings">
      <PageHead title="Settings" sub="Everything here is specific to this firm. Changes apply for everyone straight away." />

      <div className="settings-grid">
        {/* Firm */}
        <section className="card pad stack-16">
          <div className="stack-4"><h2 className="h2">Firm</h2><span className="muted small">Shown in the header and the browser tab.</span></div>
          <label className="fld">Firm name<input value={firmName} maxLength={LIMITS.nameMax} onChange={(e) => setFirmName(e.target.value)} /></label>
          <label className="fld">City / area<input value={firmCity} maxLength={100} onChange={(e) => setFirmCity(e.target.value)} placeholder="e.g. Surat" /></label>
          <div className="row-8"><button className="btn primary" disabled={!firmDirty || !firmName.trim()} onClick={() => api.updateFirm({ firm_name: firmName, firm_city: firmCity })}>Save firm</button></div>
        </section>

        {/* Rules */}
        <section className="card pad stack-16">
          <div className="stack-4"><h2 className="h2">Rules</h2><span className="muted small">Limits used for flags and automatic saving.</span></div>
          <label className="fld">Shortage limit (%)<input className="num" inputMode="decimal" value={shortage} onChange={(e) => setShortage(e.target.value)} />
            <span className="muted small">A job card losing more than this is flagged. Allowed {LIMITS.shortageLimitPct.min}–{LIMITS.shortageLimitPct.max}.</span></label>
          <label className="fld">Worker efficiency target (%)<input className="num" inputMode="decimal" value={efficiency} onChange={(e) => setEfficiency(e.target.value)} />
            <span className="muted small">A worker’s day below this is flagged.</span></label>
          <label className="fld">AI auto-confirm (%)<input className="num" inputMode="decimal" value={autoPct} onChange={(e) => setAutoPct(e.target.value)} />
            <span className="muted small">Photo reads at or above this confidence are saved without review. Allowed {LIMITS.aiAutoConfirmPct.min}–{LIMITS.aiAutoConfirmPct.max}; 100 = always review.</span></label>
          <div className="row-8"><button className="btn primary" disabled={!rulesDirty} onClick={() => api.updateFirm({ shortage_limit_pct: shortage, efficiency_target_pct: efficiency, ai_auto_confirm_pct: autoPct })}>Save rules</button></div>
        </section>

        {/* Locations */}
        <section className="card pad stack-16">
          <div className="stack-4"><h2 className="h2">Lot locations</h2><span className="muted small">Quick choices when receiving or moving a lot. Staff can still type any other place.</span></div>
          <div className="chips">
            {locations.map((l) => (
              <span key={l} className="chip-tag">{l}<button type="button" aria-label={`Remove ${l}`} onClick={() => setLocations(locations.filter((x) => x !== l))}><Icon name="x" size={14} strokeWidth={2} /></button></span>
            ))}
          </div>
          <form className="add-row" onSubmit={(e) => { e.preventDefault(); const v = newLoc.trim(); if (v && !locations.some((x) => x.toLowerCase() === v.toLowerCase()) && locations.length < LIMITS.locationPresetsMax) setLocations([...locations, v]); setNewLoc(''); }}>
            <input className="input" aria-label="New location" placeholder="e.g. Godown 2" value={newLoc} maxLength={60} onChange={(e) => setNewLoc(e.target.value)} />
            <button className="btn" type="submit" disabled={!newLoc.trim()}><Icon name="plus" size={16} strokeWidth={2} />Add</button>
          </form>
          <div className="row-8"><button className="btn primary" disabled={!locDirty || !locations.length} onClick={() => api.updateFirm({ location_presets: locations })}>Save locations</button></div>
        </section>

        {/* Sections */}
        <section className="card pad stack-16">
          <div className="stack-4"><h2 className="h2">Sections</h2><span className="muted small">The firm’s processes. Renaming also updates workers and job cards. Turn off instead of deleting to keep history.</span></div>
          <div className="list">
            {cfg.sections.map((s) => (
              <div key={s.id} className={`list-row ${s.active ? '' : 'off'}`}>
                <EditableName value={s.name} label={`${s.name} name`} onSave={(v) => api.updateSection(s.id, { name: v })} />
                <div className="grow" />
                {!s.active && <Pill>Off</Pill>}
                <Toggle on={s.active} label={`${s.name} active`} onChange={(v) => api.updateSection(s.id, { active: v })} />
              </div>
            ))}
            {!cfg.sections.length && <span className="muted small">No sections yet.</span>}
          </div>
          <AddRow placeholder="New section, e.g. Cutting" button="Add section" onAdd={(v) => api.addSection(v)} />
        </section>
      </div>

      {/* People */}
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
                  const ids = cfg.sections.filter((x) => x.active && s.sections.includes(x.name)).map((x) => x.id);
                  return (
                    <button key={sec.id} type="button" className={`chip ${on ? 'on' : ''}`} aria-pressed={on}
                      onClick={() => api.updateUser(s.id, { sections: on ? ids.filter((i) => i !== sec.id) : [...ids, sec.id] })}>
                      {on && <Icon name="check" size={13} strokeWidth={2.4} />}{sec.name}
                    </button>
                  );
                })}
              </div>
              <Toggle on={s.active} label={`${s.name} active`} onChange={(v) => api.updateUser(s.id, { active: v })} />
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

      {/* Workers */}
      <section className="card pad stack-16">
        <div className="stack-4"><h2 className="h2">Workers</h2><span className="muted small">Turn a worker off when they leave; their history stays.</span></div>
        <div className="list">
          {workers == null && <span className="muted small">Loading…</span>}
          {workers?.map((w) => (
            <div key={w.id} className={`list-row wrap ${w.active ? '' : 'off'}`}>
              <span className="av worker sm">{w.name.slice(0, 1).toUpperCase()}</span>
              <EditableName value={w.name} label={`${w.name} name`} onSave={async (v) => { const ok = await api.updateWorker(w.id, { name: v }); if (ok) loadWorkers(); return ok; }} />
              <div className="grow" />
              <select className="input sel" aria-label={`${w.name} section`} value={activeSections.find((s) => s.name.toLowerCase() === sectionName(w.section).toLowerCase())?.name ?? ''}
                onChange={async (e) => { if (await api.updateWorker(w.id, { section: e.target.value })) loadWorkers(); }}>
                {!activeSections.some((s) => s.name.toLowerCase() === sectionName(w.section).toLowerCase()) && <option value="">{sectionName(w.section)} (not in list)</option>}
                {activeSections.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
              </select>
              <Toggle on={w.active} label={`${w.name} active`} onChange={async (v) => { if (await api.updateWorker(w.id, { active: v })) loadWorkers(); }} />
            </div>
          ))}
        </div>
        <AddRow placeholder="New worker name" button="Add worker" onAdd={async (v) => { const ok = await api.addWorker(v, workerSection); if (ok) loadWorkers(); return ok; }}>
          <select className="input sel" aria-label="Section for new worker" value={workerSection} onChange={(e) => setNewWorkerSection(e.target.value)}>
            {activeSections.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
          </select>
        </AddRow>
      </section>
    </div>
  );
}
