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
import { flashWhenReady, useHashLink } from '@/lib/useApi';
import type { Worker } from '@/lib/types';
import { checkCode, checkMarketName, checkShop, type MarketInfo } from '@/lib/location';
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
  // Deep links: #firm=team (e.g. an agent alert about a section), #firm=parties&party=6 (open that party),
  // #firm=team&person=<user or worker id | section-ID> (scroll to + highlight that person). Also while already open.
  const link = useHashLink('firm');
  const [part, setPartState] = useState<Part>(isPart(link.value) ? link.value : 'firm');
  const [partyLink, setPartyLink] = useState<{ id: number; n: number } | null>(null);
  const setPart = (p: Part) => { setPartState(p); store.set(p); };
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- restore the last sub-tab after hydration, or follow a deep link */
    if (!isPart(link.value)) {
      const saved = store.get();
      if (isPart(saved)) setPartState(saved);
      return;
    }
    setPartState(link.value);
    store.set(link.value);
    const party = Number(link.all.party);
    if (link.value === 'parties' && party) setPartyLink({ id: party, n: link.n });
    /* eslint-enable react-hooks/set-state-in-effect */
    const person = link.all.person;
    if (link.value === 'team' && person) return flashWhenReady(`[data-person="${CSS.escape(person)}"]`, 6000);
  }, [link]);

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
      {part === 'parties' && <FirmParties ctx={ctx} link={partyLink} />}
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
// Markets (name + initials) and each market's shop numbers. A lot's place is "<initials> <shop> · Pipe <pipe>".
function PlacesPart({ ctx }: { ctx: Ctx }) {
  const list = ctx.d.config.markets ?? [];
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="stack-16">
      <section className="card pad stack-16">
        <div className="stack-4">
          <h2 className="h2">Markets</h2>
          <span className="muted small">Where the firm keeps lots. A lot&apos;s place is the market&apos;s initials, shop no. and pipe no., like <b>{list.find((m) => m.active)?.code ?? 'LM'} 245 · Pipe 3</b>. Floor and Dispatched are set by the app (job cards, dispatch).</span>
        </div>
        <div className="list">
          {list.map((m) => <MarketRow key={m.id} ctx={ctx} m={m} open={open === m.id} onToggle={() => setOpen(open === m.id ? null : m.id)} />)}
          {!list.length && <span className="muted small" style={{ padding: 14 }}>No markets yet.</span>}
        </div>
        <AddMarketRow ctx={ctx} />
      </section>
    </div>
  );
}

const marketSaved = (ctx: Ctx) => async (p: Promise<{ ok: true } | { ok: false; error: string }>) => {
  const r = await p;
  if (!r.ok) ctx.d.showToast(r.error, 'danger');
  return r.ok;
};

function MarketRow({ ctx, m, open, onToggle }: { ctx: Ctx; m: MarketInfo; open: boolean; onToggle: () => void }) {
  const api = ctx.d.marketsApi;
  const saved = marketSaved(ctx);
  const shops = m.shops.filter((s) => s.active);
  return (
    <>
      <div className={`list-row wrap mk-row ${m.active ? '' : 'off'}`}>
        <InitialsEdit value={m.code} name={m.name} onSave={(v) => saved(api.updateMarket(m.id, { code: v }))} />
        <EditableName value={m.name} label={`${m.name} name`} onSave={(v) => saved(api.updateMarket(m.id, { name: v }))} />
        <div className="grow" />
        <button type="button" className="btn sm" aria-expanded={open} onClick={onToggle}>
          {open ? 'Hide shops' : `${shops.length} shop${shops.length === 1 ? '' : 's'}`}
        </button>
        <Toggle on={m.active} label={`${m.name} in use`} onChange={(v) => saved(api.updateMarket(m.id, { active: v }))} />
      </div>
      {open && <ShopList ctx={ctx} m={m} />}
    </>
  );
}

/** Initials with an Edit button; warns that lots already placed keep their old label. */
function InitialsEdit({ value, name, onSave }: { value: string; name: string; onSave: (v: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  const [busy, setBusy] = useState(false);
  const c = checkCode(v);
  if (!editing) {
    return (
      <span className="edit-name">
        <span className="mk-code">{value}</span>
        <button type="button" className="ib sm-ib" aria-label={`Change initials of ${name}`} title="Change initials" onClick={() => { setV(value); setEditing(true); }}><Icon name="edit" size={15} /></button>
      </span>
    );
  }
  return (
    <form className="mk-initials" onSubmit={async (e) => { e.preventDefault(); if (!c.ok || c.value === value) { setEditing(false); return; } setBusy(true); const ok = await onSave(c.value); setBusy(false); if (ok) setEditing(false); }}>
      <div className="edit-name">
        <input className="input num mk-code-in" aria-label={`Initials of ${name}`} value={v} maxLength={6} autoCapitalize="characters" onChange={(e) => setV(e.target.value.toUpperCase())} aria-invalid={!c.ok} autoFocus />
        <button className="btn sm primary" type="submit" disabled={busy || !c.ok}>Save</button>
        <button className="btn sm" type="button" onClick={() => setEditing(false)}>Cancel</button>
      </div>
      <span className={`small ${c.ok ? 'muted' : 'err'}`}>{c.ok ? `Lots already placed keep their old label (${value} 245). New moves use ${c.value}.` : c.error}</span>
    </form>
  );
}

function ShopList({ ctx, m }: { ctx: Ctx; m: MarketInfo }) {
  const api = ctx.d.marketsApi;
  const saved = marketSaved(ctx);
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const [showOff, setShowOff] = useState(false);
  const on = m.shops.filter((s) => s.active);
  const off = m.shops.filter((s) => !s.active);
  const c = checkShop(v);
  const dup = c.ok && on.some((s) => s.shop_no === c.value);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!c.ok || dup) return;
    setBusy(true);
    const ok = await saved(api.addShop(m.id, c.value, m.name));
    setBusy(false);
    if (ok) setV('');
  };
  return (
    <div className="mk-shops stack-10">
      <span className="muted small">Shops in {m.name}, most used first. Removing a shop only takes it off this list; lots there keep their place.</span>
      <div className="chips">
        {on.map((s) => (
          <span key={s.id} className="chip-tag" title={s.uses ? `${s.uses} location records` : 'Not used yet'}>
            {s.shop_no}
            <button type="button" aria-label={`Remove shop ${s.shop_no} from ${m.name}`} onClick={() => saved(api.updateShop(s.id, false))}><Icon name="x" size={14} strokeWidth={2} /></button>
          </span>
        ))}
        {!on.length && <span className="muted small">No shops yet. They are also added when someone types a new shop no. while placing a lot.</span>}
      </div>
      <form className="add-row" onSubmit={add}>
        <input className="input num" aria-label={`New shop no. in ${m.name}`} placeholder="Shop no., e.g. 245" value={v} maxLength={10} autoCapitalize="characters" onChange={(e) => setV(e.target.value)} aria-invalid={!!v.trim() && (!c.ok || dup)} />
        <button className="btn" type="submit" disabled={busy || !c.ok || dup}><Icon name="plus" size={16} strokeWidth={2} />Add shop</button>
      </form>
      {v.trim() && !c.ok && <span className="err small">{c.error}</span>}
      {dup && <span className="muted small">Shop {c.ok ? c.value : ''} is already in the list.</span>}
      {off.length > 0 && (
        <div className="stack-6">
          <button type="button" className="linkbtn small left" onClick={() => setShowOff(!showOff)}>{showOff ? 'Hide removed shops' : `Show ${off.length} removed shop${off.length === 1 ? '' : 's'}`}</button>
          {showOff && (
            <div className="chips">
              {off.map((s) => <button key={s.id} type="button" className="chip" onClick={() => saved(api.updateShop(s.id, true))} aria-label={`Bring back shop ${s.shop_no}`}><Icon name="plus" size={13} strokeWidth={2} />{s.shop_no}</button>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AddMarketRow({ ctx }: { ctx: Ctx }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const all = ctx.d.config.markets ?? [];
  const n = checkMarketName(name);
  const c = checkCode(code);
  const local = name.trim() && !n.ok ? n.error
    : n.ok && all.some((m) => m.name.toLowerCase() === n.value.toLowerCase()) ? `${all.find((m) => m.name.toLowerCase() === n.value.toLowerCase())!.name} is already in the list.`
    : code.trim() && !c.ok ? c.error
    : c.ok && all.some((m) => m.code === c.value) ? `Initials ${c.value} are already used by ${all.find((m) => m.code === c.value)!.name}.` : null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!n.ok || !c.ok || local) return;
    setBusy(true);
    const r = await ctx.d.marketsApi.addMarket(n.value, c.value);
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    setName(''); setCode(''); setErr(null);
  };
  return (
    <form className="stack-6" onSubmit={submit}>
      <div className="add-row">
        <input className="input" aria-label="New market name" placeholder="New market, e.g. Landmark 2" value={name} maxLength={60} onChange={(e) => { setName(e.target.value); setErr(null); }} />
        <input className="input num mk-code-in" aria-label="Initials" placeholder="Initials, e.g. LM2" value={code} maxLength={6} autoCapitalize="characters" onChange={(e) => { setCode(e.target.value.toUpperCase()); setErr(null); }} />
        <button className="btn primary" type="submit" disabled={busy || !n.ok || !c.ok || !!local}><Icon name="plus" size={16} strokeWidth={2} />Add market</button>
      </div>
      {(local || err) && <span className="err small">{err ?? local}</span>}
    </form>
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
              <div key={s.id} className="list-row" data-person={`section-${s.id}`}>
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
            <div className="list-row" data-person={cfg.owner.id}>
              <span className="av owner sm">{cfg.owner.name.slice(0, 1).toUpperCase()}</span>
              <EditableName value={cfg.owner.name} label="Owner name" onSave={(v) => api.updateUser(cfg.owner.id, { name: v })} />
              <div className="grow" />
              <Pill tone="good">Owner</Pill>
            </div>
            {cfg.supervisors.map((s) => (
              <div key={s.id} data-person={s.id} className={`list-row wrap ${s.active ? '' : 'off'}`}>
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
            <div key={w.id} data-person={w.id} className={`list-row wrap ${w.active ? '' : 'off'}`}>
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
