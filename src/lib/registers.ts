// The firm's own registers (Incoming lot register, Outgoing sales register): labels, guesses and value checks.
// Client-safe (no database): used by the import (server), manual entry, ledger edit mode and the ledger rows.
// What the ambiguous columns mean is NOT confirmed by the owner — see docs/AMBIGUOUS.md. The app stores them as data.
import { LedgerError } from './ledger-error';

/** LOT S codes in the sales register. Our best guess from the data (docs/AMBIGUOUS.md §1) — shown as a hint only. */
export const LOT_S_GUESS: Record<string, string> = {
  S: 'Start — first sale from this lot, more left (our guess)',
  R: 'Running — a sale from a lot already started, more left (our guess)',
  E: 'End — last sale, lot finished (our guess)',
  A: 'All — whole lot sold in one go (our guess)',
};
export const lotSHint = (code: string | null | undefined) => {
  if (!code) return '';
  const g = LOT_S_GUESS[code.toUpperCase()];
  return g ? `LOT S “${code}”: ${g}. Not confirmed — data only, balances don’t use it.` : `LOT S “${code}”: meaning not known. Data only.`;
};

export const ADJUSTMENT_LABEL = 'Opening adjustment (register)';
export const ADJUSTMENT_HINT = 'Meters already taken out of this lot before the import (S-1…S-10 in the Incoming register), so the balance matches the register’s STOCK. Not a sale.';
export const PCT_HINT = 'The “%” column of the Incoming register (meaning not confirmed).';
export const L_HINT = 'The “L” column of the sales register. Billed meters (NQTY) = QTY × L ÷ 100. Meaning not confirmed.';

const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';
const toNum = (v: unknown) => (typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').replace(/%$/, '').trim()));

/** Incoming "%": a number 0–100 (2 decimals), or null. */
export function registerPctValue(v: unknown): number | null {
  if (blank(v)) return null;
  const n = toNum(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new LedgerError(`% must be a number from 0 to 100 (got "${String(v).trim().slice(0, 20)}").`);
  return Math.round(n * 100) / 100;
}

/** Register location code as written: "212", "142+143", "56+57+l". Letters, digits, + - / . and spaces. */
export function locCodeValue(v: unknown): string | null {
  if (blank(v)) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (s.length > 40) throw new LedgerError('Location code must be 40 characters or fewer.');
  if (!/^[A-Za-z0-9][A-Za-z0-9 +\-/.]*$/.test(s)) throw new LedgerError(`Location code "${s.slice(0, 20)}" can only use letters, digits, "+", "-", "/" and ".".`);
  return s;
}

/** Sales register "L": a number above 0 (≤ 1000), or null. */
export function billPctValue(v: unknown): number | null {
  if (blank(v)) return null;
  const n = toNum(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1000) throw new LedgerError(`L must be a number above 0 (got "${String(v).trim().slice(0, 20)}").`);
  return Math.round(n * 100) / 100;
}

/** NQTY (billed meters): a number 0 or more (4 decimals kept, as the register's formula gives), or null. */
export function billedMetersValue(v: unknown): number | null {
  if (blank(v)) return null;
  const n = toNum(v);
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw new LedgerError(`NQTY (billed meters) must be a number, 0 or more (got "${String(v).trim().slice(0, 20)}").`);
  return Math.round(n * 10000) / 10000;
}

/** LOT S code: 1–5 letters / digits, stored upper-case, or null. */
export function lotStatusCodeValue(v: unknown): string | null {
  if (blank(v)) return null;
  const s = String(v).trim().toUpperCase();
  if (!/^[A-Z0-9]{1,5}$/.test(s)) throw new LedgerError(`LOT S must be a short code like R, E, S or A (got "${String(v).trim().slice(0, 20)}").`);
  return s;
}

/** Register serial as text (SR.NO): "102" or a combined "146+204". */
export function linkedSrValue(v: unknown): string | null {
  if (blank(v)) return null;
  const s = String(v).replace(/\s+/g, '').trim();
  if (s.length > 40 || !/^[A-Za-z0-9+\-/.]+$/.test(s)) throw new LedgerError(`SR.NO "${String(v).trim().slice(0, 20)}" is not valid.`);
  return s;
}
