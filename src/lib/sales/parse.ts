// Deterministic reader for a free-text inquiry (WhatsApp paste, typed or dictated), in English,
// Hindi, Gujarati or romanised Hindi/Gujarati:
//   "Need 2000 mtr DON-2 @13.5 by 10th" · "2000 मीटर जॉर्जेट चाहिए" · "aavta athvadiye 1500 meter chiffon"
// Pure function: the caller passes the known qualities / designs / parties and today's date.
import { nameKey } from '../normalize';
import { addDays, isRealDate } from './util';

export interface ParseContext {
  qualities: string[];
  designs: { design: string; quality: string }[];
  parties: { id: number; name: string }[];
  today: string; // YYYY-MM-DD (India)
}

export interface ParsedInquiry {
  quality: string | null;
  design: string | null;
  meters: number | null;
  target_rate: number | null;
  needed_by: string | null;
  party_id: number | null;
  party_name: string | null;
  /** The words each field was read from (shown as "read from …" hints, and for debugging). */
  found: Record<string, string>;
}

// ---------- text helpers ----------
const L = '\\p{L}\\p{M}\\p{N}';
/** Whole-word alternation, Unicode aware (Devanagari matras count as part of a word). */
const word = (alts: string) => `(?<![${L}])(?:${alts})(?![${L}])`;

const toAsciiDigits = (s: string) =>
  s.replace(/[०-९]/g, (c) => String(c.charCodeAt(0) - 0x0966)).replace(/[૦-૯]/g, (c) => String(c.charCodeAt(0) - 0x0AE6));

// Script / romanised spellings of fabric words → English, so they can match lot qualities.
const FABRIC_ALIASES: [string, string][] = [
  ['जॉर्जेट|जार्जेट|जोर्जेट|जॉरजेट|જ્યોર્જેટ|જોર્જેટ|જ્યોર્જટ|jorjet|jorjett|georget|jorget|jarjet', 'georgette'],
  ['शिफॉन|शिफोन|शिफान|શિફોન|શિફૉન|shifon|chifon|shiffon', 'chiffon'],
  ['साटन|सैटिन|साटिन|सटिन|સાટિન|સેટિન|સાટન|saatin|saten|satan', 'satin'],
  ['रेयॉन|रेयान|रेयोन|रियॉन|રેયોન|રેયૉન|reyon|reon', 'rayon'],
  ['क्रेप|क्रैप|ક્રેપ|crep', 'crepe'],
  ['पॉली|पोली|પોલી|પૉલી', 'poly'],
  ['प्रिंट|प्रिन्ट|પ્રિન્ટ|પ્રિંટ', 'print'],
  ['सिल्क|સિલ્ક', 'silk'],
  ['कॉटन|कोटन|કોટન|કૉટન', 'cotton'],
  ['लिनन|लिनेन|લિનન', 'linen'],
  ['खादी|ખાદી', 'khadi'],
  ['डॉन|डोन|ડોન|ડૉન', 'don'],
];

const UNIT = 'mtrs?|mts?|m|meters?|metres?|mitar|meetar|miter|मीटर|मी|મીટર|મી';
const NUM = '(\\d{1,3}(?:,\\d{2,3})+|\\d+)(?:\\.(\\d+))?';
const toNum = (int: string, dec?: string) => parseFloat(int.replace(/,/g, '') + (dec ? `.${dec}` : ''));

const MONTHS: [string, number][] = [
  ['january|jan|जनवरी|જાન્યુઆરી', 1], ['february|feb|फरवरी|ફેબ્રુઆરી', 2], ['march|mar|मार्च|માર્ચ', 3],
  ['april|apr|अप्रैल|એપ્રિલ', 4], ['may|मई|મે', 5], ['june|jun|जून|જૂન', 6], ['july|jul|जुलाई|જુલાઈ', 7],
  ['august|aug|अगस्त|ઓગસ્ટ', 8], ['september|sept|sep|सितंबर|सितम्बर|સપ્ટેમ્બર', 9], ['october|oct|अक्टूबर|અક્ટોબર|ઓક્ટોબર', 10],
  ['november|nov|नवंबर|नवम्बर|નવેમ્બર', 11], ['december|dec|दिसंबर|दिसम्बर|ડિસેમ્બર', 12],
];
const MONTH_ALT = MONTHS.map(([a]) => a).join('|');
const monthOf = (s: string) => MONTHS.find(([a]) => new RegExp(`^(?:${a})$`, 'iu').test(s))?.[1] ?? null;

// 0 = Sunday
const WEEKDAYS: [string, number][] = [
  ['sunday|sun|ravivar|raviwar|रविवार|રવિવાર', 0], ['monday|mon|somvar|somwar|सोमवार|સોમવાર', 1],
  ['tuesday|tue|tues|mangalvar|mangalwar|मंगलवार|મંગળવાર', 2], ['wednesday|wed|budhvar|budhwar|बुधवार|બુધવાર', 3],
  ['thursday|thu|thur|thurs|guruvar|guruwar|गुरुवार|ગુરુવાર', 4], ['friday|fri|shukravar|shukrawar|शुक्रवार|શુક્રવાર', 5],
  ['saturday|sat|shanivar|shaniwar|शनिवार|શનિવાર', 6],
];

const RELATIVE: [string, number][] = [
  ['day after tomorrow|parso|parson|parsoo|परसों|परसो|પરમદિવસે|પરમ દિવસે|parmdivse|param divse', 2],
  ['tomorrow|tmrw|tmr|kal|kale|aavtikale|avtikale|कल|આવતીકાલે|કાલે', 1],
  ['today|aaj|aaje|aje|आज|આજે', 0],
  ['next week|agle hafte|agle hafta|agle week|अगले हफ्ते|अगले सप्ताह|aavta athvadiye|avta athvadiye|aavte athvadiye|આવતા અઠવાડિયે|આવતે અઠવાડિયે', 7],
];

/** Blank out a matched span so later rules don't read the same digits again. */
const blank = (s: string, start: number, len: number) => s.slice(0, start) + ' '.repeat(len) + s.slice(start + len);

function dayOfMonth(today: string, day: number, month: number | null, year: number | null): string | null {
  const [ty, tm, td] = today.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (month == null) {
    // "10th": this month if still ahead, else next month.
    let y = ty;
    let m = tm;
    if (day < td) { m += 1; if (m > 12) { m = 1; y += 1; } }
    const iso = `${y}-${pad(m)}-${pad(day)}`;
    return isRealDate(iso) ? iso : null;
  }
  let y = year ?? ty;
  if (y < 100) y += 2000;
  let iso = `${y}-${pad(month)}-${pad(day)}`;
  if (!isRealDate(iso)) return null;
  if (year == null && iso < today) { y += 1; iso = `${y}-${pad(month)}-${pad(day)}`; if (!isRealDate(iso)) return null; }
  return iso;
}

// ---------- token matching (qualities, designs, parties) ----------
function tokenKeys(text: string): string[] {
  let t = text;
  for (const [alts, en] of FABRIC_ALIASES) t = t.replace(new RegExp(word(alts), 'giu'), ` ${en} `);
  // Non-Latin words become '' and act as breaks (a phrase can't be joined across them).
  return t.split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w.length).map((w) => nameKey(w));
}

/** Does `key` appear as a run of whole consecutive tokens? Returns the matched text length or 0. */
function tokenRun(tokens: string[], key: string): boolean {
  if (!key) return false;
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i]) continue;
    let acc = '';
    for (let j = i; j < tokens.length && tokens[j] && acc.length < key.length + 1; j++) {
      acc += tokens[j];
      if (acc === key || acc === `${key}s`) return true;
    }
  }
  return false;
}

/** Longest whole-token match among candidate names. */
function bestMatch<T>(tokens: string[], items: T[], nameOf: (x: T) => string, ok: (key: string) => boolean): T | null {
  let best: T | null = null;
  let bestLen = 0;
  for (const it of items) {
    const k = nameKey(nameOf(it));
    if (!ok(k) || k.length <= bestLen) continue;
    if (tokenRun(tokens, k)) { best = it; bestLen = k.length; }
  }
  return best;
}

// Words too common to identify a quality / party on their own.
const GENERIC = new Set([
  'print', 'prints', 'premium', 'super', 'classic', 'smooth', 'blend', 'textured', 'plain', 'fabric', 'cloth',
  'saree', 'sarees', 'textile', 'textiles', 'store', 'stores', 'fashion', 'house', 'silks', 'retailers', 'trading',
  'traders', 'shree', 'shri', 'sri', 'and', 'the', 'company', 'co', 'enterprises', 'mills', 'mill', 'design', 'unknown',
]);

/** One distinctive word (≥4 letters) that names exactly one candidate — e.g. "crepe" → Poly-Crepe, "Balaji" → Shree Balaji Sarees. */
function wordMatch<T>(tokens: string[], items: T[], nameOf: (x: T) => string, preferFewestWords = false): T | null {
  const present = new Set(tokens.filter(Boolean));
  const hits = items.filter((it) =>
    nameOf(it).split(/[^\p{L}\p{N}]+/u).map(nameKey).some((w) => w.length >= 4 && !GENERIC.has(w) && !/^\d+$/.test(w) && present.has(w)));
  if (hits.length === 1) return hits[0];
  if (preferFewestWords && hits.length > 1) {
    const words = (x: T) => nameOf(x).split(/[^\p{L}\p{N}]+/u).filter(Boolean).length;
    const min = Math.min(...hits.map(words));
    const fewest = hits.filter((h) => words(h) === min);
    if (fewest.length === 1) return fewest[0];
  }
  return null;
}

// ---------- main ----------
export function parseInquiryText(raw: string, ctx: ParseContext): ParsedInquiry {
  const found: Record<string, string> = {};
  const original = toAsciiDigits(raw).normalize('NFC');
  let s = original.toLowerCase();

  // 1. Target rate: "@13.5", "rate 14", "bhav 14", "₹14", "rs 14", "14 rs", "14/m", "14 per mtr".
  let target_rate: number | null = null;
  const unitAhead = new RegExp(`^\\s*(?:k\\s*)?(?:${UNIT})(?![${L}])`, 'iu');
  const rateRes = [
    new RegExp(`(?:@|₹|${word('rs\\.?|inr|rate|rt|bhav|bhaav|bhaw|भाव|रेट|ભાવ|રેટ')})\\s*[:=\\-]?\\s*(?:₹|rs\\.?)?\\s*(\\d+)(?:\\.(\\d+))?`, 'iu'),
    new RegExp(`(?<![${L}.])(\\d+)(?:\\.(\\d+))?\\s*(?:₹|${word('rs\\.?|rupees?|rupaye|rupiya|रुपये|रुपए|रु|રૂપિયા|રૂ')}|\\/-|\\/\\s*(?:${UNIT})(?![${L}])|${word('per')}\\s*(?:${UNIT})(?![${L}]))`, 'iu'),
  ];
  for (const re of rateRes) {
    const m = re.exec(s);
    if (!m) continue;
    const after = s.slice(m.index + m[0].length);
    if (re === rateRes[0] && unitAhead.test(after)) continue; // "@ 2000 mtr" is meters, not a rate
    const v = toNum(m[1], m[2]);
    if (v > 0 && v <= 5000) {
      target_rate = Math.round(v * 100) / 100;
      found.target_rate = original.substr(m.index, m[0].length).trim();
      s = blank(s, m.index, m[0].length);
      break;
    }
  }

  // 2. Meters with a unit: "2000 mtr", "2,000 m", "2k meter", "1500 मीटर".
  let meters: number | null = null;
  const mRe = new RegExp(`(?<![${L}.\\-\\/])${NUM}\\s*(k)?\\s*(?:${UNIT})(?![${L}])`, 'giu');
  for (const m of s.matchAll(mRe)) {
    let v = toNum(m[1], m[2]);
    if (m[3]) v *= 1000;
    if (v > 0 && v <= 1_000_000) {
      meters = Math.round(v * 100) / 100;
      found.meters = original.substr(m.index!, m[0].length).trim();
      s = blank(s, m.index!, m[0].length);
      break;
    }
  }

  // 3. Needed-by date.
  let needed_by: string | null = null;
  const setDate = (iso: string | null, idx: number, len: number) => {
    if (!iso || needed_by) return;
    needed_by = iso;
    found.needed_by = original.substr(idx, len).trim();
    s = blank(s, idx, len);
  };
  const today = ctx.today;
  const dateRules: [RegExp, (m: RegExpExecArray) => string | null][] = [
    // "10 Oct", "10th of October", "10-oct"
    [new RegExp(`(?<![${L}])(\\d{1,2})\\s*(?:st|nd|rd|th)?\\s*(?:of\\s*)?[\\-\\s]?(${MONTH_ALT})(?![${L}])(?:\\s*,?\\s*(\\d{4}))?`, 'iu'),
      (m) => dayOfMonth(today, +m[1], monthOf(m[2]), m[3] ? +m[3] : null)],
    // "Oct 10", "October 10th"
    [new RegExp(`(?<![${L}])(${MONTH_ALT})\\s*(\\d{1,2})(?:st|nd|rd|th)?(?![${L}])(?:\\s*,?\\s*(\\d{4}))?`, 'iu'),
      (m) => dayOfMonth(today, +m[2], monthOf(m[1]), m[3] ? +m[3] : null)],
    // "10/10", "10-10-2026", "10.10.26" (day first)
    [new RegExp(`(?<![${L}.\\-\\/])(\\d{1,2})[\\/.\\-](\\d{1,2})(?:[\\/.\\-](\\d{2}|\\d{4}))?(?![${L}]|[.\\/\\-]\\d)`, 'iu'),
      (m) => (+m[2] >= 1 && +m[2] <= 12 ? dayOfMonth(today, +m[1], +m[2], m[3] ? +m[3] : null) : null)],
    // "10th", "by 1st"
    [new RegExp(`(?<![${L}])(\\d{1,2})\\s*(?:st|nd|rd|th)(?![${L}])`, 'iu'), (m) => dayOfMonth(today, +m[1], null, null)],
    // "10 tarikh", "10 तारीख", "10 તારીખ"
    [new RegExp(`(?<![${L}])(\\d{1,2})\\s*${word('tarikh|taarikh|tareekh|तारीख|तारिख|તારીખ')}`, 'iu'), (m) => dayOfMonth(today, +m[1], null, null)],
    // "in 5 days", "5 din", "5 दिन", "5 દિવસ"
    [new RegExp(`(?<![${L}])(\\d{1,2})\\s*${word('days?|din|dino|दिन|दिनों|દિવસ|દિવસમાં')}`, 'iu'), (m) => addDays(today, +m[1])],
  ];
  for (const [re, fn] of dateRules) {
    const m = re.exec(s);
    if (m) setDate(fn(m), m.index, m[0].length);
    if (needed_by) break;
  }
  if (!needed_by) {
    for (const [alts, n] of RELATIVE) {
      const m = new RegExp(word(alts), 'iu').exec(s);
      if (m) { setDate(addDays(today, n), m.index, m[0].length); break; }
    }
  }
  if (!needed_by) {
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    for (const [alts, d] of WEEKDAYS) {
      const m = new RegExp(word(alts), 'iu').exec(s);
      if (m) { setDate(addDays(today, ((d - dow + 7) % 7) || 7), m.index, m[0].length); break; }
    }
  }

  // 4. Quality, design, party by whole-word match against known names.
  const tokens = tokenKeys(original);
  let quality = bestMatch(tokens, ctx.qualities, (x) => x, (k) => k.length >= 3);
  const designPool = ctx.designs.filter((d) => nameKey(d.design) !== 'unknowndesign');
  const designOk = (k: string) => k.length >= 2 && (/\d/.test(k) ? k.length >= 2 : k.length >= 4);
  const qualityDesigns = quality ? designPool.filter((d) => nameKey(d.quality) === nameKey(quality!)) : designPool;
  let designHit = bestMatch(tokens, qualityDesigns, (x) => x.design, designOk);
  if (!designHit && !quality) designHit = bestMatch(tokens, designPool, (x) => x.design, designOk);
  if (!quality) quality = wordMatch(tokens, ctx.qualities, (x) => x, true);
  if (!quality && designHit) {
    // A design code names its quality when it belongs to one quality only.
    const qs = new Set(designPool.filter((d) => nameKey(d.design) === nameKey(designHit!.design)).map((d) => nameKey(d.quality)));
    if (qs.size === 1) quality = designHit.quality;
  }
  if (designHit && quality && nameKey(designHit.quality) !== nameKey(quality)) {
    designHit = designPool.find((d) => nameKey(d.design) === nameKey(designHit!.design) && nameKey(d.quality) === nameKey(quality!)) ?? null;
  }
  if (quality) found.quality = quality;
  const design = designHit?.design ?? null;
  if (design) found.design = design;

  const party = bestMatch(tokens, ctx.parties, (p) => p.name, (k) => k.length >= 3) ?? wordMatch(tokens, ctx.parties, (p) => p.name);
  if (party) found.party = party.name;

  // 5. Meters without a unit: the largest stand-alone number ≥ 50 that isn't a rate, date or code.
  if (meters == null) {
    const bare = new RegExp(`(?<![${L}.,\\-\\/@₹])${NUM}(?![${L}]|[.,\\/\\-]\\d)`, 'gu');
    let best: { v: number; idx: number; len: number } | null = null;
    for (const m of s.matchAll(bare)) {
      const v = toNum(m[1], m[2]);
      if (v >= 50 && v <= 1_000_000 && (!best || v > best.v)) best = { v, idx: m.index!, len: m[0].length };
    }
    if (best) { meters = best.v; found.meters = original.substr(best.idx, best.len).trim(); }
  }

  return { quality, design, meters, target_rate, needed_by, party_id: party?.id ?? null, party_name: party?.name ?? null, found };
}
