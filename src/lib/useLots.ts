'use client';

// Lots from the server, never the whole list in the browser:
//   useLots()       → "Lots & balance" (GET /api/lots): filtered + keyset-paged, like useLedger
//   useLotSearch()  → lot pickers' type-ahead (GET /api/lots/search), debounced + cancellable + briefly cached
//   useLotsById()   → details of a few known lots (dispatch lines, reserved lots)
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Lot } from './types';

export interface LotFilterState { q: string; stock: '' | 'in'; status: string }
export const EMPTY_LOT_FILTERS: LotFilterState = { q: '', stock: '', status: '' };

export function lotParams(f: LotFilterState): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.stock === 'in') p.set('in_stock', '1');
  if (f.status) p.set('status', f.status);
  return p;
}

const PAGE = 100;

/** `refreshKey`: pass d.stockRev (reloads the first page only when stock changed). */
export function useLots(filters: LotFilterState, refreshKey?: unknown, enabled = true) {
  const [rows, setRows] = useState<Lot[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [totalCapped, setTotalCapped] = useState(false);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [forKey, setForKey] = useState<string | null>(null); // filters the shown rows / total belong to
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);
  const key = lotParams(filters).toString();
  const lastKey = useRef<string | null>(null);
  const holdUntil = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    if (holdUntil.current > Date.now() && lastKey.current === key) { holdUntil.current = 0; return; }
    holdUntil.current = 0;
    lastKey.current = key;
    const my = ++gen.current;
    const ctl = new AbortController();
    const p = new URLSearchParams(key);
    p.set('limit', String(PAGE));
    setLoading(true);
    fetch(`/api/lots?${p}`, { cache: 'no-store', signal: ctl.signal })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (my !== gen.current) return;
        if (!res.ok) throw new Error(data?.error || 'Could not load the lots.');
        setRows(data.rows ?? []);
        setTotal(data.total ?? 0);
        setTotalCapped(!!data.total_capped);
        setNext(data.next ?? null);
        setError(null);
      })
      .catch((e) => { if (my === gen.current && e?.name !== 'AbortError') setError(e instanceof Error ? e.message : 'Could not load the lots.'); })
      .finally(() => { if (my === gen.current) { setLoading(false); setForKey(key); } });
    return () => ctl.abort();
  }, [key, refreshKey, enabled]);

  const loadMore = useCallback(async () => {
    if (!next || loadingMore) return;
    const my = gen.current;
    setLoadingMore(true);
    try {
      const p = new URLSearchParams(key);
      p.set('limit', String(PAGE));
      p.set('cursor', next);
      const res = await fetch(`/api/lots?${p}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (my !== gen.current) return;
      if (!res.ok) throw new Error(data?.error || 'Could not load more lots.');
      setRows((r) => {
        const seen = new Set(r.map((x) => x.lot_id));
        return [...r, ...(data.rows as Lot[]).filter((x) => !seen.has(x.lot_id))];
      });
      setNext(data.next ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load more lots.');
    } finally {
      setLoadingMore(false);
    }
  }, [key, next, loadingMore]);

  /** Apply saved lot edits in place (keeps loaded pages + scroll). */
  const patchLots = useCallback((lots: Partial<Lot>[]) => {
    if (!lots.length) return;
    const byId = new Map(lots.map((l) => [l.lot_id, l]));
    setRows((rs) => rs.map((r) => { const u = byId.get(r.lot_id); return u ? { ...r, ...u } as Lot : r; }));
  }, []);
  /** The next `refreshKey` change (within 20 s) does not reload the first page. */
  const holdRefresh = useCallback(() => { holdUntil.current = Date.now() + 20_000; }, []);

  // `loading` is also true in the render between a filter change and its request starting.
  return { rows, total, totalCapped, hasMore: !!next, loading: loading || (forKey !== key && enabled), loadingMore, error, loadMore, patchLots, holdRefresh };
}

// ---------- type-ahead ----------
export interface PickLot { lot_id: string; quality?: string | null; design?: string | null; balance?: number; location?: string | null; status?: string | null }

const cache = new Map<string, { at: number; lots: PickLot[] }>();
const TTL_MS = 15_000;
function cached(url: string) {
  const c = cache.get(url);
  if (c && Date.now() - c.at < TTL_MS) return c.lots;
  return null;
}
function remember(url: string, lots: PickLot[]) {
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  cache.set(url, { at: Date.now(), lots });
}
/** Forget cached results (after a save changed balances / locations). */
export function forgetLotSearches() { cache.clear(); }

export interface LotSearchOpts { inStock?: boolean; quality?: string; limit?: number; enabled?: boolean; refreshKey?: unknown }

/**
 * Lots matching typed text (lot no. prefix first, then quality / design / location), from the server.
 * 150 ms debounce; a newer keystroke cancels the older request. `lots` is null until the first answer.
 */
export function useLotSearch(text: string, opts: LotSearchOpts = {}) {
  const { inStock = false, quality = '', limit = 20, enabled = true, refreshKey } = opts;
  const p = new URLSearchParams();
  p.set('q', text.trim());
  p.set('limit', String(limit));
  if (inStock) p.set('in_stock', '1');
  if (quality) p.set('quality', quality);
  const url = `/api/lots/search?${p}`;
  const [state, setState] = useState<{ url: string; lots: PickLot[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const lastRev = useRef(refreshKey);

  useEffect(() => {
    if (!enabled) return;
    if (lastRev.current !== refreshKey) { lastRev.current = refreshKey; cache.clear(); }
    const hit = cached(url);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- cached answer: show it without a request
    if (hit) { setState({ url, lots: hit }); setLoading(false); return; }
    const ctl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      fetch(url, { cache: 'no-store', signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('search failed'))))
        .then((j: { lots: PickLot[] }) => { remember(url, j.lots ?? []); setState({ url, lots: j.lots ?? [] }); setLoading(false); })
        .catch((e) => { if (e?.name !== 'AbortError') setLoading(false); });
    }, 150);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [url, enabled, refreshKey]);

  return { lots: state?.lots ?? null, fresh: state?.url === url, loading };
}

/** Details of these lots (≤ 50), e.g. a dispatch's lines. Reloads when the ids or `refreshKey` change. */
export function useLotsById(ids: string[], refreshKey?: unknown): Map<string, PickLot> {
  const key = [...new Set(ids.map((x) => x.trim()).filter(Boolean))].sort().slice(0, 50).join(',');
  const [map, setMap] = useState<Map<string, PickLot>>(() => new Map());
  useEffect(() => {
    if (!key) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/lots/search?ids=${encodeURIComponent(key)}`, { cache: 'no-store', signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { lots: PickLot[] } | null) => { if (j) setMap(new Map(j.lots.map((l) => [l.lot_id, l]))); })
        .catch(() => {});
    }, 120);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [key, refreshKey]);
  return map;
}
