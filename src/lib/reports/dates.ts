// Report periods (day / week / month) as plain YYYY-MM-DD strings. "Today" always comes from the
// database (CURRENT_DATE) so reports agree with every other today-figure in the app.
import type { Q } from '../db';
import { LedgerError } from '../ledger-error';

export type ReportPeriod = 'day' | 'week' | 'month';
export const REPORT_PERIODS: ReportPeriod[] = ['day', 'week', 'month'];

export interface Range {
  period: ReportPeriod;
  from: string; // inclusive
  to: string; // inclusive (capped at today for the current week / month)
  prevFrom: string;
  prevTo: string;
  partial: boolean; // the period is still running (to = today, before its natural end)
  label: string; // "Mon, 28 Sep 2026" · "Week of 21 Sep 2026" · "September 2026"
  rangeText: string; // "21–27 Sep 2026"
  prevLabel: string; // "previous day" / "previous week" …
}

const D = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export const daysBetween = (a: string, b: string) => Math.round((D(b).getTime() - D(a).getTime()) / 86_400_000);
const minDate = (a: string, b: string) => (a < b ? a : b);
export const isIsoDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(D(s).getTime()) && iso(D(s)) === s;

const fmtDay = (s: string, opts: Intl.DateTimeFormatOptions) => D(s).toLocaleDateString('en-IN', { timeZone: 'UTC', ...opts });
export const shortDate = (s: string) => fmtDay(s, { day: 'numeric', month: 'short' });
const longDate = (s: string) => fmtDay(s, { day: 'numeric', month: 'short', year: 'numeric' });

export async function dbToday(q: Q): Promise<string> {
  const r = await q(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`);
  return String(r.rows[0].d);
}

/** Monday of the ISO week holding `s`. */
export function weekStart(s: string): string {
  const dow = (D(s).getUTCDay() + 6) % 7; // Mon = 0
  return addDays(s, -dow);
}

function textRange(from: string, to: string): string {
  if (from === to) return longDate(from);
  const a = D(from), b = D(to);
  if (a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()) return `${a.getUTCDate()}–${longDate(to)}`;
  return `${shortDate(from)} – ${longDate(to)}`;
}

/** Period holding `date` (default: today). Dates after tomorrow are refused. */
export function rangeFor(period: ReportPeriod, date: string, today: string): Range {
  if (!REPORT_PERIODS.includes(period)) throw new LedgerError('period must be day, week or month.');
  if (!isIsoDate(date)) throw new LedgerError('date must be YYYY-MM-DD.');
  // A phone ahead of the server's clock (time zones) may send "tomorrow": treat it as today.
  if (date > addDays(today, 1)) throw new LedgerError('That date is in the future.');
  if (date > today) date = today;
  if (period === 'day') {
    const p = addDays(date, -1);
    return { period, from: date, to: date, prevFrom: p, prevTo: p, partial: date === today, label: fmtDay(date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }), rangeText: longDate(date), prevLabel: 'previous day' };
  }
  if (period === 'week') {
    const from = weekStart(date);
    const end = addDays(from, 6);
    const to = minDate(end, today);
    return { period, from, to, prevFrom: addDays(from, -7), prevTo: addDays(to, -7), partial: to < end, label: `Week of ${longDate(from)}`, rangeText: textRange(from, to), prevLabel: to < end ? 'same days last week' : 'previous week' };
  }
  const d = D(date);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const from = iso(new Date(Date.UTC(y, m, 1)));
  const end = iso(new Date(Date.UTC(y, m + 1, 0)));
  const to = minDate(end, today);
  const prevFrom = iso(new Date(Date.UTC(y, m - 1, 1)));
  const prevEnd = iso(new Date(Date.UTC(y, m, 0)));
  const prevTo = minDate(addDays(prevFrom, daysBetween(from, to)), prevEnd);
  return {
    period, from, to, prevFrom, prevTo, partial: to < end,
    label: fmtDay(from, { month: 'long', year: 'numeric' }), rangeText: textRange(from, to),
    prevLabel: to < end ? 'same days last month' : 'previous month',
  };
}
