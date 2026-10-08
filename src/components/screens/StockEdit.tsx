'use client';

// Stock ledger edit mode (owner): cells turn into inputs in place, like a spreadsheet.
// Drafts live in the Stock screen; each table row is memoised and only gets its own drafts,
// so typing in one cell doesn't re-render the other rows. Saved via PATCH /api/stock/edit.
import React from 'react';
import Icon from '../Icon';
import { dayTime } from '../ui';
import './StockEdit.css';

// ---------- drafts ----------
export type MvField = 'sr_no' | 'pieces' | 'source_doc_id' | 'mill_name' | 'weaver_name' | 'party'
  | 'register_pct' | 'loc_code' | 'bill_pct' | 'billed_meters' | 'lot_status_code';
export type LotField = 'quality' | 'design' | 'grade' | 'status';
export type RowDraft = Partial<Record<string, string>>;
/** m: movement id → field → typed text; l: lot id → field → typed text. Only cells that differ from the saved value. */
export interface Drafts { m: Record<number, RowDraft>; l: Record<string, RowDraft> }
export const NO_DRAFTS: Drafts = { m: {}, l: {} };
export type Kind = 'm' | 'l';
export type OnEdit = (kind: Kind, id: number | string, field: string, value: string, orig: string) => void;

export const LOT_STATUSES = ['active', 'completed', 'dispatched', 'hold'] as const;

export const countDrafts = (d: Drafts) =>
  Object.values(d.m).reduce((s, r) => s + Object.keys(r).length, 0) + Object.values(d.l).reduce((s, r) => s + Object.keys(r).length, 0);

/** Pure update: set (or, when back to the saved value, drop) one draft cell. Other rows keep their identity. */
export function setDraft(d: Drafts, kind: Kind, id: number | string, field: string, value: string, orig: string): Drafts {
  const bag = d[kind] as Record<string | number, RowDraft>;
  const row = { ...(bag[id] ?? {}) };
  if (value === orig) delete row[field];
  else row[field] = value;
  const nextBag = { ...bag };
  if (Object.keys(row).length) nextBag[id] = row;
  else delete nextBag[id];
  return { ...d, [kind]: nextBag };
}

export const str = (v: unknown) => (v == null ? '' : String(v));

// ---------- validation (same rules as the server, so mistakes show before saving) ----------
const NAME_RE = /[\p{L}\p{N}]/u;
export const FIELD_LABEL: Record<string, string> = {
  sr_no: 'SR no.', pieces: 'Taka', source_doc_id: 'Challan no.', mill_name: 'Mill', weaver_name: 'Weaver', party: 'Party',
  quality: 'Quality', design: 'Design', grade: 'Grade', status: 'Status',
  register_pct: '%', loc_code: 'Location code', bill_pct: 'L', billed_meters: 'NQTY', lot_status_code: 'LOT S',
};
const numText = (v: string) => Number(v.replace(/,/g, '').replace(/%$/, ''));
export function checkCell(field: string, raw: string): string | null {
  const v = raw.replace(/\s+/g, ' ').trim();
  switch (field) {
    case 'sr_no':
      if (!v) return null;
      if (!/^\d+$/.test(v.replace(/,/g, '')) || Number(v.replace(/,/g, '')) <= 0) return 'SR must be a whole number above 0.';
      if (Number(v.replace(/,/g, '')) > 2_000_000_000) return 'SR is too large.';
      return null;
    case 'pieces':
      if (!v) return null;
      if (!/^\d+$/.test(v.replace(/,/g, ''))) return 'Taka must be a whole number, 0 or more.';
      if (Number(v.replace(/,/g, '')) > 1_000_000) return 'Taka looks too large.';
      return null;
    case 'source_doc_id': {
      if (!v) return null;
      const c = v.toUpperCase().replace(/\s*-\s*/g, '-').replace(/\s+/g, '-');
      if (!/^[A-Z0-9][A-Z0-9/-]*$/.test(c)) return 'Only letters, digits, "-" and "/".';
      if (c.length > 40) return '40 characters at most.';
      return null;
    }
    case 'mill_name': case 'weaver_name': case 'party':
      if (!v) return null;
      if (!NAME_RE.test(v)) return 'Not a valid name.';
      if (v.length > 100) return '100 characters at most.';
      return null;
    case 'quality': case 'design':
      if (!v) return `${FIELD_LABEL[field]} is required.`;
      if (!NAME_RE.test(v)) return 'Not a valid name.';
      if (v.length > 100) return '100 characters at most.';
      return null;
    case 'grade':
      if (!v) return 'Grade is required.';
      if (v.length > 10) return '10 characters at most.';
      if (!/^[A-Za-z0-9][A-Za-z0-9 +\-/]*$/.test(v)) return 'Letters, digits, "+", "-", "/" only.';
      return null;
    case 'status':
      return (LOT_STATUSES as readonly string[]).includes(v) ? null : 'Pick a status.';
    case 'register_pct':
      if (!v) return null;
      return Number.isFinite(numText(v)) && numText(v) >= 0 && numText(v) <= 100 ? null : '0 to 100.';
    case 'bill_pct':
      if (!v) return null;
      return Number.isFinite(numText(v)) && numText(v) > 0 && numText(v) <= 1000 ? null : 'A number above 0.';
    case 'billed_meters':
      if (!v) return null;
      return Number.isFinite(numText(v)) && numText(v) >= 0 ? null : 'A number, 0 or more.';
    case 'loc_code':
      if (!v) return null;
      if (v.length > 40) return '40 characters at most.';
      return /^[A-Za-z0-9][A-Za-z0-9 +\-/.]*$/.test(v) ? null : 'Letters, digits, + - / . only.';
    case 'lot_status_code':
      if (!v) return null;
      return /^[A-Za-z0-9]{1,5}$/.test(v) ? null : 'Short code like R, E, S, A.';
    default:
      return null;
  }
}

// ---------- keyboard: Enter/↓ next row, ↑ previous row, Tab/Shift+Tab next/previous cell ----------
export function gridKeyDown(e: React.KeyboardEvent<HTMLElement>) {
  const t = e.target as HTMLElement;
  const col = t.dataset?.c;
  if (!col) return;
  const isSelect = t.tagName === 'SELECT';
  const focus = (el: HTMLElement | undefined) => {
    if (!el) return false;
    el.focus();
    if (el instanceof HTMLInputElement) el.select();
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  };
  let step = 0;
  if (e.key === 'Enter') step = e.shiftKey ? -1 : 1;
  else if (!isSelect && !e.altKey && e.key === 'ArrowDown') step = 1;
  else if (!isSelect && !e.altKey && e.key === 'ArrowUp') step = -1;
  if (step) {
    const same = [...e.currentTarget.querySelectorAll<HTMLElement>(`[data-c="${col}"]`)];
    e.preventDefault();
    focus(same[same.indexOf(t) + step]);
    return;
  }
  if (e.key === 'Tab') {
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-c]')];
    if (focus(all[all.indexOf(t) + (e.shiftKey ? -1 : 1)])) e.preventDefault();
  }
}

// ---------- one editable cell ----------
export const EditCell = React.memo(function EditCell({ kind, id, field, orig, draft, problem, label, onEdit, num, list, options, hint }: {
  kind: Kind; id: number | string; field: string; orig: string; draft: string | undefined; problem?: string;
  label: string; onEdit: OnEdit; num?: boolean; list?: string; options?: readonly string[]; hint?: string;
}) {
  const value = draft ?? orig;
  const changed = draft !== undefined;
  const err = (changed ? checkCell(field, value) : null) ?? problem ?? null;
  const cls = `se-in ${num ? 'num r' : ''} ${changed ? 'se-changed' : ''} ${err ? 'se-bad' : ''}`;
  const errId = err ? `se-e-${kind}-${id}-${field}` : undefined;
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onEdit(kind, id, field, orig, orig); }
  };
  return (
    <span className="se-cell" title={hint}>
      {options ? (
        <select className={cls} data-c={field} aria-label={label} aria-invalid={!!err} aria-describedby={errId} value={value}
          onChange={(e) => onEdit(kind, id, field, e.target.value, orig)} onKeyDown={onKeyDown}>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input className={cls} data-c={field} aria-label={label} aria-invalid={!!err} aria-describedby={errId} value={value} list={list}
          inputMode={num ? 'numeric' : undefined} autoComplete="off" spellCheck={false}
          onChange={(e) => onEdit(kind, id, field, e.target.value, orig)} onKeyDown={onKeyDown} />
      )}
      {err && <span id={errId} className="se-err" role="alert">{err}</span>}
    </span>
  );
});

// ---------- sticky bar: "N changes · Save · Discard" ----------
export function EditBar({ count, saving, onSave, onDiscard, lotHint }: { count: number; saving: boolean; onSave: () => void; onDiscard: () => void; lotHint: boolean }) {
  return (
    <div className="se-bar" role="region" aria-label="Unsaved changes">
      <span className="se-bar-text">
        <span className="strong"><span className="num">{count}</span> {count === 1 ? 'change' : 'changes'}</span>
        <span className="muted small se-bar-hint">{lotHint ? 'Quality and design belong to the lot: every row of that lot changes.' : 'Enter / ↓ next row · Tab next cell · Esc undo cell'}</span>
      </span>
      <button type="button" className="btn sm" disabled={!count || saving} onClick={onDiscard}>Discard</button>
      <button type="button" className="btn sm primary" disabled={!count || saving} onClick={onSave}>{saving ? 'Saving…' : 'Save'}</button>
    </div>
  );
}

// ---------- "save or discard?" (in-app, not window.confirm) ----------
export function UnsavedDialog({ count, saving, onSave, onDiscard, onCancel }: { count: number; saving: boolean; onSave: () => void; onDiscard: () => void; onCancel: () => void }) {
  const saveRef = React.useRef<HTMLButtonElement | null>(null);
  React.useEffect(() => {
    saveRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="se-overlay" onClick={onCancel}>
      <div className="se-dialog card pad stack-14" role="alertdialog" aria-modal="true" aria-labelledby="se-dlg-t" aria-describedby="se-dlg-d" onClick={(e) => e.stopPropagation()}>
        <h2 id="se-dlg-t">Save your changes?</h2>
        <p id="se-dlg-d" className="t2">You have <span className="num strong">{count}</span> unsaved {count === 1 ? 'change' : 'changes'} in the ledger.</p>
        <div className="se-dlg-actions">
          <button type="button" className="btn sm" onClick={onCancel} disabled={saving}>Keep editing</button>
          <button type="button" className="btn sm danger" onClick={onDiscard} disabled={saving}>Discard</button>
          <button type="button" className="btn sm primary" ref={saveRef} onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

// ---------- "Edited" marker: who changed what, when ----------
interface EditLog { field: string; label: string; old_value: string | null; new_value: string | null; edited_at: string; edited_by: string | null }
export function EditedMarker({ target, id }: { target: 'movement' | 'lot'; id: number | string }) {
  const [open, setOpen] = React.useState(false);
  const [edits, setEdits] = React.useState<EditLog[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next) return;
    try {
      const res = await fetch(`/api/stock/edit?target=${target}&id=${encodeURIComponent(String(id))}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Could not load the edit history.');
      setEdits(data.edits ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the edit history.');
    }
  };
  return (
    <span className="se-mark-wrap">
      <button type="button" className="se-mark" aria-expanded={open} onClick={toggle} title="Show edit history">
        <Icon name="edit" size={11} strokeWidth={2} />Edited
      </button>
      {open && (
        <span className="se-pop" role="dialog" aria-label="Edit history">
          {error ? <span className="err small">{error}</span>
            : !edits ? <span className="muted small">Loading…</span>
            : !edits.length ? <span className="muted small">No edits recorded.</span>
            : edits.slice(0, 8).map((x, i) => (
              <span key={i} className="se-pop-row small">
                <span><span className="strong">{x.label}</span> {x.old_value ?? '—'} → {x.new_value ?? '—'}</span>
                <span className="muted tiny">{x.edited_by ?? 'Someone'} · {dayTime(x.edited_at)}</span>
              </span>
            ))}
          <button type="button" className="btn sm" onClick={() => setOpen(false)}>Close</button>
        </span>
      )}
    </span>
  );
}
