// Excel (.xlsx) export of challans / lots and the manual-stock import template. Server-side only.
import ExcelJS from 'exceljs';

export const IMPORT_SHEET = 'Stock entries';
export const IMPORT_COLUMNS = [
  { key: 'direction', header: 'Direction (IN/OUT)', width: 18 },
  { key: 'lot_id', header: 'Lot No', width: 14 },
  { key: 'challan', header: 'Challan No', width: 14 },
  { key: 'quality', header: 'Quality (new lot)', width: 18 },
  { key: 'design', header: 'Design (new lot)', width: 16 },
  { key: 'grey_meters', header: 'Grey Mts (IN)', width: 14 },
  { key: 'finished_meters', header: 'Finished Mts (IN)', width: 16 },
  { key: 'mill_name', header: 'Mill (IN)', width: 22 },
  { key: 'weaver_name', header: 'Weaver (IN)', width: 22 },
  { key: 'location', header: 'Location (IN)', width: 14 },
  { key: 'meters', header: 'Meters (OUT)', width: 14 },
  { key: 'party', header: 'Party (OUT)', width: 24 },
] as const;
export type ImportKey = (typeof IMPORT_COLUMNS)[number]['key'];

const HEAD_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9E4D8' } };

function styleHeader(ws: ExcelJS.Worksheet) {
  const row = ws.getRow(1);
  row.font = { bold: true };
  row.fill = HEAD_FILL;
  row.alignment = { vertical: 'middle' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

export async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function newWorkbook(firmName: string) {
  const wb = new ExcelJS.Workbook();
  wb.creator = firmName;
  wb.created = new Date();
  return wb;
}

export function challanSheet(wb: ExcelJS.Workbook, rows: Record<string, unknown>[]) {
  const ws = wb.addWorksheet('Challans');
  ws.columns = [
    { header: 'S.No', key: 'sno', width: 7 },
    { header: 'Date', key: 'date', width: 12, style: { numFmt: 'dd-mm-yyyy' } },
    { header: 'IN/OUT', key: 'direction', width: 8 },
    { header: 'Challan No', key: 'challan', width: 14 },
    { header: 'Lot No', key: 'lot_id', width: 14 },
    { header: 'Quality', key: 'quality', width: 18 },
    { header: 'Design', key: 'design', width: 14 },
    { header: 'Grey Mts', key: 'grey', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'Finished Mts', key: 'finished', width: 13, style: { numFmt: '#,##0.00' } },
    { header: 'Stock Mts', key: 'meters', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'Mill', key: 'mill', width: 22 },
    { header: 'Weaver', key: 'weaver', width: 22 },
    { header: 'Party', key: 'party', width: 24 },
    { header: 'Entry', key: 'entry', width: 10 },
  ];
  rows.forEach((r, i) => {
    ws.addRow({
      sno: i + 1,
      date: r.ts ? new Date(String(r.ts)) : null,
      direction: r.direction,
      challan: r.source_doc_id ?? '',
      lot_id: r.lot_id,
      quality: r.quality ?? '',
      design: r.design ?? '',
      grey: r.grey_meters != null ? Number(r.grey_meters) : null,
      finished: r.finished_meters != null ? Number(r.finished_meters) : null,
      meters: Number(r.meters),
      mill: r.mill_name ?? '',
      weaver: r.weaver_name ?? '',
      party: r.direction === 'OUT' ? r.party ?? '' : '',
      entry: r.capture_event_id ? 'Photo' : 'Manual',
    });
  });
  styleHeader(ws);
  ws.autoFilter = { from: 'A1', to: 'N1' };
  return ws;
}

export function lotsSheet(wb: ExcelJS.Workbook, rows: Record<string, unknown>[]) {
  const ws = wb.addWorksheet('Lots');
  ws.columns = [
    { header: 'S.No', key: 'sno', width: 7 },
    { header: 'Lot No', key: 'lot_id', width: 14 },
    { header: 'Quality', key: 'quality', width: 18 },
    { header: 'Design', key: 'design', width: 14 },
    { header: 'Balance Mts', key: 'balance', width: 13, style: { numFmt: '#,##0.00' } },
    { header: 'Location', key: 'location', width: 14 },
  ];
  rows.forEach((r, i) => ws.addRow({ sno: i + 1, lot_id: r.lot_id, quality: r.quality, design: r.design, balance: Number(r.balance ?? 0), location: r.location ?? '' }));
  styleHeader(ws);
  return ws;
}

// The import template (Direction + market-code dropdowns) is built by importTemplate() in src/lib/stock-import.ts.

/** Read the import sheet into plain objects keyed by IMPORT_COLUMNS keys. Header text decides the column. */
export async function readImport(buffer: Buffer): Promise<{ row: number; values: Partial<Record<ImportKey, unknown>> }[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.getWorksheet(IMPORT_SHEET) ?? wb.worksheets[0];
  if (!ws) return [];
  const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const colFor = new Map<number, ImportKey>();
  ws.getRow(1).eachCell((cell, col) => {
    const h = norm(cell.value);
    const hit = IMPORT_COLUMNS.find((c) => norm(c.header) === h || norm(c.header).startsWith(h) && h.length >= 4);
    if (hit) colFor.set(col, hit.key);
  });
  const out: { row: number; values: Partial<Record<ImportKey, unknown>> }[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const values: Partial<Record<ImportKey, unknown>> = {};
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const key = colFor.get(col);
      if (!key) return;
      let v: unknown = cell.value;
      if (v && typeof v === 'object' && 'result' in (v as object)) v = (v as { result: unknown }).result; // formula
      if (v && typeof v === 'object' && 'text' in (v as object)) v = (v as { text: unknown }).text; // hyperlink / rich text
      if (v && typeof v === 'object' && 'richText' in (v as object)) v = (v as { richText: { text: string }[] }).richText.map((t) => t.text).join('');
      values[key] = typeof v === 'string' ? v.trim() : v;
    });
    if (Object.values(values).some((v) => v !== null && v !== undefined && v !== '')) out.push({ row: n, values });
  });
  return out;
}
