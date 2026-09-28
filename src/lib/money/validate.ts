// Strict formats for money & master data (parties, rates, costs, billing).
// Every function throws LedgerError with a short, plain message the owner can act on.
import { LedgerError } from '../ledger-error';

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Standard GSTIN check digit (mod-36 over the first 14 characters). */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(first14[i]);
    if (v < 0) return '';
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

export function gstinValid(g: string): boolean {
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g) && gstinCheckChar(g.slice(0, 14)) === g[14];
}

/** GSTIN: optional; upper-cased, spaces removed; format + check digit verified. */
export function gstinValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const g = String(v).replace(/\s+/g, '').toUpperCase();
  if (!g) return null;
  if (!/^[0-9]{2}[A-Z0-9]{13}$/.test(g)) throw new LedgerError(`GSTIN "${g}" should be 15 characters: 2 digits then 13 letters/digits.`);
  if (!gstinValid(g)) throw new LedgerError(`GSTIN "${g}" is not valid — the last character does not match. Check for a typo.`);
  const st = Number(g.slice(0, 2));
  if (st < 1 || st > 38) throw new LedgerError(`GSTIN "${g}" starts with an unknown state code (${g.slice(0, 2)}).`);
  return g;
}

/** 2-digit GST state code (01–38). */
export function stateCodeValue(v: unknown): string | null {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const s = String(v).trim().padStart(2, '0');
  if (!/^[0-9]{2}$/.test(s) || Number(s) < 1 || Number(s) > 38) throw new LedgerError('State code must be 2 digits (01–38), e.g. 24 for Gujarat.');
  return s;
}

/** Indian mobile: 10 digits starting 6–9, optional +91 / 91 / 0 prefix. Stored as 10 digits. */
export function phoneValue(v: unknown, label = 'Phone'): string | null {
  if (v === null || v === undefined) return null;
  let s = String(v).replace(/[\s\-().]/g, '');
  if (!s) return null;
  if (s.startsWith('+91')) s = s.slice(3);
  else if (s.length === 12 && s.startsWith('91')) s = s.slice(2);
  else if (s.length === 11 && s.startsWith('0')) s = s.slice(1);
  if (!/^[6-9][0-9]{9}$/.test(s)) throw new LedgerError(`${label} should be a 10-digit mobile number (optionally with +91).`);
  return s;
}

/** Optional free text, trimmed, single spaces kept on one line unless multiline. */
export function textValue(v: unknown, label: string, max: number, multiline = false): string | null {
  if (v === null || v === undefined) return null;
  let s = String(v);
  s = multiline ? s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : s.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.length > max) throw new LedgerError(`${label} must be ${max} characters or fewer.`);
  return s;
}

/** ₹ amount with at most 2 decimals. */
export function rupeeValue(v: unknown, label: string, opts: { min?: number; max?: number; allowZero?: boolean; nullable?: boolean } = {}): number | null {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
    if (opts.nullable) return null;
    throw new LedgerError(`${label} is required.`);
  }
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[,₹\s]/g, ''));
  const min = opts.min ?? 0;
  const max = opts.max ?? 1e10;
  if (!Number.isFinite(n) || n < min || (n === 0 && !opts.allowZero)) throw new LedgerError(`${label} must be ${opts.allowZero ? `${min} or more` : 'more than 0'}.`);
  if (n > max) throw new LedgerError(`${label} looks too large. Check the number.`);
  return Math.round(n * 100) / 100;
}

export function intValue(v: unknown, label: string, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  if (!Number.isInteger(n) || n < min || n > max) throw new LedgerError(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
}

export function numValue(v: unknown, label: string, min: number, max: number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').trim());
  if (!Number.isFinite(n) || n < min || n > max) throw new LedgerError(`${label} must be between ${min} and ${max}.`);
  return Math.round(n * 100) / 100;
}

/** YYYY-MM-DD, real calendar date, within a sane window. null when empty. */
export function dateValue(v: unknown, label: string, opts: { notFuture?: boolean } = {}): string | null {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const s = String(v).trim().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  if (!m || !d || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new LedgerError(`${label} must be a date like 2026-09-28.`);
  if (+m[1] < 2000 || +m[1] > 2100) throw new LedgerError(`${label} looks wrong (${s}).`);
  if (opts.notFuture && s > todayIso()) throw new LedgerError(`${label} cannot be in the future.`);
  return s;
}

/** Today in India (IST), YYYY-MM-DD. */
export function todayIso(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

export function idValue(v: unknown, label: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new LedgerError(`A valid ${label} is required.`);
  return n;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** ₹48,000 / ₹1,25,000.50 — Indian grouping, for messages. */
export function rupees(n: number): string {
  const r = round2(n);
  return `₹${r.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/**
 * Run queries one after another. A transaction's `q` is one pg client, which must not get
 * overlapping queries (Promise.all would), so money code always uses this instead.
 */
export async function seq<T extends readonly (() => Promise<unknown>)[]>(fns: [...T]): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const out: unknown[] = [];
  for (const f of fns) out.push(await f());
  return out as { [K in keyof T]: Awaited<ReturnType<T[K]>> };
}
