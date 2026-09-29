'use client';

// Small data hook for Phase 2 screens: each screen fetches its own data from its own API,
// and reloads whenever the app's main data refreshes (ctx.d.lastSync) or after an action.
import { useCallback, useEffect, useState } from 'react';

export function useApi<T>(url: string | null, refreshKey?: unknown) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!url);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    fetch(url, { cache: 'no-store' })
      .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j?.error || 'Could not load.'); return j as T; })
      .then((j) => { if (alive) { setData(j); setError(null); setLoading(false); } })
      .catch((e) => { if (alive) { setError(e instanceof Error ? e.message : 'Could not load.'); setLoading(false); } });
    return () => { alive = false; };
  }, [url, refreshKey, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/** POST/PUT/PATCH/DELETE JSON; throws Error(message) on failure. */
export async function apiSend<T = Record<string, unknown>>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Request failed.');
  return data as T;
}

/** Query string for role + actor. Informational only: the server takes both from the session cookie. */
export function who(role: string, actor: string | null) {
  return `role=${encodeURIComponent(role)}${actor ? `&actor=${encodeURIComponent(actor)}` : ''}`;
}

function readHash(key: string): string | null {
  if (typeof window === 'undefined') return null;
  const m = window.location.hash.match(new RegExp(`[#&]${key}=([^&]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/** Deep link from an agent alert (e.g. "#order=41"): returns the value on first render and clears the hash.
 *  The hash is cleared in an effect: replaceState during render updates Next's Router mid-render. */
export function useTakeHash(key: string): string | null {
  const [value] = useState(() => readHash(key));
  useEffect(() => {
    if (value != null) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [value]);
  return value;
}
