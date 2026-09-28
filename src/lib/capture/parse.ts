// Deterministic readers for OCR text. No AI: plain rules + arithmetic cross-checks.
// If a read is complete and the numbers agree with each other, it is accepted without any LLM call.
//
// Supported today: the "Job Card / Cutting Report" printout used for incoming lots and job cards
//   header:  Quality, Weaver, Mill, Bill No, Chln No, LotNo, Rec Date
//   rows:    SrNo  Grey Mts  Rec Mts  Shortage%  Remark
//   totals:  <grey total> <rec total>  Total Pcs : N ... Pu.Rate r  Pu.Amt a  Gp.Rate g  Gp.Amount b
// Any other layout falls through to the generic reader, which usually sends the photo on to the LLM.

import type { CaptureType } from '../types';

export interface ParsedRead {
  data: Record<string, string | number | null>;
  confidence: number; // 0–1
  complete: boolean; // every required field for this capture type was found
  checks: { name: string; ok: boolean; detail: string }[];
  format: string;
}

const NUM = String.raw`(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})|\d+(?:\.\d{1,2})?)`;
const toNum = (s: string | undefined | null) => (s == null ? null : parseFloat(s.replace(/,/g, '')));
const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Value after a label, up to a wide gap or the next known label. */
function field(text: string, label: RegExp, next: string[]): string | null {
  const nextRe = next.length ? `(?=\\s{2,}|\\s+(?:${next.join('|')})\\b|$)` : '(?=\\s{2,}|$)';
  const re = new RegExp(`${label.source}\\s*[:.\\-]*\\s*([^\\n]+?)${nextRe}`, 'im');
  const m = text.match(re);
  const v = m?.[1]?.replace(/^[:.\-\s]+/, '').trim();
  return v ? v : null;
}

const LABELS = ['Quality', 'Weaver', 'Mill', 'Bill', 'Chln', 'Challan', 'Lot\\s*No', 'Rec\\s*Date', 'Remark', 'S\\.?\\s*r\\.?\\s*No', 'REPORT'];

export function parseCuttingReport(lines: string[], ocrConfidence: number, type: CaptureType): ParsedRead | null {
  const text = lines.join('\n');
  if (!/cutting\s*report|grey\s*mts|rec\s*mts|lot\s*no/i.test(text)) return null;

  const others = (self: string) => LABELS.filter((l) => l !== self);
  const quality = field(text, /Quality/, others('Quality'));
  const weaver = field(text, /Weaver/, others('Weaver'));
  const mill = field(text, /\bMill\b/, others('Mill'));
  const billNo = field(text, /Bill\s*No\.?/, others('Bill'))?.match(/^[A-Z0-9/-]+/i)?.[0] ?? null;
  const chlnNo = field(text, /(?:Chln|Challan)\s*No\.?/, others('Chln'))?.match(/^[A-Z0-9/-]+/i)?.[0] ?? null;
  const lotNo = field(text, /Lot\s*No\.?/, others('Lot\\s*No'))?.match(/^[A-Z0-9/-]+/i)?.[0] ?? null;

  // Detail rows — each row checks itself: shortage% must equal (grey − rec) / grey.
  const rowRe = new RegExp(String.raw`^\s*(\d{1,3})\D{0,2}\s+${NUM}\s+${NUM}\s+(\d{1,2}(?:\.\d{1,2})?)\s*%`);
  const rows: { sr: number; grey: number; rec: number; ok: boolean }[] = [];
  for (const line of lines) {
    const m = line.match(rowRe);
    if (!m) continue;
    const grey = toNum(m[2])!;
    const rec = toNum(m[3])!;
    const pct = toNum(m[4])!;
    const ok = grey > 0 && rec <= grey && close(((grey - rec) / grey) * 100, pct, 0.06);
    rows.push({ sr: parseInt(m[1], 10), grey, rec, ok });
  }

  // Totals line: "8988.00 7704.00 Total Pcs : 72"
  const totRe = new RegExp(String.raw`${NUM}\s+${NUM}\s+Tot[a-z]*\s*Pcs\s*[:.]?\s*(\d{1,4})`, 'i');
  const tm = text.match(totRe);
  const totalGrey = toNum(tm?.[1]);
  const totalRec = toNum(tm?.[2]);
  const totalPcs = tm ? parseInt(tm[3], 10) : null;
  const puRate = toNum(text.match(new RegExp(String.raw`Pu\.?\s*Rate\s*[:.]?\s*${NUM}`, 'i'))?.[1]);
  const puAmt = toNum(text.match(new RegExp(String.raw`Pu\.?\s*Amt\s*[:.]?\s*${NUM}`, 'i'))?.[1]);
  const gpRate = toNum(text.match(new RegExp(String.raw`Gp\.?\s*Rate\s*[:.]?\s*${NUM}`, 'i'))?.[1]);
  const gpAmt = toNum(text.match(new RegExp(String.raw`Gp\.?\s*Amount\s*[:.]?\s*${NUM}`, 'i'))?.[1]);
  const shortagePct = toNum(text.match(/Shortage\s*[:.]?\s*(\d{1,2}(?:\.\d{1,2})?)\s*%/i)?.[1]);

  const checks: ParsedRead['checks'] = [];
  const sumGrey = round2(rows.reduce((s, r) => s + r.grey, 0));
  const sumRec = round2(rows.reduce((s, r) => s + r.rec, 0));
  if (rows.length) {
    const bad = rows.filter((r) => !r.ok).map((r) => r.sr);
    checks.push({ name: 'row shortage %', ok: bad.length === 0, detail: bad.length ? `rows ${bad.join(', ')} don't add up` : `${rows.length} rows agree` });
  }
  if (totalGrey != null && totalRec != null) {
    if (rows.length && totalPcs != null && rows.length === totalPcs) {
      checks.push({ name: 'rows = totals', ok: close(sumGrey, totalGrey, 0.5) && close(sumRec, totalRec, 0.5), detail: `rows ${sumGrey}/${sumRec} vs total ${totalGrey}/${totalRec}` });
    }
    if (puRate != null && puAmt != null) checks.push({ name: 'Pu.Rate × grey = Pu.Amt', ok: close(puRate * totalGrey, puAmt, 1), detail: `${puRate} × ${totalGrey} vs ${puAmt}` });
    if (gpRate != null && gpAmt != null) checks.push({ name: 'Gp.Rate × rec = Gp.Amount', ok: close(gpRate * totalRec, gpAmt, 1), detail: `${gpRate} × ${totalRec} vs ${gpAmt}` });
    if (shortagePct != null && totalGrey > 0) checks.push({ name: 'total shortage %', ok: close(((totalGrey - totalRec) / totalGrey) * 100, shortagePct, 0.06), detail: `${shortagePct}%` });
    checks.push({ name: 'rec ≤ grey', ok: totalRec <= totalGrey, detail: `${totalRec} ≤ ${totalGrey}` });
  }

  // Meters: printed totals when present, else the sum of the rows on this page (weaker — may be a partial page).
  const grey = totalGrey ?? (rows.length ? sumGrey : null);
  const rec = totalRec ?? (rows.length ? sumRec : null);
  const fromTotals = totalGrey != null && totalRec != null;

  let data: ParsedRead['data'];
  let required: (string | number | null)[];
  if (type === 'incoming_stock') {
    data = { lot_id: lotNo, quality, design: null, grey_meters: grey, finished_meters: rec, mill_name: mill, weaver_name: weaver, source_doc: chlnNo ?? billNo };
    required = [lotNo, grey, mill];
  } else if (type === 'job_card_folding') {
    data = { lot_id: lotNo, job_card_id: null, meters_out: rec, worker_id: null };
    required = [lotNo, rec];
  } else {
    return null; // dispatch challans use a different layout
  }

  const complete = required.every((v) => v !== null && v !== '');
  const failed = checks.filter((c) => !c.ok).length;
  const strong = checks.filter((c) => c.ok && c.name !== 'rec ≤ grey' && c.name !== 'row shortage %').length;
  let confidence: number;
  if (!complete) confidence = Math.min(0.5, ocrConfidence);
  else if (failed > 0) confidence = Math.min(0.6, ocrConfidence);
  else if (fromTotals && strong >= 1) confidence = Math.min(0.97, ocrConfidence);
  else if (fromTotals) confidence = Math.min(0.85, ocrConfidence);
  else confidence = Math.min(0.7, ocrConfidence); // only row sums on one page: a person should confirm

  return { data, confidence: round2(confidence), complete, checks, format: 'cutting_report' };
}

/** Very small generic reader for dispatch challans: lot, total meters, party, challan number. */
export function parseGenericChallan(lines: string[], ocrConfidence: number, type: CaptureType): ParsedRead {
  const text = lines.join('\n');
  const lot = text.match(/Lot\s*(?:No\.?)?\s*[:.\-]?\s*([A-Z0-9][A-Z0-9/-]{1,29})/i)?.[1] ?? null;
  const challan = text.match(/(?:Chln|Challan|Invoice|Bill)\s*No\.?\s*[:.\-]?\s*([A-Z0-9][A-Z0-9/-]{0,39})/i)?.[1] ?? null;
  const party = text.match(/(?:Party|M\/s\.?|To|Buyer)\s*[:.\-]?\s*([A-Za-z][A-Za-z0-9 .&'-]{2,80})/i)?.[1]?.trim() ?? null;
  const total = toNum(text.match(new RegExp(String.raw`Total\s*(?:Mts|Meters|Mtrs)?\s*[:.\-]?\s*${NUM}`, 'i'))?.[1]);
  let data: ParsedRead['data'];
  let required: (string | number | null)[];
  if (type === 'outgoing_stock') { data = { lot_id: lot, meters: total, party, source_doc: challan }; required = [lot, total, party]; }
  else if (type === 'incoming_stock') { data = { lot_id: lot, grey_meters: total, finished_meters: null, mill_name: null, weaver_name: null, source_doc: challan }; required = [lot, total, null]; }
  else { data = { lot_id: lot, meters_out: total }; required = [lot, total]; }
  const complete = required.every((v) => v !== null && v !== '');
  // No arithmetic to cross-check on a free-form challan, so never auto-accept.
  return { data, confidence: complete ? Math.min(0.75, ocrConfidence) : Math.min(0.4, ocrConfidence), complete, checks: [], format: 'generic' };
}

export function parseOcr(lines: string[], ocrConfidence: number, type: CaptureType): ParsedRead {
  return parseCuttingReport(lines, ocrConfidence, type) ?? parseGenericChallan(lines, ocrConfidence, type);
}
