// Excel stock import + challan export with SR no. and pieces (taka). Server-side only.
//   1. validateImport(): read the .xlsx, check the header row against the template and every row — writes nothing.
//   2. The browser sends the checked rows back in chunks to /api/stock/import/commit (see commitChunk()).
// Each row carries import_ref "<batch>:<excel row>", so a re-sent chunk never adds a row twice.
import ExcelJS from 'exceljs';
import { createHash } from 'crypto';
import type { Q } from './db';
import { LedgerError } from './ledger-error';
import { newLedgerMemo, piecesValue, recordIncoming, recordOutgoing, srValue } from './ledger';
import { describePlace, marketList } from './location';
import { challanCode, lotCode, marketRows, metersValue, nameValue, readPlace } from './normalize';
import type { LedgerRow } from './ledger-query';
import {
  checkIncoming, checkOutgoing, commitIncomingRow, commitOutgoingRow, detectRegister, INCOMING_COLUMNS, OUTGOING_COLUMNS,
  type HeaderCell, type RawRow, type RegCheck, type RegCol, type RegInRow, type RegOutRow, type RegWarning, type RegisterFormat,
} from './register-import';
export type { RegInRow, RegOutRow, RegWarning };

export const IMPORT_SHEET = 'Stock entries';
export const MAX_IMPORT_ROWS = 20_000;
export const CHUNK_MAX = 1000;

type Key = 'direction' | 'sr_no' | 'lot_id' | 'challan' | 'quality' | 'design' | 'grey_meters' | 'finished_meters' | 'pieces'
  | 'mill_name' | 'weaver_name' | 'location' | 'meters' | 'party';

/** Template columns, in order. `aliases`: other headings accepted as the same column (older templates, common words). */
export const TEMPLATE_COLUMNS: { key: Key; header: string; width: number; aliases: string[] }[] = [
  { key: 'direction', header: 'Direction (IN/OUT)', width: 18, aliases: ['Dir', 'IN/OUT', 'Type'] },
  { key: 'sr_no', header: 'SR No', width: 9, aliases: ['SR', 'SR Number', 'Serial No', 'Register No'] },
  { key: 'lot_id', header: 'Lot No', width: 14, aliases: ['Lot', 'Lot Number', 'Lot ID'] },
  { key: 'challan', header: 'Challan No', width: 14, aliases: ['Challan', 'Challan Number', 'Invoice No', 'Bill No'] },
  { key: 'quality', header: 'Quality (new lot)', width: 18, aliases: [] },
  { key: 'design', header: 'Design (new lot)', width: 16, aliases: [] },
  { key: 'grey_meters', header: 'Grey meters (IN)', width: 15, aliases: ['Grey Mts', 'Grey'] },
  { key: 'finished_meters', header: 'Finished meters (IN)', width: 18, aliases: ['Finished Mts', 'Finished'] },
  { key: 'pieces', header: 'Pieces (taka)', width: 13, aliases: ['Taka', 'Pcs', 'Than'] },
  { key: 'mill_name', header: 'Mill (IN)', width: 22, aliases: ['Mill Name'] },
  { key: 'weaver_name', header: 'Weaver (IN)', width: 22, aliases: ['Weaver Name'] },
  { key: 'location', header: 'Location (IN)', width: 18, aliases: [] },
  { key: 'meters', header: 'Meters (OUT)', width: 14, aliases: ['Mts', 'Meter'] },
  { key: 'party', header: 'Party (OUT)', width: 24, aliases: ['Party Name', 'Client', 'Customer'] },
];
const LABEL = Object.fromEntries(TEMPLATE_COLUMNS.map((c) => [c.key, c.header])) as Record<Key, string>;

// "Grey meters (IN)" → "greymeters"; the bracketed hint is optional.
const norm = (s: string) => s.toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]/g, '');
const normFull = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const NAMES: { n: string; key: Key }[] = TEMPLATE_COLUMNS.flatMap((c) => [c.header, ...c.aliases].flatMap((h) => [{ n: norm(h), key: c.key }, { n: normFull(h), key: c.key }]));

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

function matchHeader(h: string): Key | null {
  const a = norm(h);
  const b = normFull(h);
  return NAMES.find((x) => x.n && (x.n === a || x.n === b))?.key ?? null;
}

/** Closest template column for a heading that did not match, or null when nothing is close. */
function suggestHeader(h: string): Key | null {
  const a = norm(h) || normFull(h);
  if (!a) return null;
  let best: { key: Key; d: number } | null = null;
  for (const x of NAMES) {
    if (!x.n) continue;
    const d = x.n.startsWith(a) || a.startsWith(x.n) ? Math.min(2, Math.abs(x.n.length - a.length)) : editDistance(a, x.n);
    if (!best || d < best.d) best = { key: x.key, d };
  }
  return best && best.d <= Math.max(2, Math.floor(a.length * 0.4)) ? best.key : null;
}

// ---------- template ----------
export function newBook(firmName: string) {
  const wb = new ExcelJS.Workbook();
  wb.creator = firmName;
  wb.created = new Date();
  return wb;
}
const HEAD_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9E4D8' } };
function styleHeader(ws: ExcelJS.Worksheet) {
  const row = ws.getRow(1);
  row.font = { bold: true };
  row.fill = HEAD_FILL;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}
const colLetter = (key: Key) => String.fromCharCode(65 + TEMPLATE_COLUMNS.findIndex((c) => c.key === key));

/**
 * Blank import template: dropdowns for IN/OUT and the market codes (type the shop and pipe after the code), rules on a
 * second sheet. `markets`: active markets (code + name).
 */
export function importTemplate(wb: ExcelJS.Workbook, markets: { id: number; code: string; name: string; active: boolean }[], nextSr: { IN: number; OUT: number }) {
  const locations = markets.filter((m) => m.active).map((m) => m.code);
  const ws = wb.addWorksheet(IMPORT_SHEET);
  ws.columns = TEMPLATE_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  styleHeader(ws);
  const lists = wb.addWorksheet('Lists');
  lists.getCell('A1').value = 'Markets';
  lists.getCell('B1').value = 'Market name';
  markets.filter((m) => m.active).forEach((m, i) => { lists.getCell(`A${i + 2}`).value = m.code; lists.getCell(`B${i + 2}`).value = m.name; });
  lists.state = 'hidden';
  const [dir, loc] = [colLetter('direction'), colLetter('location')];
  const meters = (['grey_meters', 'finished_meters', 'meters'] as Key[]).map(colLetter);
  const whole = (['sr_no', 'pieces'] as Key[]).map(colLetter);
  for (let r = 2; r <= 2001; r++) {
    ws.getCell(`${dir}${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"IN,OUT"'], showErrorMessage: true, error: 'IN or OUT' };
    // Not strict: pick the market code, then type the shop and pipe after it ("LM 245 · Pipe 3" or "LM 245 3").
    if (locations.length) ws.getCell(`${loc}${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`Lists!$A$2:$A$${locations.length + 1}`], showErrorMessage: false };
    for (const col of meters) {
      ws.getCell(`${col}${r}`).dataValidation = { type: 'decimal', operator: 'greaterThan', allowBlank: true, formulae: [0], showErrorMessage: true, error: 'Meters must be a positive number' };
      ws.getCell(`${col}${r}`).numFmt = '0.00';
    }
    for (const col of whole) ws.getCell(`${col}${r}`).dataValidation = { type: 'whole', operator: 'greaterThanOrEqual', allowBlank: true, formulae: [0], showErrorMessage: true, error: 'Whole number' };
  }
  const m = locations[0] ?? 'LM';
  const help = wb.addWorksheet('How to fill');
  help.columns = [{ header: 'Rule', key: 'r', width: 120 }];
  [
    'One row per challan. Direction IN = received, OUT = dispatched. Keep the column headings as they are.',
    `SR No: the number from your paper register. Must not repeat within IN (or within OUT). Next free now: IN ${nextSr.IN}, OUT ${nextSr.OUT}. Leave blank if not used.`,
    'IN: Lot No, Grey meters and/or Finished meters, Mill, Weaver, Location. Quality + Design only for a new lot.',
    `Location (IN): market code, shop no., pipe no. — e.g. "${m} 245 · Pipe 3", "${m} 245 3" or "${m} 245" (pipe optional, 1 to 999). The market's full name works too.${locations.length ? ` Markets: ${marketList(markets)}.` : ''} A new shop no. is added to the market. Godown, Shop and Floor are no longer used.`,
    'OUT: Lot No, Meters, Party. The lot must have enough stock at that row (rows are applied top to bottom).',
    'Pieces (taka): whole number, optional, for IN and OUT.',
    'Lot and challan numbers: letters, digits, "-" and "/" only. Names are matched to spellings already used.',
    'Upload first checks the whole file and lists every problem with its row number. Nothing is saved until the file is clean.',
  ].forEach((r) => help.addRow({ r }));
  styleHeader(help);
  return ws;
}

/**
 * Blank Incoming / Outgoing register with exactly the firm's columns. The example row is on its own sheet (so it is
 * never imported by mistake), with short notes on a third sheet.
 */
export function registerTemplate(wb: ExcelJS.Workbook, format: RegisterFormat, nextInSr: number) {
  const cols = (format === 'incoming' ? INCOMING_COLUMNS : OUTGOING_COLUMNS) as RegCol<string>[];
  const ws = wb.addWorksheet(format === 'incoming' ? 'Incoming register' : 'Outgoing register');
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  styleHeader(ws);
  const letter = (key: string) => String.fromCharCode(65 + cols.findIndex((c) => c.key === key));
  for (let r = 2; r <= 2001; r++) {
    ws.getCell(`${letter('date')}${r}`).numFmt = 'dd-mm-yyyy';
    if (format === 'outgoing') ws.getCell(`${letter('lots')}${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"R,E,S,A"'], showErrorMessage: false };
  }
  const ex = wb.addWorksheet('Example');
  ex.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  styleHeader(ex);
  const day = new Date(Date.UTC(2026, 0, 15));
  if (format === 'incoming') {
    // Made-up sample values (not the firm's data).
    ex.addRow({ date: day, sr: nextInSr, lot: 10001, mtr: 6000, taka: 48, pct: 8.5, loc: '101+102', mill: 'A', weaver: 'SAMPLE WEAVER', s1: 1000, s2: 2500, s3: 300, item: 'SAMPLE QUALITY 5% - 10%' });
    ex.getCell('T2').value = { formula: 'D2-SUM(J2:S2)', result: 2200 } as ExcelJS.CellFormulaValue;
  } else {
    ex.addRow({ date: day, bno: 501, item: 'SAMPLE QUALITY', l: 105, lot: 10001, lots: 'S', qty: 1000, sr: nextInSr });
    ex.getCell('H2').value = { formula: 'G2*D2/100', result: 1050 } as ExcelJS.CellFormulaValue;
  }
  ex.getCell('A2').numFmt = 'dd-mm-yyyy';
  const help = wb.addWorksheet('How to fill');
  help.columns = [{ header: 'Column', key: 'c', width: 12 }, { header: 'What to write', key: 'w', width: 100 }];
  styleHeader(help);
  for (const c of cols) if (c.note) help.addRow({ c: /^s\d+$/.test(c.key) ? 'S-1 … S-10' : c.header, w: c.note });
  help.addRow({});
  const general = format === 'incoming'
    ? [
      'One row per lot received. The app makes the lot, records MTR coming in, and — when STOCK is less than MTR — an “opening adjustment” for what S-1…S-10 already took out, so the lot’s balance equals STOCK.',
      `SRNO must not repeat. Next free incoming SR in the app now: ${nextInSr}.`,
      'Rows the app can’t place (SR already used, …) are listed before saving and can be downloaded as “rows to fix”.',
      'Importing the same file again does not add anything twice.',
    ]
    : [
      'One row per lot on a bill (a bill with 3 lots = 3 rows). SR.NO = the lot’s SRNO in the Incoming register: that is how the sale finds its lot. Import the Incoming register first.',
      'Two lots in one row (172+173, SR 146+204) can’t be split by the app: write one row per lot.',
      'No party column: imported sales have no party. QTY (meters) comes out of the lot; L, NQTY and LOT S are kept as written.',
      'Importing the same file again does not add anything twice.',
    ];
  general.forEach((w, i) => help.addRow({ c: i === 0 ? 'Notes' : '', w }));
  return ws;
}

/** "Rows to fix": the uploaded file's own columns for the rows that were left out, + row number and reason. */
export function fixSheet(wb: ExcelJS.Workbook, headers: string[], rows: { row: number; values: unknown[]; reason: string }[]) {
  const ws = wb.addWorksheet('Rows to fix');
  ws.columns = [...headers.map((h) => ({ header: h, width: Math.min(28, Math.max(7, h.length + 3)) })), { header: 'Excel row', width: 10 }, { header: 'Why skipped', width: 70 }];
  for (const r of rows) {
    const vals = headers.map((_, i) => {
      const v = r.values[i];
      return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : v ?? null;
    });
    const added = ws.addRow([...vals, r.row, r.reason]);
    vals.forEach((v, i) => { if (v instanceof Date) added.getCell(i + 1).numFmt = 'dd-mm-yyyy'; });
  }
  styleHeader(ws);
  return ws;
}

/** Excel has no time zones: write the server's local date + time (what the ledger shows), not UTC. */
function wallClock(ts: string): Date {
  const d = new Date(ts);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()));
}

/** Challans sheet for export (S.No first, then SR no. and pieces). */
export function challanSheet(wb: ExcelJS.Workbook, rows: LedgerRow[]) {
  const ws = wb.addWorksheet('Challans');
  ws.columns = [
    { header: 'S.No', key: 'sno', width: 7 },
    { header: 'SR No', key: 'sr', width: 8 },
    { header: 'Date', key: 'date', width: 12, style: { numFmt: 'dd-mm-yyyy' } },
    { header: 'IN/OUT', key: 'direction', width: 8 },
    { header: 'Challan No', key: 'challan', width: 14 },
    { header: 'Lot No', key: 'lot_id', width: 14 },
    { header: 'Quality', key: 'quality', width: 18 },
    { header: 'Design', key: 'design', width: 14 },
    { header: 'Grey Mts', key: 'grey', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'Finished Mts', key: 'finished', width: 13, style: { numFmt: '#,##0.00' } },
    { header: 'Stock Mts', key: 'meters', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'Pieces (taka)', key: 'pieces', width: 12 },
    { header: 'Mill', key: 'mill', width: 22 },
    { header: 'Weaver', key: 'weaver', width: 22 },
    { header: 'Party', key: 'party', width: 24 },
    { header: 'Location', key: 'location', width: 18 },
    { header: 'Entry', key: 'entry', width: 10 },
    { header: 'Kind', key: 'kind', width: 26 },
    { header: 'Linked SR (SR.NO)', key: 'linked_sr', width: 12 },
    { header: '% (register)', key: 'pct', width: 10 },
    { header: 'Location code', key: 'loc_code', width: 12 },
    { header: 'L', key: 'l', width: 7 },
    { header: 'Billed Mts (NQTY)', key: 'nqty', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'LOT S', key: 'lots', width: 7 },
    { header: 'Taken before import (S-1…S-10)', key: 'takes', width: 30 },
  ];
  rows.forEach((r, i) => {
    ws.addRow({
      sno: i + 1, sr: r.sr_no, date: wallClock(r.ts), direction: r.direction, challan: r.source_doc_id ?? '', lot_id: r.lot_id,
      quality: r.quality, design: r.design, grey: r.grey_meters, finished: r.finished_meters, meters: r.meters, pieces: r.pieces,
      mill: r.mill_name ?? '', weaver: r.weaver_name ?? '', party: r.direction === 'OUT' ? r.party ?? '' : '', location: r.location ?? '',
      entry: r.capture_event_id ? 'Photo' : r.imported ? 'Excel' : 'Manual',
      kind: r.kind === 'adjustment' ? 'Opening adjustment (register)' : r.direction === 'OUT' ? 'Sale / dispatch' : 'Received',
      linked_sr: r.linked_sr ?? '', pct: r.register_pct, loc_code: r.loc_code ?? '', l: r.bill_pct, nqty: r.billed_meters, lots: r.lot_status_code ?? '',
      takes: r.takes?.length ? r.takes.map((t) => t ?? '').join(' | ') : '',
    });
  });
  styleHeader(ws);
  ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columns.length } };
  return ws;
}

// ---------- validation ----------
export interface ImportRow {
  row: number; // Excel row number
  direction: 'IN' | 'OUT';
  sr_no: number | null;
  lot_id: string;
  challan: string | null;
  quality: string | null;
  design: string | null;
  grey_meters: number | null;
  finished_meters: number | null;
  pieces: number | null;
  mill_name: string | null;
  weaver_name: string | null;
  location: string | null;
  meters: number | null;
  party: string | null;
}
export interface HeaderProblem { column: string; message: string }
export interface RowProblem { row: number; field: string; message: string }
export type ImportFormat = 'template' | RegisterFormat;
export const FORMAT_LABEL: Record<ImportFormat, string> = { template: 'app template', incoming: 'Incoming register', outgoing: 'Outgoing (sales) register' };
/** Skipped rows as they were in the file, for the "rows to fix" Excel. */
export interface FixFile { headers: string[]; rows: { row: number; values: unknown[]; reason: string }[] }
export type AnyImportRow = ImportRow | RegInRow | RegOutRow;
export interface ValidateResult {
  ok: boolean; // no column problems and no row errors (warnings are allowed)
  batch: string | null;
  sheet: string;
  format: ImportFormat;
  detected: string; // "Looks like your Incoming register — 23 lots"
  total: number;
  alreadySaved: number; // rows of this same file saved by an earlier import (skipped)
  counts: { in: number; out: number; newLots: number; adjustments: number };
  warnings: RegWarning[]; // first 2,000; skip = the row is left out
  warningCount: number;
  skipCount: number; // rows that will be left out (warnings with skip)
  fix: FixFile | null;
  headerProblems: HeaderProblem[];
  notes: string[];
  problems: RowProblem[]; // first 2,000
  problemCount: number;
  problemRows: number;
  byField: { field: string; count: number }[]; // problems per column, most first
  rows?: AnyImportRow[]; // only when ok: the rows to save (skipped rows left out)
}

function cellValue(v: ExcelJS.CellValue): unknown {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    // Formula: its last computed value. A file saved by a program that doesn't calculate has none → empty.
    if ('result' in v || 'formula' in v || 'sharedFormula' in v) return cellValue(((v as ExcelJS.CellFormulaValue).result ?? null) as ExcelJS.CellValue);
    if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join('');
    if ('text' in v) return String((v as { text: unknown }).text);
    if ('error' in v) return null;
    return null; // any other cell object (e.g. a picture / checkbox): treated as empty
  }
  return typeof v === 'string' ? v.trim() : v;
}

export class ImportFileError extends Error {}

const MAX_WARNINGS = 2000;
const MAX_FIX_ROWS = 5000;

function headerCells(ws: ExcelJS.Worksheet, n: number): HeaderCell[] {
  const out: HeaderCell[] = [];
  ws.getRow(n).eachCell({ includeEmpty: false }, (cell, col) => {
    const text = String(cellValue(cell.value) ?? '').trim();
    if (text) out.push({ col, text });
  });
  return out;
}
const templateScore = (cells: HeaderCell[]) => new Set(cells.map((c) => matchHeader(c.text)).filter(Boolean)).size;

/**
 * Check an uploaded .xlsx. Three formats, told apart by the heading row: the firm's Incoming register, its Outgoing
 * (sales) register, or the app's own template. Writes nothing.
 */
export async function validateImport(q: Q, buffer: Buffer): Promise<ValidateResult> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new ImportFileError('Could not open this file. Save it as .xlsx (Excel) — or download a template and fill that.');
  }
  const sheets = [wb.getWorksheet(IMPORT_SHEET), ...wb.worksheets.filter((w) => w.state !== 'hidden')].filter((w): w is ExcelJS.Worksheet => !!w);
  if (!sheets.length) throw new ImportFileError('The file has no sheets.');
  // Same file → same batch id (app template rows are keyed "<batch>:<excel row>").
  const batch = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  let best: { ws: ExcelJS.Worksheet; tpl: number } | null = null;
  for (const ws of sheets) {
    // The heading row is usually row 1; a title above it is allowed (first 5 rows are looked at).
    for (let n = 1; n <= Math.min(5, Math.max(1, ws.actualRowCount)); n++) {
      const cells = headerCells(ws, n);
      if (!cells.length) continue;
      const tpl = templateScore(cells);
      const hasDirection = cells.some((c) => matchHeader(c.text) === 'direction');
      if (hasDirection && tpl >= 3) return validateTemplate(q, ws, batch);
      const reg = detectRegister(cells);
      if (reg) return validateRegister(q, ws, n, cells, reg.format, batch);
      if (n === 1 && (!best || tpl > best.tpl)) best = { ws, tpl };
    }
  }
  if (best && best.tpl >= 3) return validateTemplate(q, best.ws, batch);
  return {
    ...emptyResult(sheets[0].name, 'template'),
    headerProblems: [{ column: '', message: 'Could not tell what this file is. Use your Incoming register (DATE, SRNO, LOT NO, MTR, … ITEM), your Outgoing register (DATE, BNO, ITEM, L, LOT, LOT S, QTY, NQTY, SR.NO) or the app template — templates for all three can be downloaded here.' }],
  };
}

function emptyResult(sheet: string, format: ImportFormat): ValidateResult {
  return {
    ok: false, batch: null, sheet, format, detected: '', total: 0, alreadySaved: 0, counts: { in: 0, out: 0, newLots: 0, adjustments: 0 },
    warnings: [], warningCount: 0, skipCount: 0, fix: null, headerProblems: [], notes: [], problems: [], problemCount: 0, problemRows: 0, byField: [],
  };
}

const byFieldOf = (problems: { field: string }[]) =>
  [...problems.reduce((m, p) => m.set(p.field || 'Row', (m.get(p.field || 'Row') ?? 0) + 1), new Map<string, number>())]
    .map(([field, count]) => ({ field, count })).sort((a, b) => b.count - a.count);

/** (a) / (b): the firm's registers. */
async function validateRegister(q: Q, ws: ExcelJS.Worksheet, headRow: number, cells: HeaderCell[], format: RegisterFormat, batch: string): Promise<ValidateResult> {
  const reg = detectRegister(cells)!;
  const h = format === 'incoming' ? reg.inH : reg.outH;
  const cols = (format === 'incoming' ? INCOMING_COLUMNS : OUTGOING_COLUMNS) as RegCol<string>[];
  const headerProblems: HeaderProblem[] = [];
  const notes: string[] = [];
  const textFor = h.textFor as Map<string, string>;
  for (const c of cols) if (c.required && !textFor.has(c.key)) headerProblems.push({ column: c.header, message: `Column '${c.header}' is missing. It is needed for every row.` });
  if (format === 'outgoing' && !textFor.has('lot') && !textFor.has('sr')) headerProblems.push({ column: 'SR.NO', message: `Column 'SR.NO' (or 'LOT') is missing — sales need it to find their lot.` });
  for (const r of h.repeats) headerProblems.push({ column: r, message: `Column '${r}' appears twice. Keep only one.` });
  for (const f of h.fuzzy) notes.push(`Column '${f.header}' read as ${f.as}.`);
  if (h.unknown.length) notes.push(`Not used: ${h.unknown.map((u) => `'${u}'`).join(', ')}.`);
  if (format === 'incoming') {
    const missingOpt = cols.filter((c) => !c.required && !/^s\d+$/.test(c.key) && !textFor.has(c.key)).map((c) => c.header);
    if (missingOpt.length) notes.push(`Not in this file (left empty): ${missingOpt.join(', ')}.`);
  } else {
    const missingOpt = cols.filter((c) => !c.required && !textFor.has(c.key)).map((c) => c.header);
    if (missingOpt.length) notes.push(`Not in this file (left empty): ${missingOpt.join(', ')}.`);
  }

  // Rows under the heading row. `cellsOf` keeps the file's own values for the "rows to fix" file.
  const headers = cells.map((c) => c.text);
  const colIdx = cells.map((c) => c.col);
  const raw: RawRow<string>[] = [];
  const cellsOf = new Map<number, unknown[]>();
  let tooMany = false;
  const colFor = h.colFor as Map<number, string>;
  ws.eachRow({ includeEmpty: false }, (r, n) => {
    if (n <= headRow || tooMany) return;
    const v: Record<string, unknown> = {};
    const all: unknown[] = colIdx.map(() => null);
    r.eachCell({ includeEmpty: false }, (cell, col) => {
      const val = cellValue(cell.value);
      const key = colFor.get(col);
      if (key) v[key] = val;
      const i = colIdx.indexOf(col);
      if (i >= 0) all[i] = val;
    });
    if (Object.values(v).some((x) => x !== null && x !== undefined && x !== '')) { raw.push({ row: n, v }); cellsOf.set(n, all); }
    if (raw.length > MAX_IMPORT_ROWS) tooMany = true;
  });
  if (tooMany) throw new ImportFileError(`Up to ${MAX_IMPORT_ROWS.toLocaleString('en-IN')} rows per file. Split the file and import each part.`);

  const res = emptyResult(ws.name, format);
  res.total = raw.length;
  if (!raw.length && !headerProblems.length) headerProblems.push({ column: '', message: 'No filled rows found under the heading row.' });
  if (headerProblems.length) return { ...res, headerProblems, notes, detected: `Looks like your ${FORMAT_LABEL[format]}` };

  const chk: RegCheck<RegInRow> | RegCheck<RegOutRow> = format === 'incoming'
    ? await checkIncoming(q, raw, textFor.has('stock'))
    : await checkOutgoing(q, raw);
  const errors = chk.errors.sort((a, b) => a.row - b.row);
  const warnings = chk.warnings.sort((a, b) => a.row - b.row || Number(b.skip) - Number(a.skip));
  const ok = !errors.length;
  const reasons = new Map<number, string>();
  for (const w of warnings) if (w.skip && !reasons.has(w.row)) reasons.set(w.row, w.message);
  const fixRows = [...chk.skipped].sort((a, b) => a - b).slice(0, MAX_FIX_ROWS).map((row) => ({ row, values: cellsOf.get(row) ?? [], reason: reasons.get(row) ?? '' }));
  const bills = format === 'outgoing' ? new Set(raw.map((r) => String(r.v.bno ?? ''))).size : 0;
  const rows = chk.rows as (RegInRow | RegOutRow)[];
  return {
    ...res,
    ok,
    batch: ok ? batch : null,
    detected: format === 'incoming'
      ? `Looks like your Incoming register — ${raw.length.toLocaleString('en-IN')} lot${raw.length === 1 ? '' : 's'}`
      : `Looks like your Outgoing (sales) register — ${raw.length.toLocaleString('en-IN')} row${raw.length === 1 ? '' : 's'}, ${bills.toLocaleString('en-IN')} bill${bills === 1 ? '' : 's'}`,
    alreadySaved: chk.alreadySaved,
    counts: {
      in: format === 'incoming' ? rows.length : 0,
      out: format === 'outgoing' ? rows.length : 0,
      newLots: chk.newLots,
      adjustments: format === 'incoming' ? (rows as RegInRow[]).filter((r) => r.adjustment > 0).length : 0,
    },
    warnings: warnings.slice(0, MAX_WARNINGS),
    warningCount: warnings.length,
    skipCount: chk.skipped.size,
    fix: fixRows.length ? { headers, rows: fixRows } : null,
    headerProblems,
    notes: [...(chk.alreadySaved ? [`${chk.alreadySaved.toLocaleString('en-IN')} row(s) of this file are already in the app and will be skipped.`] : []), ...notes, ...chk.notes],
    problems: errors.slice(0, 2000),
    problemCount: errors.length,
    problemRows: new Set(errors.map((p) => p.row)).size,
    byField: byFieldOf(errors),
    ...(ok ? { rows } : {}),
  };
}

/** (c) The app's own template ("Stock entries"). Rules unchanged: any problem blocks the file. */
async function validateTemplate(q: Q, ws: ExcelJS.Worksheet, batch: string): Promise<ValidateResult> {

  // ----- header row -----
  const headerProblems: HeaderProblem[] = [];
  const notes: string[] = [];
  const colFor = new Map<number, Key>();
  const seen = new Map<Key, string>();
  const suggested = new Set<Key>(); // columns that look misspelled: don't repeat the problem on every row
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    const h = String(cellValue(cell.value) ?? '').trim();
    if (!h) return;
    const key = matchHeader(h);
    if (key) {
      if (seen.has(key)) headerProblems.push({ column: h, message: `Column '${h}' repeats '${seen.get(key)}'. Keep only one of them.` });
      else { seen.set(key, h); colFor.set(col, key); }
      return;
    }
    const s = suggestHeader(h);
    if (s && !seen.has(s)) { suggested.add(s); headerProblems.push({ column: h, message: `Column '${h}' not recognised — did you mean '${LABEL[s]}'?` }); }
    else notes.push(`Column '${h}' is not in the template and will be ignored.`);
  });
  // Every template column must be there (an empty column is fine) — a missing one usually means the wrong file or an old template.
  for (const k of TEMPLATE_COLUMNS.map((c) => c.key) as Key[]) {
    if (!seen.has(k) && !suggested.has(k) && !headerProblems.some((p) => p.message.includes(`'${LABEL[k]}'`))) headerProblems.push({ column: LABEL[k], message: `Column '${LABEL[k]}' is missing. Use the template's columns (leave it empty if not needed).` });
  }
  const has = (k: Key) => seen.has(k);

  // ----- rows -----
  const raw: { row: number; v: Partial<Record<Key, unknown>> }[] = [];
  let tooMany = false;
  ws.eachRow({ includeEmpty: false }, (r, n) => {
    if (n === 1 || tooMany) return;
    const v: Partial<Record<Key, unknown>> = {};
    r.eachCell({ includeEmpty: false }, (cell, col) => {
      const key = colFor.get(col);
      if (key) v[key] = cellValue(cell.value);
    });
    if (Object.values(v).some((x) => x !== null && x !== undefined && x !== '')) raw.push({ row: n, v });
    if (raw.length > MAX_IMPORT_ROWS) tooMany = true;
  });
  if (tooMany) throw new ImportFileError(`Up to ${MAX_IMPORT_ROWS.toLocaleString('en-IN')} rows per file. Split the file and import each part.`);

  // Same file → same batch id, so rows saved by an earlier (interrupted) import of this file are skipped, never doubled.
  const doneRes = await q(`SELECT import_ref FROM stock_movements WHERE import_ref LIKE $1`, [`${batch}:%`]);
  const doneRows = new Set(doneRes.rows.map((x) => Number(String(x.import_ref).split(':')[1])));
  const todo = raw.filter((r) => !doneRows.has(r.row));

  const problems: RowProblem[] = [];
  const add = (row: number, field: Key | 'row', message: string) => problems.push({ row, field: field === 'row' ? '' : LABEL[field], message });
  const tryField = <T,>(row: number, field: Key, fn: () => T): T | null => {
    try { return fn(); } catch (e) {
      if (e instanceof LedgerError) { add(row, field, e.message); return null; }
      throw e;
    }
  };

  // Lookups (read only): settings, lots + balances, SR numbers already used.
  // Location (IN): a market location — "LM 245 · Pipe 3", "LM 245 3" or "Landmark 245 3" → stored as "LM 245 · Pipe 3".
  // Godown / Shop / Floor / Dispatched are refused. A shop no. not yet in the market's list is added on import (noted).
  const markets = await marketRows(q);
  const shopRows = await q(`SELECT market_id, shop_no FROM market_shops WHERE active`);
  const knownShops = new Set(shopRows.rows.map((x) => `${x.market_id}:${x.shop_no}`));
  const newShops = new Map<string, string>();
  const location = (v: unknown): string | null => {
    const s = String(v ?? '').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    const p = readPlace(s, markets);
    const k = `${p.market.id}:${p.shop_no}`;
    if (!knownShops.has(k)) newShops.set(k, describePlace(p.market.name, p.shop_no, null));
    return p.location;
  };

  const parsed: ImportRow[] = [];
  for (const { row, v } of todo) {
    const d = String(v.direction ?? '').trim().toUpperCase();
    const direction = d === 'IN' || d === 'OUT' ? d : null;
    if (has('direction') && !direction) add(row, 'direction', d ? `"${String(v.direction).trim()}" is not IN or OUT.` : 'Direction is empty (IN or OUT).');
    const lot = has('lot_id') ? tryField(row, 'lot_id', () => lotCode(v.lot_id)) : null;
    const x: ImportRow = {
      row, direction: direction ?? 'IN', lot_id: lot ?? '',
      sr_no: tryField(row, 'sr_no', () => srValue(v.sr_no)),
      challan: tryField(row, 'challan', () => challanCode(v.challan)),
      quality: tryField(row, 'quality', () => nameValue(v.quality, 'Quality')),
      design: tryField(row, 'design', () => nameValue(v.design, 'Design')),
      grey_meters: null, finished_meters: null, meters: null, mill_name: null, weaver_name: null, location: null, party: null,
      pieces: tryField(row, 'pieces', () => piecesValue(v.pieces)),
    };
    if (direction === 'IN') {
      x.grey_meters = tryField(row, 'grey_meters', () => metersValue(v.grey_meters, 'Grey meters'));
      x.finished_meters = tryField(row, 'finished_meters', () => metersValue(v.finished_meters, 'Finished meters'));
      x.mill_name = tryField(row, 'mill_name', () => nameValue(v.mill_name, 'Mill'));
      x.weaver_name = tryField(row, 'weaver_name', () => nameValue(v.weaver_name, 'Weaver'));
      x.location = tryField(row, 'location', () => location(v.location));
      const gm = v.grey_meters != null && v.grey_meters !== '';
      const fm = v.finished_meters != null && v.finished_meters !== '';
      if (!gm && !fm && (has('grey_meters') || has('finished_meters')) && !suggested.has('grey_meters') && !suggested.has('finished_meters')) add(row, 'grey_meters', 'Enter grey meters or finished meters.');
      if (x.grey_meters != null && x.finished_meters != null && x.finished_meters > x.grey_meters * 1.1) add(row, 'finished_meters', `Finished meters (${x.finished_meters}) can't be much more than grey meters (${x.grey_meters}).`);
    } else if (direction === 'OUT') {
      x.meters = tryField(row, 'meters', () => metersValue(v.meters, 'Meters'));
      x.party = tryField(row, 'party', () => nameValue(v.party, 'Party'));
      if ((v.meters == null || v.meters === '') && has('meters')) add(row, 'meters', 'Meters are required for OUT.');
      if (!x.party && (v.party == null || v.party === '') && has('party')) add(row, 'party', 'Party (the client receiving the goods) is required for OUT.');
    }
    if (direction) parsed.push(x);
  }

  const ins = parsed.filter((r) => r.direction === 'IN');
  const outs = parsed.filter((r) => r.direction === 'OUT');
  if (ins.length && !has('grey_meters') && !has('finished_meters')) headerProblems.push({ column: LABEL.grey_meters, message: `Column '${LABEL.grey_meters}' or '${LABEL.finished_meters}' is missing — incoming rows need one of them.` });
  if (outs.length && !has('meters')) headerProblems.push({ column: LABEL.meters, message: `Column '${LABEL.meters}' is missing — outgoing rows need it.` });
  if (outs.length && !has('party')) headerProblems.push({ column: LABEL.party, message: `Column '${LABEL.party}' is missing — outgoing rows need it.` });
  if (newShops.size) notes.push(`New shop no. will be added: ${[...newShops.values()].slice(0, 12).join('; ')}${newShops.size > 12 ? ` and ${newShops.size - 12} more` : ''}.`);
  if (!has('sr_no')) notes.push(`No '${LABEL.sr_no}' column: SR numbers will be left empty.`);
  if (!has('pieces')) notes.push(`No '${LABEL.pieces}' column: pieces will be left empty.`);

  // SR no.: no repeats in the file, none already used.
  const srFirst = new Map<string, number>();
  for (const r of parsed) {
    if (r.sr_no == null) continue;
    const k = `${r.direction}:${r.sr_no}`;
    const first = srFirst.get(k);
    if (first != null) add(r.row, 'sr_no', `SR no. ${r.sr_no} (${r.direction}) is also on row ${first}.`);
    else srFirst.set(k, r.row);
  }
  const srs = [...new Set(parsed.map((r) => r.sr_no).filter((n): n is number => n != null))];
  if (srs.length) {
    const used = await q(`SELECT direction, sr_no, lot_id FROM stock_movements WHERE sr_no = ANY($1::int[])`, [srs]);
    const taken = new Map(used.rows.map((u) => [`${u.direction}:${u.sr_no}`, u.lot_id as string]));
    for (const r of parsed) {
      const lotUsing = r.sr_no != null ? taken.get(`${r.direction}:${r.sr_no}`) : undefined;
      if (lotUsing) add(r.row, 'sr_no', `SR no. ${r.sr_no} is already used on an ${r.direction === 'IN' ? 'incoming' : 'outgoing'} entry (${lotUsing}).`);
    }
  }

  // Lots: new lots need quality + design; OUT needs an existing lot with enough stock at that row (top to bottom).
  const lotIds = [...new Set(parsed.map((r) => r.lot_id).filter(Boolean))];
  const bal = new Map<string, number>();
  if (lotIds.length) {
    const lr = await q(
      `SELECT l.lot_id, COALESCE(SUM(CASE WHEN sm.direction = 'IN' THEN sm.meters ELSE -sm.meters END), 0) AS balance
       FROM lots l LEFT JOIN stock_movements sm ON sm.lot_id = l.lot_id WHERE l.lot_id = ANY($1::text[]) GROUP BY l.lot_id`,
      [lotIds],
    );
    for (const x of lr.rows) bal.set(x.lot_id, Number(x.balance));
  }
  let newLots = 0;
  const round = (n: number) => Math.round(n * 100) / 100;
  for (const r of parsed) {
    if (!r.lot_id) continue;
    if (r.direction === 'IN') {
      if (!bal.has(r.lot_id)) {
        newLots++;
        if (!r.quality || !r.design) add(r.row, r.quality ? 'design' : 'quality', `${r.lot_id} is a new lot: enter quality and design.`);
        bal.set(r.lot_id, 0);
      }
      const m = r.finished_meters ?? r.grey_meters;
      if (m != null) bal.set(r.lot_id, round(bal.get(r.lot_id)! + m));
    } else {
      if (!bal.has(r.lot_id)) { add(r.row, 'lot_id', `Lot ${r.lot_id} does not exist (and no earlier IN row in this file adds it).`); continue; }
      if (r.meters == null) continue;
      const b = bal.get(r.lot_id)!;
      // Balances are only meaningful when every column was read.
      if (b + 0.001 < r.meters) { if (!headerProblems.length) add(r.row, 'meters', `Not enough stock: ${r.lot_id} has ${b} m at this row, this row sends ${r.meters} m.`); }
      else bal.set(r.lot_id, round(b - r.meters));
    }
  }

  if (doneRows.size) notes.unshift(`${doneRows.size.toLocaleString('en-IN')} row(s) of this file were already imported earlier and will be skipped.`);
  if (!raw.length && !headerProblems.length) headerProblems.push({ column: '', message: 'No filled rows found under the header row.' });
  problems.sort((a, b) => a.row - b.row);
  const ok = !headerProblems.length && !problems.length;
  return {
    ...emptyResult(ws.name, 'template'),
    ok,
    batch: ok ? batch : null,
    detected: `Looks like the app template — ${raw.length.toLocaleString('en-IN')} row${raw.length === 1 ? '' : 's'}`,
    total: raw.length,
    alreadySaved: raw.length - todo.length,
    counts: { in: ins.length, out: outs.length, newLots, adjustments: 0 },
    headerProblems,
    notes,
    problems: problems.slice(0, 2000),
    problemCount: problems.length,
    problemRows: new Set(problems.map((p) => p.row)).size,
    byField: byFieldOf(problems),
    ...(ok ? { rows: parsed } : {}),
  };
}

// ---------- commit one chunk ----------
export class ChunkRowError extends Error {
  constructor(public row: number, message: string) { super(message); }
}

/**
 * Save one chunk inside the caller's transaction. Rows already saved under the same import_ref are skipped,
 * so re-sending a chunk (retry after a timeout) is safe. Any failing row throws ChunkRowError → the whole chunk rolls back.
 */
export async function commitChunk(q: Q, batch: string, rows: unknown[], movedBy: string | null) {
  const list = rows.map((r) => (r && typeof r === 'object' ? r as Record<string, unknown> : {}));
  const nums = list.map((r) => Number(r.row));
  if (nums.some((n) => !Number.isInteger(n) || n < 2 || n > 10_000_000)) throw new LedgerError('Each row needs its Excel row number.');
  if (new Set(nums).size !== nums.length) throw new LedgerError('The same row was sent twice in one chunk.');
  // App template rows: "<batch>:<excel row>". Register rows carry their own ref (row content, so a re-saved file matches too).
  const fmtOf = (r: Record<string, unknown>) => (r.fmt === 'reg_in' || r.fmt === 'reg_out' ? r.fmt : 'tpl');
  const refs = list.map((r, i) => (fmtOf(r) === 'tpl' ? `${batch}:${nums[i]}` : String(r.ref ?? '')));
  const done = await q(`SELECT import_ref FROM stock_movements WHERE import_ref = ANY($1::text[])`, [refs]);
  const already = new Set(done.rows.map((x) => x.import_ref as string));
  const memo = newLedgerMemo();
  let saved = 0, skipped = 0, inCount = 0, outCount = 0;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const ref = refs[i];
    if (already.has(ref)) { skipped++; continue; }
    try {
      if (fmtOf(r) === 'reg_in') {
        await commitIncomingRow(q, r, movedBy, memo);
        inCount++;
      } else if (fmtOf(r) === 'reg_out') {
        await commitOutgoingRow(q, r, movedBy, memo);
        outCount++;
      } else if (r.direction === 'IN') {
        await recordIncoming(q, {
          lot_id: r.lot_id, quality: r.quality, design: r.design, grey_meters: r.grey_meters, finished_meters: r.finished_meters,
          mill_name: r.mill_name, weaver_name: r.weaver_name, source_doc: r.challan, location: r.location,
          sr_no: r.sr_no, pieces: r.pieces, import_ref: ref, capture_event_id: null, moved_by: movedBy, add_shops_by: movedBy,
        }, { requireLotDetails: true, memo });
        inCount++;
      } else if (r.direction === 'OUT') {
        await recordOutgoing(q, {
          lot_id: r.lot_id, meters: r.meters, party: r.party, source_doc: r.challan,
          sr_no: r.sr_no, pieces: r.pieces, import_ref: ref, capture_event_id: null, moved_by: movedBy,
        }, { memo });
        outCount++;
      } else {
        throw new LedgerError('Direction must be IN or OUT.');
      }
      saved++;
    } catch (e) {
      if (e instanceof LedgerError) throw new ChunkRowError(nums[i], e.message);
      throw e;
    }
  }
  return { saved, skipped, in: inCount, out: outCount, first_row: Math.min(...nums), last_row: Math.max(...nums) };
}
