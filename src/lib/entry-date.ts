import { LedgerError } from './ledger-error';

export const todayEntryDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
export const displayEntryDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value.slice(8)}-${value.slice(5, 7)}-${value.slice(0, 4)}` : value;

export function entryDateValue(value: string, allowFuture = false): string {
  const s = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const dayFirst = /^(\d{2})(\d{2})(\d{4})$/.exec(s) ?? /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  const [year, month, day] = iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3])] : dayFirst ? [Number(dayFirst[3]), Number(dayFirst[2]), Number(dayFirst[1])] : [0, 0, 0];
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (year < 1000 || year > 9999 || dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    throw new LedgerError('Enter a valid date as DD-MM-YYYY or DDMMYYYY (for example, 29-10-2026).');
  }
  const result = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (!allowFuture && result > todayEntryDate()) throw new LedgerError('Entry date cannot be in the future.');
  return result;
}
export function entryDateError(value: string) {
  try { entryDateValue(value); return null; } catch (e) { return (e as Error).message; }
}
