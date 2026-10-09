'use client';

// Stock ledger rows from the server, filtered and paged (GET /api/stock/ledger).
// Filters change → first page reloads (older requests are cancelled). loadMore() appends the next page.
import { useCallback, useEffect, useRef, useState } from 'react';

export interface LedgerFilterState {
  q: string;
  direction: '' | 'IN' | 'OUT';
  quality: string;
  design: string;
  lot: string;
  party: string; // set by deep links (#ledger=…&party=…); shown as a removable chip
  from: string; // YYYY-MM-DD
  to: string;
}
export const EMPTY_FILTERS: LedgerFilterState = { q: '', direction: '', quality: '', design: '', lot: '', party: '', from: '', to: '' };

export interface LedgerRow {
  id: number; lot_id: string; direction: 'IN' | 'OUT'; meters: number; grey_meters: number | null; finished_meters: number | null;
  mill_name: string | null; weaver_name: string | null; party: string | null; source_doc_id: string | null; capture_event_id: number | null;
  sr_no: number | null; pieces: number | null; ts: string; imported: boolean; quality: string; design: string; is_today: boolean; location: string | null;
  edited?: boolean; // changed in the ledger's edit mode
  // Register fields (see src/lib/ledger-query.ts). kind 'adjustment' = opening adjustment, not a sale.
  kind?: 'normal' | 'adjustment';
  register_pct?: number | null; takes?: (number | null)[] | null; loc_code?: string | null;
  bill_pct?: number | null; billed_meters?: number | null; lot_status_code?: string | null; linked_sr?: string | null;
  reg_lot_no?: string | null;
}
export interface LedgerFacets { qualities: string[]; designs: string[]; byQuality: Record<string, string[]> }

/** Query string for the ledger / export (only the filters that are set). */
export function ledgerParams(f: LedgerFilterState): URLSearchParams {
  const p = new URLSearchParams();
  (Object.keys(f) as (keyof LedgerFilterState)[]).forEach((k) => { const v = f[k].trim(); if (v) p.set(k, v); });
  return p;
}
export const filtersActive = (f: LedgerFilterState) => Object.values(f).some((v) => v.trim() !== '');

const PAGE = 100;

/**
 * `refreshKey`: change it to reload the first page after a new entry — pass `d.stockRev` (changes only when stock
 * changed on the server), not the last sync time. Facets (quality / design lists) load once per screen.
 */
export function useLedger(filters: LedgerFilterState, refreshKey?: unknown) {
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [totalCapped, setTotalCapped] = useState(false); // total is a floor ("10,000+")
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [forKey, setForKey] = useState<string | null>(null); // filters the shown rows / total belong to
  const [error, setError] = useState<string | null>(null);
  const [facets, setFacets] = useState<LedgerFacets | null>(null);
  const gen = useRef(0); // ignores pages from an older filter set
  const key = ledgerParams(filters).toString();
  const lastKey = useRef<string | null>(null);
  const holdUntil = useRef(0); // see holdRefresh()
  const haveFacets = useRef(false); // facets reload with the data (refreshKey), not on every filter change
  const facetsKey = useRef<unknown>(undefined);

  useEffect(() => {
    // After an edit-mode save the rows are patched in place: skip the reload the data refresh would cause.
    if (holdUntil.current > Date.now() && lastKey.current === key) { holdUntil.current = 0; haveFacets.current = false; return; }
    holdUntil.current = 0;
    lastKey.current = key;
    const my = ++gen.current;
    const ctl = new AbortController();
    const p = new URLSearchParams(key);
    p.set('limit', String(PAGE));
    if (facetsKey.current !== refreshKey) { haveFacets.current = false; facetsKey.current = refreshKey; }
    if (!haveFacets.current) p.set('facets', '1');
    setLoading(true);
    fetch(`/api/stock/ledger?${p}`, { cache: 'no-store', signal: ctl.signal })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (my !== gen.current) return;
        if (!res.ok) throw new Error(data?.error || 'Could not load the ledger.');
        setRows(data.rows ?? []);
        setTotal(data.total ?? 0);
        setTotalCapped(!!data.total_capped);
        setNext(data.next ?? null);
        if (data.facets) { setFacets(data.facets); haveFacets.current = true; }
        setError(null);
      })
      .catch((e) => { if (my === gen.current && e?.name !== 'AbortError') setError(e instanceof Error ? e.message : 'Could not load the ledger.'); })
      .finally(() => { if (my === gen.current) { setLoading(false); setForKey(key); } });
    return () => ctl.abort();
  }, [key, refreshKey]);

  const loadMore = useCallback(async () => {
    if (!next || loadingMore) return;
    const my = gen.current;
    setLoadingMore(true);
    try {
      const p = new URLSearchParams(key);
      p.set('limit', String(PAGE));
      p.set('cursor', next);
      const res = await fetch(`/api/stock/ledger?${p}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (my !== gen.current) return;
      if (!res.ok) throw new Error(data?.error || 'Could not load more rows.');
      setRows((r) => {
        const seen = new Set(r.map((x) => x.id));
        return [...r, ...(data.rows as LedgerRow[]).filter((x) => !seen.has(x.id))];
      });
      setNext(data.next ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load more rows.');
    } finally {
      setLoadingMore(false);
    }
  }, [key, next, loadingMore]);

  /** Replace edited rows in place (keeps loaded pages + scroll). `lots`: new quality / design for every row of those lots. */
  const patchRows = useCallback((updated: LedgerRow[], lots: { lot_id: string; quality: string; design: string }[] = []) => {
    if (!updated.length && !lots.length) return;
    const byId = new Map(updated.map((r) => [r.id, r]));
    const byLot = new Map(lots.map((l) => [l.lot_id, l]));
    setRows((rs) => rs.map((r) => {
      const u = byId.get(r.id);
      const l = byLot.get(r.lot_id);
      if (!u && !l) return r; // untouched rows keep their identity (memoised table rows skip re-render)
      const base = u ?? r;
      return l ? { ...base, quality: l.quality, design: l.design } : base;
    }));
  }, []);
  /** The next `refreshKey` change (within 20 s) does not reload the first page. */
  const holdRefresh = useCallback(() => { holdUntil.current = Date.now() + 20_000; }, []);

  // `loading` is also true in the render between a filter change and its request starting.
  return { rows, total, totalCapped, hasMore: !!next, loading: loading || forKey !== key, loadingMore, error, facets, loadMore, patchRows, holdRefresh };
}

/** A value that follows `value` after `ms` without changes (search box). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
