'use client';

// Lot chooser that stays fast with thousands of lots: a plain dropdown when there are few,
// otherwise type-to-search (lot no., quality or design) showing at most MAX matches.
import React, { useId, useMemo } from 'react';
import { fmt } from './ui';

export interface PickLot { lot_id: string; quality?: string | null; design?: string | null; balance?: number; location?: string | null }

const MAX = 30;
const SELECT_UP_TO = 60;

/** Best matches for typed text: lot numbers starting with it first, then any field containing it. */
export function matchLots<T extends PickLot>(lots: T[], text: string, max = MAX): T[] {
  const t = text.trim().toLowerCase();
  if (!t) return lots.slice(0, max);
  const starts: T[] = [];
  const has: T[] = [];
  for (const l of lots) {
    const id = l.lot_id.toLowerCase();
    if (id.startsWith(t)) starts.push(l);
    else if (has.length < max && (id.includes(t) || (l.quality ?? '').toLowerCase().includes(t) || (l.design ?? '').toLowerCase().includes(t))) has.push(l);
    if (starts.length >= max) break;
  }
  return [...starts, ...has].slice(0, max);
}

const label = (l: PickLot) =>
  [l.lot_id, l.quality, l.balance != null ? `${fmt(l.balance, 1)} m` : null, l.location].filter(Boolean).join(' · ');

export function LotPicker({ lots, value, onChange, ariaLabel, placeholder = 'Type lot no., quality or design' }: {
  lots: PickLot[];
  value: string;
  onChange: (lotId: string) => void;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const listId = useId();
  const matches = useMemo(() => (lots.length > SELECT_UP_TO ? matchLots(lots, value) : []), [lots, value]);
  const picked = lots.find((l) => l.lot_id === value.trim());

  if (lots.length <= SELECT_UP_TO) {
    return (
      <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Pick a lot</option>
        {value && !picked && <option value={value}>{value}</option>}
        {lots.map((l) => <option key={l.lot_id} value={l.lot_id}>{label(l)}</option>)}
      </select>
    );
  }
  return (
    <>
      <input className="num" aria-label={ariaLabel} list={listId} value={value} placeholder={placeholder} autoComplete="off"
        onChange={(e) => onChange(e.target.value)} />
      <datalist id={listId}>{matches.map((l) => <option key={l.lot_id} value={l.lot_id}>{label(l)}</option>)}</datalist>
      {picked
        ? <span className="muted small">{label(picked)}</span>
        : value.trim() && !matches.length ? <span className="err small">No lot with stock matches “{value.trim()}”.</span> : null}
    </>
  );
}
