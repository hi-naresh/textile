'use client';

// Lot chooser that stays fast at any size: lots come from the server (GET /api/lots/search), never the whole list.
// A firm with only a few matching lots gets a plain dropdown; otherwise type-to-search (lot no., quality or design)
// with the best 20 matches, 150 ms after the last keystroke (older requests are cancelled).
import React, { useEffect, useId, useRef } from 'react';
import { fmt } from './ui';
import { useLotSearch, type PickLot } from '@/lib/useLots';

export type { PickLot } from '@/lib/useLots';

const MAX = 30;
const SELECT_UP_TO = 60;

/** Best matches for typed text in a list already in the browser: lot numbers starting with it first, then any field containing it. */
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

export const lotLabel = (l: PickLot) =>
  [l.lot_id, l.quality, l.balance != null ? `${fmt(l.balance, 1)} m` : null, l.location].filter(Boolean).join(' · ');

/**
 * `inStock` (default true): only lots with a balance. `quality`: only that quality.
 * `onPick`: the chosen lot's details (balance, location…) or null while the text matches no lot.
 * `autoFirst`: with a short list (dropdown), pick the first lot when nothing is chosen yet.
 * `refreshKey`: pass d.stockRev so balances shown stay current after saves.
 */
export function LotPicker({ value, onChange, onPick, ariaLabel, placeholder = 'Type lot no., quality or design', inStock = true, quality, autoFirst = false, refreshKey, listId: listIdProp }: {
  value: string;
  onChange: (lotId: string) => void;
  onPick?: (lot: PickLot | null) => void;
  ariaLabel?: string;
  placeholder?: string;
  inStock?: boolean;
  quality?: string;
  autoFirst?: boolean;
  refreshKey?: unknown;
  listId?: string;
}) {
  const autoId = useId();
  const listId = listIdProp ?? autoId;
  // Probe: how many lots are there to choose from? (≤ 60 → a plain dropdown, like before)
  const probe = useLotSearch('', { inStock, quality, limit: SELECT_UP_TO + 1, refreshKey });
  const small = probe.lots != null && probe.lots.length <= SELECT_UP_TO;
  const typed = useLotSearch(value, { inStock, quality, limit: 20, enabled: probe.lots != null && !small, refreshKey });
  const pool = small ? probe.lots! : typed.lots ?? [];
  const want = value.trim().toLowerCase();
  const picked = want ? pool.find((l) => l.lot_id.toLowerCase() === want) ?? null : null;

  // Tell the parent about the chosen lot (details for balance checks / hints).
  const pickRef = useRef(onPick);
  useEffect(() => { pickRef.current = onPick; });
  const pickedKey = picked ? `${picked.lot_id}|${picked.balance}|${picked.location}|${picked.quality}` : '';
  useEffect(() => { pickRef.current?.(picked); }, [pickedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const first = small ? probe.lots![0]?.lot_id : undefined;
  useEffect(() => { if (autoFirst && small && !value && first) onChange(first); }, [autoFirst, small, value, first, onChange]);

  if (probe.lots == null) {
    return <input className="num" aria-label={ariaLabel} value={value} placeholder="Loading lots…" autoComplete="off" onChange={(e) => onChange(e.target.value)} />;
  }
  if (small) {
    const lots = probe.lots;
    return (
      <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{lots.length ? 'Pick a lot' : 'No lots with stock'}</option>
        {value && !picked && <option value={value}>{value}</option>}
        {lots.map((l) => <option key={l.lot_id} value={l.lot_id}>{lotLabel(l)}</option>)}
      </select>
    );
  }
  const matches = typed.lots ?? [];
  return (
    <>
      <input className="num" aria-label={ariaLabel} list={listId} value={value} placeholder={placeholder} autoComplete="off"
        onChange={(e) => onChange(e.target.value)} />
      <datalist id={listId}>{matches.map((l) => <option key={l.lot_id} value={l.lot_id}>{lotLabel(l)}</option>)}</datalist>
      {picked
        ? <span className="muted small">{lotLabel(picked)}</span>
        : want && typed.fresh && !typed.loading && !matches.length
          ? <span className="err small">No lot{inStock ? ' with stock' : ''} matches “{value.trim()}”.</span>
          : null}
    </>
  );
}
