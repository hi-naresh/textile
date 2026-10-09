// The firm's own Excel registers as import formats (server-side only). Used by src/lib/stock-import.ts.
//   (a) Incoming register:  DATE | SRNO | LOT NO | MTR | TAKA | % | LOCATION | MILL | WEAVER | S-1 … S-10 | STOCK | ITEM
//   (b) Outgoing register:  DATE | BNO | ITEM | L | LOT | LOT S | QTY | NQTY | SR.NO
// Headings are matched loosely (case, spaces, dots, "LOCTION", " STOCK", "SR.NO" / "SRNO" / "SR NO", "LOT NO" / "LOT").
//
// Incoming row → a new lot + an IN movement of MTR (date, SR, taka, mill, weaver, quality, %, location code, S-1…S-10)
//   + an "opening adjustment" OUT of MTR − STOCK (kind = 'adjustment', no party) so the lot's balance equals STOCK
//   (STOCK "E"/"e" = ended = 0).
// Outgoing row → an OUT movement on the lot whose incoming entry has SR = SR.NO (bill no. → challan no.; L, NQTY,
//   LOT S and the SR.NO text stored as given). No party in this register: imported OUT rows have none.
// Two severities: errors (bad number / date, missing value, duplicate SR) block the file; warnings either skip the row
// (it can't be placed: combined lots, SR not found, empty bill row, not enough stock …) or only inform (quality
// differs, STOCK disagrees with MTR − S-1…S-10, date in the future). Open questions: docs/AMBIGUOUS.md.
import { createHash } from 'crypto';
import type { Q } from './db';
import { LedgerError } from './ledger-error';
import { DISPATCHED, currentPlace, importRef, lockLot, lotAttrMemo, moveLot, nameMemo, piecesValue, srValue, staleOnce, type LedgerMemo } from './ledger';
import { trimReservations } from './stock';
import { challanCode, lotCode, metersValue, nameKey, nameValue } from './normalize';
import { billPctValue, billedMetersValue, linkedSrValue, locCodeValue, lotStatusCodeValue, registerPctValue } from './registers';

export type RegisterFormat = 'incoming' | 'outgoing';
export const NO_DESIGN = 'No design'; // the registers have no design; lots need one

type InKey = 'date' | 'sr' | 'lot' | 'mtr' | 'taka' | 'pct' | 'loc' | 'mill' | 'weaver' | 'stock' | 'item'
  | 's1' | 's2' | 's3' | 's4' | 's5' | 's6' | 's7' | 's8' | 's9' | 's10';
type OutKey = 'date' | 'bno' | 'item' | 'l' | 'lot' | 'lots' | 'qty' | 'nqty' | 'sr';
export interface RegCol<K extends string> { key: K; header: string; aliases: string[]; required?: boolean; width: number; note: string }

const TAKES = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'] as const;

/** Incoming register columns in the firm's order. `header` is what our template writes. */
export const INCOMING_COLUMNS: RegCol<InKey>[] = [
  { key: 'date', header: 'DATE', aliases: ['DT', 'Dated'], required: true, width: 12, note: 'Date the lot came in.' },
  { key: 'sr', header: 'SRNO', aliases: ['SR', 'SR NO', 'SR.NO', 'SR Number', 'Serial No'], required: true, width: 7, note: 'Register serial. Whole number, never repeats. The sales register’s SR.NO points to it.' },
  { key: 'lot', header: 'LOT NO', aliases: ['LOT', 'LOTNO', 'Lot Number'], required: true, width: 10, note: 'Lot number (mill’s).' },
  { key: 'mtr', header: 'MTR', aliases: ['MTRS', 'Meter', 'Meters', 'Mts'], required: true, width: 10, note: 'Meters received.' },
  { key: 'taka', header: 'TAKA', aliases: ['Pcs', 'Pieces', 'Than'], width: 7, note: 'Pieces (taka). Whole number. Optional.' },
  { key: 'pct', header: '%', aliases: ['PCT', 'Percent'], width: 7, note: 'The register’s % (kept as given). Optional.' },
  { key: 'loc', header: 'LOCATION', aliases: ['LOCTION', 'LOC', 'Locn'], width: 10, note: 'Location code as you write it: 212, 142+143. Optional.' },
  { key: 'mill', header: 'MILL', aliases: ['Mill Name', 'Mill Code'], width: 8, note: 'Mill code (L, D, H …). Optional.' },
  { key: 'weaver', header: 'WEAVER', aliases: ['Weaver Name'], width: 18, note: 'Weaver name. Optional.' },
  ...TAKES.map((k, i): RegCol<InKey> => ({ key: k, header: `S-${i + 1}`, aliases: [], width: 8, note: i === 0 ? 'S-1 … S-10: meters already taken out of the lot. Optional.' : '' })),
  { key: 'stock', header: 'STOCK', aliases: ['Balance', 'Bal', 'Stk'], width: 9, note: 'What is left: MTR − S-1…S-10, or E when the lot is finished. Optional (worked out when empty).' },
  { key: 'item', header: 'ITEM', aliases: ['Quality', 'Item Name'], required: true, width: 24, note: 'Quality name.' },
];

export const OUTGOING_COLUMNS: RegCol<OutKey>[] = [
  { key: 'date', header: 'DATE', aliases: ['DT', 'Dated'], required: true, width: 12, note: 'Bill date.' },
  { key: 'bno', header: 'BNO', aliases: ['B NO', 'BILL NO', 'BILL', 'Bill Number', 'Challan No', 'Challan', 'Invoice No'], required: true, width: 8, note: 'Bill / challan number. One bill can have many rows.' },
  { key: 'item', header: 'ITEM', aliases: ['Quality', 'Item Name'], width: 24, note: 'Quality sold (checked against the lot’s quality).' },
  { key: 'l', header: 'L', aliases: [], width: 6, note: 'L (kept as given; NQTY = QTY × L ÷ 100). Optional.' },
  { key: 'lot', header: 'LOT', aliases: ['LOT NO', 'LOTNO'], width: 10, note: 'Lot number.' },
  { key: 'lots', header: 'LOT S', aliases: ['LOTS', 'LOT ST', 'Lot Status'], width: 6, note: 'LOT S code (R / E / S / A), kept as given. Optional.' },
  { key: 'qty', header: 'QTY', aliases: ['Quantity', 'MTR', 'Meters'], required: true, width: 10, note: 'Meters out of the lot.' },
  { key: 'nqty', header: 'NQTY', aliases: ['N QTY', 'Net Qty', 'Billed Qty'], width: 10, note: 'Billed meters (kept as given). Optional.' },
  { key: 'sr', header: 'SR.NO', aliases: ['SRNO', 'SR NO', 'SR'], width: 8, note: 'SRNO of the lot in the Incoming register — this is how the sale finds its lot.' },
];

// ---------- headings ----------
/** "SR.NO" → "srno", "%" → "pct", " STOCK" → "stock", "S-1" → "s1". */
export const hnorm = (h: string) => h.toLowerCase().replace(/%/g, 'pct').replace(/[^a-z0-9]/g, '');

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length];
}

export interface HeaderCell { col: number; text: string }
export interface RegHeader<K extends string> {
  colFor: Map<number, K>;
  textFor: Map<K, string>;
  fuzzy: { header: string; as: string }[]; // read with a small spelling difference
  unknown: string[];
  repeats: string[];
  score: number; // distinct columns recognised (S-1…S-10 count once)
}

export function mapRegisterHeader<K extends string>(cells: HeaderCell[], cols: RegCol<K>[]): RegHeader<K> {
  const exact = new Map<string, K>();
  for (const c of cols) for (const h of [c.header, ...c.aliases]) if (!exact.has(hnorm(h))) exact.set(hnorm(h), c.key);
  const out: RegHeader<K> = { colFor: new Map(), textFor: new Map(), fuzzy: [], unknown: [], repeats: [], score: 0 };
  const pending: HeaderCell[] = [];
  for (const cell of cells) {
    const k = exact.get(hnorm(cell.text));
    if (!k) { pending.push(cell); continue; }
    if (out.textFor.has(k)) { out.repeats.push(cell.text); continue; }
    out.colFor.set(cell.col, k);
    out.textFor.set(k, cell.text);
  }
  // One letter off ("LOCTION", "WEVER"), only for longer names and only for columns not found yet.
  for (const cell of pending) {
    const n = hnorm(cell.text);
    let hit: { key: K; header: string } | null = null;
    if (n.length >= 4) {
      for (const c of cols) {
        if (out.textFor.has(c.key)) continue;
        if ([c.header, ...c.aliases].some((h) => hnorm(h).length >= 4 && editDistance(n, hnorm(h)) <= 1)) { hit = { key: c.key, header: c.header }; break; }
      }
    }
    if (hit) {
      out.colFor.set(cell.col, hit.key);
      out.textFor.set(hit.key, cell.text);
      out.fuzzy.push({ header: cell.text, as: hit.header });
    } else if (cell.text.trim()) out.unknown.push(cell.text);
  }
  const keys = new Set([...out.textFor.keys()].map((k) => (TAKES as readonly string[]).includes(k) ? 's' : k));
  out.score = keys.size;
  return out;
}

/** Which register a heading row looks like, or null. */
export function detectRegister(cells: HeaderCell[]): { format: RegisterFormat; inH: RegHeader<InKey>; outH: RegHeader<OutKey> } | null {
  const inH = mapRegisterHeader(cells, INCOMING_COLUMNS);
  const outH = mapRegisterHeader(cells, OUTGOING_COLUMNS);
  // At least 4 known columns, 2 of them found only in that register (so a missing MTR / QTY is reported, not guessed).
  const only = <K extends string>(h: RegHeader<K>, keys: string[]) => keys.filter((k) => (h.textFor as Map<string, string>).has(k)).length;
  const inOk = inH.score >= 4 && only(inH, ['mtr', 'taka', 'pct', 'loc', 'mill', 'weaver', 'stock', 's1']) >= 2;
  const outOk = outH.score >= 4 && only(outH, ['bno', 'l', 'lots', 'qty', 'nqty']) >= 2;
  if (inOk && (!outOk || inH.score > outH.score)) return { format: 'incoming', inH, outH };
  if (outOk && (!inOk || outH.score > inH.score)) return { format: 'outgoing', inH, outH };
  return null;
}

// ---------- rows ----------
export interface RegInRow {
  fmt: 'reg_in'; row: number; ref: string; adj_ref: string;
  date: string; sr_no: number; lot_id: string; reg_lot_no: string; meters: number; pieces: number | null;
  register_pct: number | null; loc_code: string | null; mill_name: string | null; weaver_name: string | null; quality: string;
  takes: (number | null)[]; stock: number; adjustment: number; ended: boolean;
}
export interface RegOutRow {
  fmt: 'reg_out'; row: number; ref: string;
  date: string; bill_no: string; quality: string | null; bill_pct: number | null; lot_raw: string | null; lot_id: string;
  lot_status_code: string | null; meters: number; billed_meters: number | null; linked_sr: string | null;
}
export interface RegProblem { row: number; field: string; message: string }
export interface RegWarning extends RegProblem { skip: boolean }
export interface RawRow<K extends string> { row: number; v: Partial<Record<K, unknown>> }
export interface RegCheck<R> {
  rows: R[];
  errors: RegProblem[];
  warnings: RegWarning[];
  notes: string[];
  alreadySaved: number;
  skipped: Set<number>;
  newLots: number;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 20);
const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';
const round2 = (n: number) => Math.round(n * 100) / 100;
const fmtDate = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Register date: a date cell, "21-03-2026", "21/3/26", "2026-03-21" or an Excel day number. Day comes first. */
export function registerDate(v: unknown): string {
  if (blank(v)) throw new LedgerError('Date is empty.');
  let y: number, m: number, d: number;
  const s = String(v).trim();
  let x: RegExpMatchArray | null;
  if (typeof v === 'number' || /^\d{5}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n < 20000 || n > 80000) throw new LedgerError(`"${s}" is not a date.`);
    const t = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
    [y, m, d] = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
  } else if ((x = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) {
    [y, m, d] = [Number(x[1]), Number(x[2]), Number(x[3])];
  } else if ((x = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) {
    [d, m, y] = [Number(x[1]), Number(x[2]), Number(x[3])];
    if (y < 100) y += 2000;
  } else throw new LedgerError(`"${s.slice(0, 20)}" is not a date. Use a date like 21-03-2026.`);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (y < 2000 || y > 2100 || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) throw new LedgerError(`"${s.slice(0, 20)}" is not a real date.`);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** A number cell (meters): must be a number ≥ 0. */
function numberCell(v: unknown, label: string): number | null {
  if (blank(v)) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  if (!Number.isFinite(n)) throw new LedgerError(`${label} "${String(v).trim().slice(0, 20)}" is not a number.`);
  if (n < 0) throw new LedgerError(`${label} can't be negative (${n}).`);
  if (n > 1_000_000) throw new LedgerError(`${label} looks too large (${n}).`);
  return round2(n);
}
/** Lot / SR text as written in the register: "23133", "FP-K-12", "172+173". */
const rawText = (v: unknown) => (blank(v) ? null : String(v).replace(/\s+/g, ' ').trim());
const lotKey = (s: string) => s.toUpperCase().replace(/\s+/g, '');

type Try = <T>(row: number, field: string, fn: () => T) => T | null;
function collector() {
  const errors: RegProblem[] = [];
  const warnings: RegWarning[] = [];
  const tryField: Try = (row, field, fn) => {
    try { return fn(); } catch (e) {
      if (e instanceof LedgerError) { errors.push({ row, field, message: e.message }); return null; }
      throw e;
    }
  };
  return { errors, warnings, tryField };
}

// ---------- (a) Incoming register ----------
export async function checkIncoming(q: Q, raw: RawRow<InKey>[], hasStockCol: boolean): Promise<RegCheck<RegInRow>> {
  const { errors, warnings, tryField } = collector();
  const notes: string[] = [];
  const today = todayIso();
  type P = Omit<RegInRow, 'lot_id' | 'ref' | 'adj_ref'> & { lotRaw: string };
  const parsed: P[] = [];
  let ranOver = 0; // ended lots where S-1…S-10 add up to more than MTR
  const firstSr = new Map<number, number>();
  const preSkipped = new Set<number>();

  for (const { row, v } of raw) {
    const nErr = errors.length;
    const date = tryField(row, 'DATE', () => registerDate(v.date));
    const sr = tryField(row, 'SRNO', () => { const n = srValue(v.sr); if (n == null) throw new LedgerError('SRNO is empty.'); return n; });
    // Duplicate SR in the file → error on every repeat (whatever else is wrong with the row).
    if (sr != null) {
      const f = firstSr.get(sr);
      if (f != null) errors.push({ row, field: 'SRNO', message: `SRNO ${sr} is also on row ${f}.` });
      else firstSr.set(sr, row);
    }
    if (String(v.lot ?? '').includes('+')) {
      warnings.push({ row, field: 'LOT NO', skip: true, message: `Two lots in one row (LOT NO ${rawText(v.lot)}): write one row per lot.` });
      preSkipped.add(row);
      continue;
    }
    const lotRaw = tryField(row, 'LOT NO', () => { const s = lotCode(rawText(v.lot)); return s!; });
    const mtr = tryField(row, 'MTR', () => { const n = metersValue(v.mtr, 'MTR'); if (n == null) throw new LedgerError('MTR is empty.'); return n; });
    const pieces = tryField(row, 'TAKA', () => piecesValue(v.taka));
    const pct = tryField(row, '%', () => registerPctValue(v.pct));
    const loc = tryField(row, 'LOCATION', () => locCodeValue(v.loc));
    const mill = tryField(row, 'MILL', () => nameValue(v.mill, 'Mill'));
    const weaver = tryField(row, 'WEAVER', () => nameValue(v.weaver, 'Weaver'));
    const item = tryField(row, 'ITEM', () => { const s = nameValue(v.item, 'ITEM (quality)'); if (!s) throw new LedgerError('ITEM (quality) is empty.'); return s; });
    const takes = TAKES.map((k, i) => tryField(row, `S-${i + 1}`, () => numberCell(v[k], `S-${i + 1}`)));
    let last = takes.length;
    while (last > 0 && takes[last - 1] == null) last--;
    const taken = round2(takes.reduce<number>((s, x) => s + (x ?? 0), 0));

    // STOCK: a number, E / e (ended → 0), or empty (→ MTR − S-1…S-10).
    let stock: number | null = null;
    let ended = false;
    const st = v.stock;
    if (!blank(st) && /^e$/i.test(String(st).trim())) { stock = 0; ended = true; }
    else if (!blank(st)) stock = tryField(row, 'STOCK', () => numberCell(st, 'STOCK'));
    if (errors.length > nErr || date == null || sr == null || !lotRaw || mtr == null || !item) continue;

    const expect = round2(mtr - taken);
    if (blank(st)) {
      if (expect < 0) {
        warnings.push({ row, field: 'STOCK', skip: false, message: `STOCK is empty and S-1…S-10 (${taken} m) are more than MTR (${mtr} m): balance taken as 0.` });
        stock = 0;
      } else stock = expect;
    } else if (stock != null && !ended) {
      if (stock > mtr + 0.01) { errors.push({ row, field: 'STOCK', message: `STOCK (${stock}) is more than MTR (${mtr}).` }); continue; }
      if (Math.abs(stock - expect) > 0.05) warnings.push({ row, field: 'STOCK', skip: false, message: `STOCK says ${stock} m but MTR − S-1…S-10 = ${expect} m. Using STOCK (${stock} m).` });
    }
    if (ended && taken > mtr + 0.01) ranOver++;
    if (date > today) warnings.push({ row, field: 'DATE', skip: false, message: `Date ${fmtDate(date)} is in the future — check it. Saved as written.` });
    parsed.push({
      fmt: 'reg_in', row, date, sr_no: sr, lotRaw, reg_lot_no: lotRaw, meters: mtr, pieces, register_pct: pct, loc_code: loc,
      mill_name: mill, weaver_name: weaver, quality: item, takes: takes.slice(0, last), stock: stock!, adjustment: round2(mtr - stock!), ended,
    });
  }
  if (!hasStockCol) notes.push('No STOCK column: each lot’s balance is MTR − S-1…S-10.');
  if (ranOver) notes.push(`${ranOver} finished lot(s) (STOCK = E) had more meters taken out (S-1…S-10) than MTR. Their balance is 0; the extra is not recorded.`);


  // What the app already has: incoming SRs, lot numbers.
  const srs = parsed.map((r) => r.sr_no);
  const cand = [...new Set(parsed.flatMap((r) => [r.lotRaw, `${r.lotRaw}-SR${r.sr_no}`]))];
  const [srRes, lotRes] = await Promise.all([
    srs.length ? q(`SELECT sr_no, lot_id, import_ref, meters FROM stock_movements WHERE direction = 'IN' AND sr_no = ANY($1::int[])`, [srs]) : { rows: [] },
    cand.length ? q(`SELECT lot_id, bal_m FROM lots WHERE lot_id = ANY($1::text[])`, [cand]) : { rows: [] },
  ]);
  const srHas = new Map<number, { lot_id: string; ref: string | null; meters: number }>(srRes.rows.map((x) => [Number(x.sr_no), { lot_id: String(x.lot_id), ref: x.import_ref ?? null, meters: Number(x.meters) }]));
  const lotHas = new Map<string, number>(lotRes.rows.map((x) => [String(x.lot_id), Number(x.bal_m)]));

  const rows: RegInRow[] = [];
  const skipped = new Set<number>(preSkipped);
  const usedIds = new Set<string>();
  let alreadySaved = 0;
  let changed = 0;
  const errRows = new Set(errors.map((e) => e.row));
  for (const r of parsed) {
    if (errRows.has(r.row)) continue;
    const ref = `${hash(`in|${r.sr_no}|${lotKey(r.lotRaw)}|${r.meters}`)}:1`;
    const adj_ref = ref.replace(':', 'a:');
    const have = srHas.get(r.sr_no);
    if (have) {
      if (have.ref === ref) {
        alreadySaved++;
        const bal = lotHas.get(have.lot_id);
        if (bal != null && Math.abs(bal - r.stock) > 0.05) changed++;
        continue;
      }
      warnings.push({ row: r.row, field: 'SRNO', skip: true, message: `SRNO ${r.sr_no} is already used in the app by lot ${have.lot_id} (${have.meters} m). Not added.` });
      skipped.add(r.row);
      continue;
    }
    // Lot key: the register's LOT NO, unless that number is already a lot (lot numbers repeat across mills).
    let lot_id = r.lotRaw;
    if (lotHas.has(lot_id) || usedIds.has(lot_id)) {
      const alt = `${r.lotRaw}-SR${r.sr_no}`;
      if (alt.length > 30 || lotHas.has(alt) || usedIds.has(alt)) {
        warnings.push({ row: r.row, field: 'LOT NO', skip: true, message: `Lot ${r.lotRaw} already exists and ${alt} is taken too. Not added.` });
        skipped.add(r.row);
        continue;
      }
      warnings.push({ row: r.row, field: 'LOT NO', skip: false, message: `Lot no. ${r.lotRaw} is already used by another lot, so this one is saved as ${alt}.` });
      lot_id = alt;
    }
    usedIds.add(lot_id);
    const { lotRaw: _l, ...rest } = r; // eslint-disable-line @typescript-eslint/no-unused-vars
    rows.push({ ...rest, lot_id, ref, adj_ref });
  }
  if (changed) notes.push(`${changed} lot(s) already imported now show a different STOCK in this file than their balance in the app. Sales after the first import come in through the Outgoing register; the app does not change those lots.`);
  return { rows, errors, warnings, notes, alreadySaved, skipped, newLots: rows.length };
}

// ---------- (b) Outgoing register ----------
interface LotInfo { lot_id: string; quality: string; reg_lot_no: string | null; bal: number; srs: number[] }

export async function checkOutgoing(q: Q, raw: RawRow<OutKey>[]): Promise<RegCheck<RegOutRow>> {
  const { errors, warnings, tryField } = collector();
  const notes: string[] = [];
  const today = todayIso();
  const skipped = new Set<number>();
  const skip = (row: number, field: string, message: string) => { warnings.push({ row, field, message, skip: true }); skipped.add(row); };
  type P = Omit<RegOutRow, 'lot_id' | 'ref'> & { srNum: number | null; combined: boolean; content: string };
  const parsed: P[] = [];
  const occ = new Map<string, number>();

  for (const { row, v } of raw) {
    // A bill row with only DATE + BNO (nothing sold): cancelled / blank bill?
    if ((['item', 'l', 'lot', 'lots', 'qty', 'nqty', 'sr'] as OutKey[]).every((k) => blank(v[k]))) {
      skip(row, 'Row', `Bill ${rawText(v.bno) ?? '(no number)'} has no item, lot or QTY (empty bill row). Skipped.`);
      continue;
    }
    const nErr = errors.length;
    const date = tryField(row, 'DATE', () => registerDate(v.date));
    const bill = tryField(row, 'BNO', () => { const c = challanCode(rawText(v.bno)); if (!c) throw new LedgerError('BNO (bill no.) is empty.'); return c; });
    const item = tryField(row, 'ITEM', () => nameValue(v.item, 'ITEM (quality)'));
    const L = tryField(row, 'L', () => billPctValue(v.l));
    const qty = tryField(row, 'QTY', () => { const n = metersValue(v.qty, 'QTY'); if (n == null) throw new LedgerError('QTY (meters) is empty.'); return n; });
    const nqty = tryField(row, 'NQTY', () => billedMetersValue(v.nqty));
    const code = tryField(row, 'LOT S', () => lotStatusCodeValue(v.lots));
    const srText = tryField(row, 'SR.NO', () => linkedSrValue(v.sr));
    const lotRaw = rawText(v.lot);
    if (lotRaw && lotRaw.length > 40) errors.push({ row, field: 'LOT', message: 'LOT is longer than 40 characters.' });
    if (errors.length > nErr || !date || !bill || qty == null) continue;
    const combined = !!(srText?.includes('+') || lotRaw?.includes('+'));
    const srNum = srText && /^\d{1,9}$/.test(srText) ? Number(srText) : null;
    if (!lotRaw && !srText) { errors.push({ row, field: 'LOT', message: 'Give the LOT or the SR.NO, so the sale can find its lot.' }); continue; }
    if (L != null && nqty != null && Math.abs(round2(qty * L / 100) - round2(nqty)) > 0.05) warnings.push({ row, field: 'NQTY', skip: false, message: `NQTY ${nqty} is not QTY × L ÷ 100 (${round2(qty * L / 100)}). Kept as given.` });
    if (code && !['R', 'E', 'S', 'A'].includes(code)) warnings.push({ row, field: 'LOT S', skip: false, message: `LOT S "${code}" is a new code (seen so far: R, E, S, A). Kept as given.` });
    if (date > today) warnings.push({ row, field: 'DATE', skip: false, message: `Date ${fmtDate(date)} is in the future — check it. Saved as written.` });
    // Identity of a sale row: date, bill, lot, meters, SR.NO (+ how many identical rows came before it). L / NQTY / LOT S /
    // ITEM are left out, so fixing one of them in the file (or a copy saved without formula results) is not a new sale.
    const content = `out|${date}|${bill}|${lotRaw ? lotKey(lotRaw) : ''}|${qty}|${srText ?? ''}`;
    parsed.push({ fmt: 'reg_out', row, date, bill_no: bill, quality: item, bill_pct: L, lot_raw: lotRaw, lot_status_code: code, meters: qty, billed_meters: nqty, linked_sr: srText, srNum, combined, content });
  }

  // Lots by incoming SR, and by lot no. (lot_id or the register's LOT NO).
  const srs = [...new Set(parsed.map((r) => r.srNum).filter((n): n is number => n != null))];
  const lotNos = [...new Set(parsed.filter((r) => r.lot_raw && !r.combined).map((r) => lotKey(r.lot_raw!)))];
  const LOT_SQL = `SELECT l.lot_id, l.quality, l.reg_lot_no, l.bal_m,
       COALESCE((SELECT array_agg(sm.sr_no) FROM stock_movements sm WHERE sm.lot_id = l.lot_id AND sm.direction = 'IN' AND sm.sr_no IS NOT NULL), '{}') AS srs
     FROM lots l`;
  const [bySrRes, byLotRes] = await Promise.all([
    srs.length ? q(`SELECT sm.sr_no AS key_sr, x.* FROM stock_movements sm JOIN LATERAL (${LOT_SQL} WHERE l.lot_id = sm.lot_id) x ON true
                    WHERE sm.direction = 'IN' AND sm.sr_no = ANY($1::int[])`, [srs]) : { rows: [] },
    lotNos.length ? q(`${LOT_SQL} WHERE upper(l.lot_id) = ANY($1::text[]) OR upper(l.reg_lot_no) = ANY($1::text[])`, [lotNos]) : { rows: [] },
  ]);
  const toInfo = (x: Record<string, unknown>): LotInfo => ({ lot_id: String(x.lot_id), quality: String(x.quality), reg_lot_no: (x.reg_lot_no as string) ?? null, bal: Number(x.bal_m), srs: ((x.srs as unknown[]) ?? []).map(Number) });
  const bySr = new Map<number, LotInfo>(bySrRes.rows.map((x) => [Number(x.key_sr), toInfo(x)]));
  const byLot = new Map<string, LotInfo[]>();
  for (const x of byLotRes.rows) {
    const info = toInfo(x);
    for (const k of new Set([lotKey(info.lot_id), info.reg_lot_no ? lotKey(info.reg_lot_no) : ''])) if (k) byLot.set(k, [...(byLot.get(k) ?? []), info]);
  }
  const bal = new Map<string, number>(); // running balance per lot, top to bottom

  // Rows of this file saved by an earlier import.
  const refs = parsed.map((r) => { const n = (occ.get(r.content) ?? 0) + 1; occ.set(r.content, n); return `${hash(r.content)}:${n}`; });
  const done = refs.length ? await q(`SELECT import_ref FROM stock_movements WHERE import_ref = ANY($1::text[])`, [refs]) : { rows: [] };
  const doneSet = new Set(done.rows.map((x) => String(x.import_ref)));

  const rows: RegOutRow[] = [];
  let alreadySaved = 0;
  let bySrCount = 0, byLotCount = 0;
  const errRows = new Set(errors.map((e) => e.row));
  parsed.forEach((r, i) => {
    if (errRows.has(r.row)) return;
    const ref = refs[i];
    if (doneSet.has(ref)) { alreadySaved++; return; }
    if (r.combined) {
      const what = [r.lot_raw?.includes('+') ? `lot ${r.lot_raw}` : '', r.linked_sr?.includes('+') ? `SR.NO ${r.linked_sr}` : ''].filter(Boolean).join(', ');
      skip(r.row, r.linked_sr?.includes('+') ? 'SR.NO' : 'LOT', `Two lots in one row (${what}): the app can't tell how many meters came from each. Split it into one row per lot.`);
      return;
    }
    let lot: LotInfo | undefined;
    let how: 'sr' | 'lot' = 'sr';
    if (r.srNum != null) lot = bySr.get(r.srNum);
    else if (r.linked_sr) { skip(r.row, 'SR.NO', `SR.NO "${r.linked_sr}" is not a number.`); return; }
    if (lot) {
      const want = r.lot_raw ? lotKey(r.lot_raw) : null;
      if (want && want !== lotKey(lot.lot_id) && want !== lotKey(lot.reg_lot_no ?? '')) {
        skip(r.row, 'LOT', `SR.NO ${r.srNum} is lot ${lot.reg_lot_no ?? lot.lot_id} in the app, but this row says lot ${r.lot_raw}. Check which is right.`);
        return;
      }
    } else {
      // No SR (or SR not in the app): find the lot by its number — only when exactly one lot has it.
      const hits = r.lot_raw ? (byLot.get(lotKey(r.lot_raw)) ?? []) : [];
      const ok = hits.filter((h) => r.srNum == null || !h.srs.length);
      if (r.srNum != null && !ok.length) {
        skip(r.row, 'SR.NO', hits.length
          ? `SR.NO ${r.srNum} is not in the app, and lot ${r.lot_raw} has a different SR (${hits[0].srs.join(', ')}).`
          : `SR.NO ${r.srNum} is not in the app${r.lot_raw ? ` and lot ${r.lot_raw} isn't either` : ''}. Import the Incoming register for this lot first.`);
        return;
      }
      if (!ok.length) { skip(r.row, 'LOT', `No SR.NO, and lot ${r.lot_raw} is not in the app.`); return; }
      if (ok.length > 1) { skip(r.row, 'LOT', `No SR.NO, and ${ok.length} lots have no. ${r.lot_raw} (${ok.map((h) => h.lot_id).join(', ')}). Add the SR.NO.`); return; }
      lot = ok[0];
      how = 'lot';
    }
    const b = bal.get(lot.lot_id) ?? lot.bal;
    if (b + 0.001 < r.meters) { skip(r.row, 'QTY', `Not enough stock: lot ${lot.lot_id} has ${round2(b)} m at this row, this row sends ${r.meters} m.`); return; }
    bal.set(lot.lot_id, round2(b - r.meters));
    if (how === 'lot') warnings.push({ row: r.row, field: 'SR.NO', skip: false, message: r.srNum != null ? `SR.NO ${r.srNum} is not in the app; matched by lot no. ${r.lot_raw} → ${lot.lot_id}.` : `No SR.NO: matched by lot no. ${r.lot_raw} → ${lot.lot_id}.` });
    if (r.quality && nameKey(r.quality) !== nameKey(lot.quality)) warnings.push({ row: r.row, field: 'ITEM', skip: false, message: `ITEM "${r.quality}" differs from lot ${lot.lot_id}'s quality "${lot.quality}". Saved on the lot anyway.` });
    if (how === 'sr') bySrCount++; else byLotCount++;
    const { srNum: _s, combined: _c, content: _t, ...rest } = r; // eslint-disable-line @typescript-eslint/no-unused-vars
    rows.push({ ...rest, lot_id: lot.lot_id, ref });
  });
  if (rows.length) notes.push(`${bySrCount} sale row(s) found their lot by SR.NO${byLotCount ? `, ${byLotCount} by lot number` : ''}.`);
  notes.push('This register has no party column: imported sales have no party.');
  return { rows, errors, warnings, notes, alreadySaved, skipped, newLots: 0 };
}

// ---------- commit ----------
const REF_RE = /^[a-f0-9]{20}a?:\d{1,7}$/;

/** Save one Incoming-register row: lot + IN + (when STOCK < MTR) the opening adjustment. Inside the chunk's transaction. */
export async function commitIncomingRow(q: Q, r: Record<string, unknown>, movedBy: string | null, memo: LedgerMemo) {
  await staleOnce(q, memo);
  const ref = importRef(r.ref);
  const adjRef = importRef(r.adj_ref);
  if (!ref || !adjRef || !REF_RE.test(ref) || !REF_RE.test(adjRef)) throw new LedgerError('Import reference is not valid. Check the file again.');
  const date = registerDate(r.date);
  const sr = srValue(r.sr_no);
  if (sr == null) throw new LedgerError('SRNO is empty.');
  const lotId = lotCode(r.lot_id)!;
  const regLot = lotCode(r.reg_lot_no)!;
  const meters = metersValue(r.meters, 'MTR');
  if (meters == null) throw new LedgerError('MTR is empty.');
  const stock = metersValue(r.stock, 'STOCK', { allowZero: true }) ?? 0;
  if (stock > meters + 0.01) throw new LedgerError(`STOCK (${stock}) is more than MTR (${meters}).`);
  const adjustment = round2(meters - stock);
  const takes = Array.isArray(r.takes) ? r.takes.slice(0, 10).map((x, i) => numberCell(x, `S-${i + 1}`)) : [];
  const quality = await lotAttrMemo(memo, q, 'quality', nameValue(r.quality, 'ITEM (quality)'));
  if (!quality) throw new LedgerError('ITEM (quality) is empty.');
  const mill = await nameMemo(memo, q, 'mill_name', nameValue(r.mill_name, 'Mill'));
  const weaver = await nameMemo(memo, q, 'weaver_name', nameValue(r.weaver_name, 'Weaver'));
  const pct = registerPctValue(r.register_pct);
  const loc = locCodeValue(r.loc_code);
  const pieces = piecesValue(r.pieces);

  const taken = await q(`SELECT lot_id FROM stock_movements WHERE direction = 'IN' AND sr_no = $1 LIMIT 1`, [sr]);
  if (taken.rows[0]) throw new LedgerError(`SRNO ${sr} is already used by lot ${taken.rows[0].lot_id}. Check the file again.`, 409);
  if (await lockLot(q, lotId)) throw new LedgerError(`Lot ${lotId} already exists. Check the file again.`, 409);
  await q(`INSERT INTO lots (lot_id, quality, design, grade, status, reg_lot_no, loc_code) VALUES ($1, $2, $3, 'A', 'active', $4, $5)`, [lotId, quality, NO_DESIGN, regLot, loc]);
  await q(
    `INSERT INTO stock_movements (lot_id, direction, meters, mill_name, weaver_name, sr_no, pieces, import_ref, ts, register_pct, takes, loc_code)
     VALUES ($1, 'IN', $2, $3, $4, $5, $6, $7, $8::date, $9, $10::numeric[], $11) RETURNING id`,
    [lotId, meters, mill, weaver, sr, pieces, ref, date, pct, takes.length ? takes : null, loc],
  );
  // No app location: the register's LOCATION code (kept in loc_code) is not a market + shop yet (docs/AMBIGUOUS.md §4).
  // The lot shows "Not recorded" until someone moves it to a market location (finished lots → Dispatched below).
  if (adjustment > 0) {
    const adj = await q(
      `INSERT INTO stock_movements (lot_id, direction, meters, kind, import_ref, ts, linked_sr)
       VALUES ($1, 'OUT', $2, 'adjustment', $3, $4::date, $5) RETURNING id`,
      [lotId, adjustment, adjRef, date, String(sr)],
    );
    if (stock <= 0) {
      await moveLot(q, { lot_id: lotId, location: DISPATCHED, stage: 'dispatch', note: `Opening adjustment (register): ${adjustment} m already out, lot finished`, stock_movement_id: Number(adj.rows[0].id), moved_by: movedBy });
    }
  }
  return { in: 1, out: 0 };
}

/** Save one Outgoing-register row as an OUT on its lot (no party). Inside the chunk's transaction. */
export async function commitOutgoingRow(q: Q, r: Record<string, unknown>, movedBy: string | null, memo: LedgerMemo) {
  await staleOnce(q, memo);
  const ref = importRef(r.ref);
  if (!ref || !REF_RE.test(ref)) throw new LedgerError('Import reference is not valid. Check the file again.');
  const date = registerDate(r.date);
  const lotId = lotCode(r.lot_id)!;
  const meters = metersValue(r.meters, 'QTY');
  if (meters == null) throw new LedgerError('QTY is empty.');
  const bill = challanCode(r.bill_no);
  const billPct = billPctValue(r.bill_pct);
  const billed = billedMetersValue(r.billed_meters);
  const code = lotStatusCodeValue(r.lot_status_code);
  const linked = linkedSrValue(r.linked_sr);
  if (!(await lockLot(q, lotId))) throw new LedgerError(`Lot ${lotId} does not exist. Check the file again.`);
  const b = Number((await q(`SELECT bal_m FROM lots WHERE lot_id = $1`, [lotId])).rows[0].bal_m);
  if (b + 0.001 < meters) throw new LedgerError(`Not enough stock: lot ${lotId} has ${b} m, this row sends ${meters} m.`);
  const mv = await q(
    `INSERT INTO stock_movements (lot_id, direction, meters, party, source_doc_id, import_ref, ts, bill_pct, billed_meters, lot_status_code, linked_sr)
     VALUES ($1, 'OUT', $2, NULL, $3, $4, $5::date, $6, $7, $8, $9) RETURNING id`,
    [lotId, meters, bill, ref, date, billPct, billed, code, linked],
  );
  await trimReservations(q, lotId);
  const remaining = round2(b - meters);
  const here = remaining <= 0 ? null : await currentPlace(q, lotId);
  if (remaining <= 0 || here) await moveLot(q, {
    lot_id: lotId, location: remaining <= 0 ? DISPATCHED : here!.location, place: remaining <= 0 ? null : here, stage: 'dispatch',
    note: `${meters} m on bill ${bill ?? '—'}${remaining > 0 ? ` · ${remaining} m left` : ''}`, stock_movement_id: Number(mv.rows[0].id), moved_by: movedBy,
  });
  return { in: 0, out: 1 };
}
