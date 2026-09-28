'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Icon from '../Icon';
import { PageHead, Pill, Segmented } from '../ui';
import type { KnowledgeDoc } from '@/lib/useTextileData';
import type { Ctx } from '../ctx';
import { LIMITS } from '@/lib/config';
import { ROLE_LABEL, activeSupervisors, sectionName, type Role } from '@/lib/access';
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

/** Preview role (until login exists) + owner screen density. Stored on this device. */
function ViewSettings({ ctx }: { ctx: Ctx }) {
  const { role, d } = ctx;
  const sups = activeSupervisors();
  return (
    <section className="card pad stack-16">
      <h2 className="h2">View</h2>
      <div className="fld">Preview as
        <Segmented label="Preview as role" value={role} onChange={ctx.setRole} className="fit" options={(['owner', 'supervisor', 'worker'] as Role[]).map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
        <span className="muted small">Until login is added, this decides what the app shows.</span>
      </div>
      {role === 'supervisor' && sups.length > 0 && (
        <label className="fld">Supervisor
          <select value={ctx.supervisorId ?? sups[0].id} onChange={(e) => ctx.setSupervisorId(e.target.value)}>
            {sups.map((s) => <option key={s.id} value={s.id}>{s.name}{s.sections.length ? ` · ${s.sections.join(', ')}` : ''}</option>)}
          </select>
        </label>
      )}
      {role === 'worker' && d.workers.length > 0 && (
        <label className="fld">Worker
          <select value={ctx.workerId ?? ''} onChange={(e) => ctx.setWorkerId(e.target.value)}>
            {d.workers.map((w) => <option key={w.id} value={w.id}>{w.name} · {sectionName(w.section)}</option>)}
          </select>
        </label>
      )}
      {role === 'owner' && (
        <div className="fld">Screen density
          <Segmented label="Screen density" value={ctx.density} onChange={ctx.setDensity} className="fit" options={[{ value: 'compact', label: 'Compact' }, { value: 'detailed', label: 'Detailed' }]} />
          <span className="muted small">Compact hides charts, the sections table and detail columns.</span>
        </div>
      )}
    </section>
  );
}

/** Theme + language: every role, stored on this device. */
function Preferences({ ctx }: { ctx: Ctx }) {
  return (
    <section className="card pad stack-16">
      <h2 className="h2">Preferences</h2>
      <div className="fld">Theme
        <Segmented label="Theme" value={ctx.theme} onChange={ctx.setTheme} className="fit" options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' }]} />
      </div>
      <div className="fld">Language
        <Segmented label="Language" value={ctx.lang} onChange={ctx.setLang} className="fit" options={[{ value: 'en', label: 'English' }, { value: 'hi', label: 'हिंदी' }, { value: 'gu', label: 'ગુજરાતી' }]} />
        <span className="muted small">Used for the capture screen and voice questions.</span>
      </div>
    </section>
  );
}

export function Settings({ ctx }: { ctx: Ctx }) {
  if (ctx.role !== 'owner') {
    return (
      <div className="page fade settings">
        <PageHead title="Settings" />
        <div className="settings-grid"><ViewSettings ctx={ctx} /><Preferences ctx={ctx} /></div>
      </div>
    );
  }
  return <OwnerSettings ctx={ctx} />;
}

function OwnerSettings({ ctx }: { ctx: Ctx }) {
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
  const [challanMin, setChallanMin] = useState(String(cfg.rules.manualChallanMin));
  const [jobCardMin, setJobCardMin] = useState(String(cfg.rules.manualJobCardMin));
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
  const rulesDirty = shortage !== String(cfg.rules.shortageLimitPct) || efficiency !== String(cfg.rules.efficiencyTargetPct) || autoPct !== String(cfg.rules.aiAutoConfirmPct)
    || challanMin !== String(cfg.rules.manualChallanMin) || jobCardMin !== String(cfg.rules.manualJobCardMin);
  const locDirty = locations.join('|') !== cfg.locationPresets.join('|');
  const workerSection = newWorkerSection || activeSections[0]?.name || '';

  return (
    <div className="page fade settings">
      <PageHead title="Settings" sub="Firm settings apply for everyone straight away" />

      <div className="settings-grid">
        <ViewSettings ctx={ctx} />
        <Preferences ctx={ctx} />
        <Connections ctx={ctx} />
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
          <div className="two-col">
            <label className="fld">Manual minutes per challan<input className="num" inputMode="decimal" value={challanMin} onChange={(e) => setChallanMin(e.target.value)} /></label>
            <label className="fld">Manual minutes per job card<input className="num" inputMode="decimal" value={jobCardMin} onChange={(e) => setJobCardMin(e.target.value)} /></label>
          </div>
          <span className="muted small" style={{ marginTop: -8 }}>How long entering one by hand takes. Used for the time-saved figure.</span>
          <label className="fld">Auto-confirm photo reads (%)<input className="num" inputMode="decimal" value={autoPct} onChange={(e) => setAutoPct(e.target.value)} />
            <span className="muted small">Photo reads at or above this confidence are saved without review. Allowed {LIMITS.aiAutoConfirmPct.min}–{LIMITS.aiAutoConfirmPct.max}; 100 = always review.</span></label>
          <div className="row-8"><button className="btn primary" disabled={!rulesDirty} onClick={() => api.updateFirm({ shortage_limit_pct: shortage, efficiency_target_pct: efficiency, ai_auto_confirm_pct: autoPct, manual_challan_min: challanMin, manual_job_card_min: jobCardMin })}>Save rules</button></div>
        </section>

        {/* Locations */}
        <section className="card pad stack-16">
          <div className="stack-4"><h2 className="h2">Lot locations</h2><span className="muted small">The only places a lot can be. Floor is used by job cards; Dispatched is set automatically.</span></div>
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

        <Knowledge ctx={ctx} />

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

const AI_LABEL: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'info' }> = {
  connected: { label: 'Connected', tone: 'good' },
  demo: { label: 'Demo mode', tone: 'info' },
  missing: { label: 'Not connected', tone: 'bad' },
  invalid_key: { label: 'Key rejected', tone: 'bad' },
  model_unavailable: { label: 'Model unavailable', tone: 'bad' },
  unreachable: { label: 'Unreachable', tone: 'warn' },
};

function Connections({ ctx }: { ctx: Ctx }) {
  const { d } = ctx;
  const [busy, setBusy] = useState(false);
  const st = d.status;
  const ai = st ? AI_LABEL[st.ai.state] ?? AI_LABEL.unreachable : null;
  const photoTone = st?.photos.state === 'missing' ? 'bad' : st?.photos.state === 'local' ? 'info' : 'good';
  return (
    <section className="card pad stack-14">
      <div className="card-head">
        <div className="stack-4 grow"><h2 className="h2">Connections</h2></div>
        <button className="btn sm" disabled={busy} onClick={async () => { setBusy(true); await d.checkStatus(true); setBusy(false); }}><Icon name="refresh" size={14} />{busy ? 'Checking…' : 'Check again'}</button>
      </div>
      {!st && <span className="muted small">Checking…</span>}
      {st && ai && (
        <div className="list">
          {st.ocr && (
            <div className="list-row wrap">
              <div className="stack-2 grow">
                <span className="strong">OCR (Google Cloud Vision)</span>
                <span className="muted small">{st.ocr.message}</span>
                {st.ocr.fix && <span className="t2 small">What to do: {st.ocr.fix}</span>}
              </div>
              <Pill tone={st.ocr.state === 'connected' ? 'good' : 'warn'}>{st.ocr.state === 'connected' ? 'Connected' : 'Not connected'}</Pill>
            </div>
          )}
          <div className="list-row wrap">
            <div className="stack-2 grow">
              <span className="strong">AI (Gemini)</span>
              <span className="muted small">{st.ai.message}{st.ai.state !== 'missing' && st.ai.state !== 'demo' && st.models ? ` Low tier: ${st.models.low} · High tier: ${st.models.high}.` : ''}</span>
              {st.ai.fix && <span className="t2 small">What to do: {st.ai.fix}</span>}
            </div>
            <Pill tone={ai.tone}>{ai.label}</Pill>
          </div>
          <div className="list-row wrap">
            <div className="stack-2 grow">
              <span className="strong">Photo storage</span>
              <span className="muted small">{st.photos.message}</span>
              {st.photos.fix && <span className="t2 small">What to do: {st.photos.fix}</span>}
            </div>
            <Pill tone={photoTone}>{st.photos.state === 'connected' ? 'Connected' : st.photos.state === 'local' ? 'Local folder' : 'Not connected'}</Pill>
          </div>
        </div>
      )}
    </section>
  );
}

/** Firm notes the chat answers policy / how-to questions from. */
function Knowledge({ ctx }: { ctx: Ctx }) {
  const api = ctx.d.settingsApi;
  const [docs, setDocs] = useState<KnowledgeDoc[] | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const load = useCallback(async () => { try { setDocs(await api.knowledge()); } catch { setDocs([]); } }, [api]);
  useEffect(() => { let alive = true; api.knowledge().then((x) => { if (alive) setDocs(x); }).catch(() => { if (alive) setDocs([]); }); return () => { alive = false; }; }, [api]);
  return (
    <section className="card pad stack-16">
      <div className="stack-4"><h2 className="h2">Firm knowledge</h2><span className="muted small">Short notes (policies, party terms, how-tos). Chat answers from these.</span></div>
      <div className="list">
        {docs == null && <span className="muted small">Loading…</span>}
        {docs?.map((k) => (
          <div key={k.id} className={`list-row wrap ${k.active ? '' : 'off'}`}>
            <button type="button" className="linkbtn strong grow left" onClick={() => setOpen(open === k.id ? null : k.id)}>{k.title}</button>
            <Toggle on={k.active} label={`${k.title} active`} onChange={async (v) => { if (await api.updateKnowledge(k.id, { active: v })) load(); }} />
            {open === k.id && <p className="t2 small note-body">{k.body}</p>}
          </div>
        ))}
        {docs && !docs.length && <span className="muted small">No notes yet.</span>}
      </div>
      <form className="stack-10" onSubmit={async (e) => { e.preventDefault(); if (!title.trim() || !body.trim()) return; if (await api.addKnowledge(title.trim(), body.trim())) { setTitle(''); setBody(''); load(); } }}>
        <input className="input" aria-label="Note title" placeholder="Title, e.g. Payment terms" value={title} maxLength={150} onChange={(e) => setTitle(e.target.value)} />
        <textarea className="input" aria-label="Note text" rows={3} placeholder="The note…" value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} />
        <div className="row-8"><button className="btn primary" type="submit" disabled={!title.trim() || !body.trim()}><Icon name="plus" size={16} strokeWidth={2} />Add note</button></div>
      </form>
    </section>
  );
}
