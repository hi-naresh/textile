import { LedgerError } from './ledger-error';
import type { Q } from './db';

export function seriesValue(raw: unknown): string {
  const value = String(raw ?? '').trim().toUpperCase();
  if (value && !/^[A-Z][A-Z0-9]{0,9}$/.test(value)) throw new LedgerError('SR prefix must start with a letter and contain up to 10 letters or digits.');
  return value;
}
export const srLabel = (number: number | null | undefined, series = '') => number == null ? '' : `${series ? series + '-' : ''}${number}`;
export function parseSr(raw: unknown, prefix?: unknown): { number: number | null; series: string } {
  const text = String(raw ?? '').replace(/,/g, '').trim();
  const match = /^([A-Za-z][A-Za-z0-9]{0,9})(?:-|\s+)(\d+)$/.exec(text);
  const series = seriesValue(match?.[1] ?? prefix);
  if (match && prefix && series !== seriesValue(prefix)) throw new LedgerError('The SR number prefix must match the selected series.');
  const digits = match?.[2] ?? text;
  if (!digits) return { number: null, series };
  const number = Number(digits);
  if (!/^\d+(\.0+)?$/.test(digits) || !Number.isSafeInteger(number) || number <= 0 || number > 2_000_000_000) throw new LedgerError('SR must be a whole number above 0, optionally prefixed (for example RS-104).');
  return { number, series };
}
export async function assertSeries(q: Q, series: string, cache?: Map<string, unknown>) {
  if (!series) return;
  const key = `sr-series:${series}`;
  let active = cache?.get(key);
  if (active === undefined) {
    active = Boolean((await q('SELECT active FROM sr_series WHERE prefix = $1', [series])).rows[0]?.active);
    cache?.set(key, active);
  }
  if (!active) throw new LedgerError(`SR series ${series} is not active. Add it in My firm → SR series first.`);
}
