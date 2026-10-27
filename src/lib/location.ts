// Lot locations (shared by browser and server).
//
// A place a person picks is always a market address: "<CODE> <shop> · Pipe <pipe>", e.g. "LM 245 · Pipe 3"
//   CODE  the market's initials (markets.code, 1–6 capital letters / digits) — LM = Landmark, RS = Raghuveer Scarlet
//   shop  required: digits with an optional letter, e.g. 245 or 12A (up to 8 characters; leading zeros dropped)
//   pipe  optional: a whole number 1–999, typed by hand ("03" is read as 3)
// Shown in full as "Landmark, shop 245, pipe 3" (describeLocation).
// "Floor" (job cards) and "Dispatched" (fully sent out) are written by the app itself, never picked.
// Older labels (Godown, Shop, "RRTM 245 · Pipe 3" …) stay on history rows as they were written.

export interface MarketShop { id: number; shop_no: string; active: boolean; uses: number }
export interface MarketInfo { id: number; name: string; code: string; active: boolean; sort_order: number; shops: MarketShop[] }
type MarketLike = Pick<MarketInfo, 'id' | 'name' | 'code' | 'active'>;

/** pipe: one or more pipes joined with ", " ("A25, B3"), or null. */
export interface MarketPlace { market: MarketLike; shop: string; pipe: string | null }

/** Set by the app only. */
export const SYSTEM_PLACES = ['Floor', 'Dispatched'] as const;
/** Fixed places used before markets (migration 014): kept on old rows, refused for new ones. */
export const OLD_PLACES = ['Godown', 'Shop'];

export const MARKET_NAME_MAX = 60;
export const PIPES_MAX = 10;

export const PIPE_ERROR = 'Pipe no.: letters and digits, like 3, A25 or ABCD256 (up to 12 characters).';
export const SHOP_ERROR = 'Shop no. must be digits, with an optional letter at the end, like 245 or 12A.';
export const CODE_ERROR = 'Initials: 1 to 6 letters or digits, like LM.';

type Check<T> = { ok: true; value: T } | { ok: false; error: string };

/** Market initials: upper case, no spaces. */
export function checkCode(v: unknown): Check<string> {
  const s = String(v ?? '').replace(/\s+/g, '').toUpperCase();
  if (!s) return { ok: false, error: 'Initials are required, like LM.' };
  return /^[A-Z0-9]{1,6}$/.test(s) ? { ok: true, value: s } : { ok: false, error: CODE_ERROR };
}

export function checkMarketName(v: unknown): Check<string> {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return { ok: false, error: 'Market name is required.' };
  if (s.length > MARKET_NAME_MAX) return { ok: false, error: `Market name: up to ${MARKET_NAME_MAX} characters.` };
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .&'()-]*$/u.test(s)) return { ok: false, error: 'Market name: letters, digits, spaces, . & \' ( ) or - only.' };
  return { ok: true, value: s };
}

/** "245", "12a", "0245" → "245", "12A", "245". */
export function checkShop(v: unknown): Check<string> {
  const s = String(v ?? '').replace(/\s+/g, '').toUpperCase().replace(/^0+(?=\d)/, '');
  if (!s) return { ok: false, error: 'Shop no. is required, like 245.' };
  return /^[1-9]\d{0,6}[A-Z]?$/.test(s) ? { ok: true, value: s } : { ok: false, error: SHOP_ERROR };
}

/** One pipe: letters / digits (and -), upper case, up to 12 characters. Leading zeros of a plain number dropped. */
export function checkOnePipe(v: unknown): Check<string> {
  const s = String(v ?? '').replace(/\s+/g, '').toUpperCase().replace(/^0+(?=\d+$)/, '');
  return /^[A-Z0-9][A-Z0-9-]{0,11}$/.test(s) ? { ok: true, value: s } : { ok: false, error: PIPE_ERROR };
}
/** Pipes (a list, or text split on commas / spaces): empty → null; otherwise "A25, B3" (no repeats, up to PIPES_MAX). */
export function checkPipe(v: unknown): Check<string | null> {
  const parts = (Array.isArray(v) ? v.map((x) => String(x ?? '')) : String(v ?? '').split(/[,;/\s]+/)).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return { ok: true, value: null };
  const out: string[] = [];
  for (const x of parts) {
    const c = checkOnePipe(x);
    if (!c.ok) return c;
    if (!out.includes(c.value)) out.push(c.value);
  }
  if (out.length > PIPES_MAX) return { ok: false, error: `Up to ${PIPES_MAX} pipes per location.` };
  return { ok: true, value: out.join(', ') };
}
/** "A25, B3" → ["A25", "B3"]. */
export const splitPipes = (p: string | null | undefined): string[] => (p ? p.split(/,\s*/).filter(Boolean) : []);

export function formatMarketLocation(code: string, shop: string, pipe?: number | string | null): string {
  const p = pipe == null ? '' : String(pipe).trim();
  return `${code.trim()} ${shop.trim()}${p ? ` · Pipe ${p}` : ''}`;
}

/** "Landmark, shop 245, pipe 3" */
export function describePlace(name: string, shop: string, pipe: string | number | null): string {
  const n = splitPipes(pipe == null ? null : String(pipe)).length;
  return `${name}, shop ${shop}${pipe != null && pipe !== '' ? `, ${n > 1 ? 'pipes' : 'pipe'} ${pipe}` : ''}`;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Read a typed / imported location against the firm's markets (active ones only unless `includeInactive`).
 * Accepts "LM 245 · Pipe 3", "LM 245 3", "LM 245 pipe 3", "Landmark 245 3", "Landmark shop 245, pipe 3", "LM 245".
 *   → { ok, place } | { ok: false, error } (market found but shop / pipe wrong) | null (no market at the start).
 */
export function parseMarketLocation(text: string, markets: MarketLike[], opts: { includeInactive?: boolean; codesOnly?: boolean } = {}):
  { ok: true; place: MarketPlace } | { ok: false; error: string } | null {
  const s = norm(String(text ?? ''));
  if (!s) return null;
  const list = markets.filter((m) => opts.includeInactive || m.active);
  // Longest name / code first, so "LM2 5" is never read as LM + "2 5".
  const tokens = list.flatMap((m) => [...(opts.codesOnly ? [] : [{ m, t: norm(m.name) }]), { m, t: m.code.toLowerCase() }]).sort((a, b) => b.t.length - a.t.length);
  const hit = tokens.find(({ t }) => s === t || s.startsWith(`${t} `));
  if (!hit) return null;
  const rest = s.slice(hit.t.length).replace(/[·,;]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = rest ? rest.split(' ') : [];
  if (words[0] === 'shop' || words[0] === 'no' || words[0] === 'no.') words.shift();
  if (!words.length) return { ok: false, error: `Shop no. is missing after ${hit.m.code}, like "${hit.m.code} 245 · Pipe 3".` };
  const shop = checkShop(words.shift());
  if (!shop.ok) return { ok: false, error: shop.error };
  if (words[0] === 'pipe' || words[0] === 'pipes' || words[0] === 'p' || words[0] === 'p.') words.shift();
  else if (words[0] && /^pipes?\d+$/.test(words[0])) words[0] = words[0].replace(/^pipes?/, '');
  const pipe = checkPipe(words);
  if (!pipe.ok) return { ok: false, error: pipe.error };
  return { ok: true, place: { market: hit.m, shop: shop.value, pipe: pipe.value } };
}

/** A stored label → full words for a tooltip ("Landmark, shop 245, pipe 3"); null for system / old labels. */
export function describeLocation(label: string | null | undefined, markets: MarketLike[]): string | null {
  if (!label) return null;
  const r = parseMarketLocation(label, markets, { includeInactive: true, codesOnly: true });
  if (!r || !r.ok) return null;
  return describePlace(r.place.market.name, r.place.shop, r.place.pipe);
}

/** Markets as "LM · Landmark, RS · Raghuveer Scarlet" (messages, Excel notes). */
export function marketList(markets: MarketLike[]): string {
  return markets.filter((m) => m.active).map((m) => `${m.code} · ${m.name}`).join(', ');
}
