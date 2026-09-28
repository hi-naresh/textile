'use client';

// Browser side of sessions. The browser never sees a token: both live in httpOnly cookies.
// installAuthFetch() makes every /api call recover from an expired access token on its own:
// on 401 it refreshes once (shared by all requests in flight) and retries; if the session is
// really gone it sends the person to the sign-in page.

export type AccountRole = 'owner' | 'supervisor' | 'worker' | 'developer';
export interface MeUser {
  id: string; name: string; role: AccountRole | null; status: 'pending' | 'approved' | 'rejected';
  phone: string | null; email: string | null; workerId: string | null; mustChangePassword: boolean;
}
export interface Me { kind: 'client' | 'developer'; user: MeUser; viewAs: MeUser | null; viewAsSince: string | null; viewAsWrite: boolean }

const AUTH_PATHS = ['/api/auth/'];
let refreshing: Promise<boolean> | null = null;
let installed = false;
let nativeFetch: typeof fetch;

export function refreshNow(): Promise<boolean> {
  refreshing ??= nativeFetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => { setTimeout(() => { refreshing = null; }, 0); });
  return refreshing;
}

export function loginPath(): string {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/dev') ? '/dev/login' : '/login';
}

function toLogin() {
  const p = loginPath();
  if (window.location.pathname !== p) window.location.replace(p);
}

export function installAuthFetch() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await nativeFetch(input, init);
    if (res.status !== 401) return res;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const path = url.startsWith('http') ? new URL(url).pathname : url;
    if (!path.startsWith('/api/') || AUTH_PATHS.some((p) => path.startsWith(p))) return res;
    if (await refreshNow()) return nativeFetch(input, init);
    toLogin();
    return res;
  };
  // Keep the access token fresh while the app is open, and after the phone wakes up.
  const tick = () => { if (document.visibilityState === 'visible') refreshNow(); };
  setInterval(tick, 10 * 60 * 1000);
  document.addEventListener('visibilitychange', tick);
}

/** Who is signed in; null when nobody (after trying the refresh token once). */
export async function fetchMe(): Promise<Me | null> {
  const f = installed ? nativeFetch : fetch;
  let r = await f('/api/auth/me', { cache: 'no-store' });
  if (r.status === 401 && (await (installed ? refreshNow() : f('/api/auth/refresh', { method: 'POST' }).then((x) => x.ok)))) {
    r = await f('/api/auth/me', { cache: 'no-store' });
  }
  if (!r.ok) {
    if (r.status === 401) return null;
    throw new Error('Something went wrong, try again.');
  }
  return r.json();
}

export async function logout(to = '/login') {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* offline: cookies expire on their own */ }
  window.location.replace(to);
}

export async function postJson<T = Record<string, unknown>>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || 'Something went wrong, try again.');
  return data as T;
}
