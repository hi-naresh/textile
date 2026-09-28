// Small helpers shared by the Sales agents (inquiries, orders, allocation).
import type { Q } from '../db';
import { LedgerError } from '../ledger-error';

/** Today's date in India (the firm's day), as YYYY-MM-DD. */
export function todayIST(now = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function isRealDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/** Optional date field: '' / null → null; otherwise must be a real YYYY-MM-DD date. */
export function dateValue(v: unknown, label: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().slice(0, 10);
  if (!isRealDate(s)) throw new LedgerError(`${label} must be a date (YYYY-MM-DD).`);
  const y = Number(s.slice(0, 4));
  if (y < 2000 || y > 2100) throw new LedgerError(`${label} looks wrong (${s}).`);
  return s;
}

/** Optional ₹/m rate: '' / null → null; otherwise a positive number with ≤ 2 decimals. */
export function rateValue(v: unknown, label = 'Rate'): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[₹,\s]/g, ''));
  if (!Number.isFinite(n) || n <= 0) throw new LedgerError(`${label} must be a positive number.`);
  if (n > 100_000) throw new LedgerError(`${label} looks too large (${n}). Check the number.`);
  return Math.round(n * 100) / 100;
}

export function idValue(v: unknown, label: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new LedgerError(`A valid ${label} is required.`);
  return n;
}

export const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export const round2 = (n: number) => Math.round(n * 100) / 100;

/** created_by columns reference users(id): keep the actor only if it is a known user. */
export async function knownActor(q: Q, actor: string | null): Promise<string | null> {
  if (!actor) return null;
  const r = await q(`SELECT id FROM users WHERE id = $1`, [actor]);
  return r.rows[0] ? actor : null;
}

/** Plain meters for messages: 2000 → "2,000", 12.5 → "12.5". */
export function meters(n: number): string {
  return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 1 });
}
