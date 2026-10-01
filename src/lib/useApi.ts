'use client';

// Small data hook for Phase 2 screens: each screen fetches its own data from its own API,
// and reloads whenever the app's main data refreshes (ctx.d.lastSync) or after an action.
import { useCallback, useEffect, useState } from 'react';
import type { Tab } from './access';

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
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}
/** Every key=value of the current hash (values decoded), e.g. "#firm=parties&party=6" → { firm: 'parties', party: '6' }. */
function readHashAll(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const out: Record<string, string> = {};
  for (const part of window.location.hash.replace(/^#/, '').split('&')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1)); } catch { out[part.slice(0, i)] = part.slice(i + 1); }
  }
  return out;
}


/**
 * Open a deep link: set the URL hash, switch to the tab, and tell screens that are already open (same tab:
 * page.tsx does not remount a screen when its tab is chosen again) to read the hash again.
 * Screens read it with useTakeHash / useHashLink; the hash is cleared once read.
 */
export function openLink(go: (tab: Tab) => void, tab: Tab, hash?: string) {
  if (typeof window === 'undefined') return;
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash ? `#${hash}` : ''}`);
  go(tab);
  // history.replaceState does not fire 'hashchange' (and a real hash change would add a history entry): fire it ourselves.
  if (hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export interface HashLink { value: string | null; /** all keys of the hash when it was read */ all: Record<string, string>; /** changes on every new link, even to the same item */ n: number }

let clearTimer: ReturnType<typeof setTimeout> | null = null;
/** Clear the hash after every screen had its chance to read it (all readers read in the same render / event). */
function clearHashSoon() {
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    clearTimer = null;
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, 0);
}

/**
 * Deep link (e.g. "#order=41", "#firm=parties&party=6"): the value on first render, and again every time a new
 * link with this key arrives while the screen is open ('hashchange', which openLink fires). `n` changes on
 * every link so a screen can react to the same item being opened twice. The hash is cleared after reading.
 */
export function useHashLink(key: string): HashLink {
  const [link, setLink] = useState<HashLink>(() => ({ value: readHash(key), all: readHash(key) != null ? readHashAll() : {}, n: 0 }));
  useEffect(() => {
    const on = () => {
      const v = readHash(key);
      if (v != null) setLink((l) => ({ value: v, all: readHashAll(), n: l.n + 1 }));
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, [key]);
  // Cleared in an effect: replaceState during render updates Next's Router mid-render.
  useEffect(() => { if (link.value != null) clearHashSoon(); }, [link]);
  return link;
}

/** Deep link value for `key` (see useHashLink). Updates when a new link arrives while the screen is open. */
export function useTakeHash(key: string): string | null {
  return useHashLink(key).value;
}

/**
 * Scroll to and briefly highlight an element once it is on screen (lists load after the screen opens).
 * `target` is a CSS selector, or { text } to find the row (tr / .list-row / .card) in the main content showing that text.
 * Returns a cancel function. Gives up quietly after `timeout` ms.
 */
export function flashWhenReady(target: string | { text: string }, timeout = 5000): () => void {
  if (typeof window === 'undefined') return () => {};
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const find = (): HTMLElement | null => {
    if (typeof target === 'string') return document.querySelector<HTMLElement>(target);
    const want = target.text.trim().toLowerCase();
    if (!want) return null;
    const root = document.querySelector('main.content') ?? document.body;
    const rows = root.querySelectorAll<HTMLElement>('tr, .list-row, [data-find]');
    for (const r of Array.from(rows)) if ((r.textContent ?? '').toLowerCase().includes(want)) return r;
    return null;
  };
  const tick = () => {
    const el = find();
    if (el) {
      // Tall items (an inquiry with its reply): show the top, below the sticky header; rows: centre them.
      const tall = el.getBoundingClientRect().height > window.innerHeight * 0.5;
      if (tall) el.style.scrollMarginTop = '84px';
      el.scrollIntoView({ behavior: 'smooth', block: tall ? 'start' : 'center' });
      el.classList.remove('tb-flash');
      void el.offsetWidth; // restart the animation
      el.classList.add('tb-flash');
      setTimeout(() => el.classList.remove('tb-flash'), 2600);
      return;
    }
    if (Date.now() - t0 < timeout) timer = setTimeout(tick, 120);
  };
  timer = setTimeout(tick, 60);
  return () => { if (timer) clearTimeout(timer); };
}
