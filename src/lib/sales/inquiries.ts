// Inquiry Handling: read a free-text inquiry, check free stock + rate, draft a reply, and turn a
// won inquiry into an order. Deterministic first; a low-tier LLM only fills fields the rules missed.
import type { Q } from '../db';
import { LedgerError } from '../ledger-error';
import type { Role } from '../access';
import type { Inquiry } from '../domain';
import { canonicalLotAttr, metersValue, nameKey, nameValue } from '../normalize';
import { partyByName } from '../parties';
import { rateFor } from '../pricing';
import { freeLotsForQuality, type LotStock } from '../stock';
import { callGemini, geminiKey, parseJsonAnswer } from '../gemini';
import { detectLang, type ChatLang } from '../chat/lang';
import { parseInquiryText, type ParseContext, type ParsedInquiry } from './parse';
import { replyDraft, stripRate } from './reply';
import { createOrder, type OrderRow } from './orders';
import { addDays, dateValue, idValue, knownActor, num, rateValue, round2, todayIST } from './util';

export const INQUIRY_SOURCES = ['whatsapp', 'phone', 'visit', 'other'] as const;
export const INQUIRY_STATUSES = ['new', 'quoted', 'won', 'lost'] as const;

export type InquiryRow = Inquiry & { party_phone: string | null; design: string | null; lang: ChatLang; updated_at: string };
export interface StockInfo { free: number; lots: { lot_id: string; design: string; free: number; location: string | null }[]; design_only: boolean }
export interface InquiryView { inquiry: InquiryRow; stock: StockInfo; rate: number | null; promise_date: string | null }

const INQ_SQL = `
  SELECT i.id, i.party_id, COALESCE(p.name, i.party_name) AS party_name, p.phone AS party_phone, i.source, i.raw_text, i.parsed,
         i.quality, i.meters, i.target_rate, to_char(i.needed_by, 'YYYY-MM-DD') AS needed_by, i.quoted_rate, i.reply_draft,
         i.status, i.order_id, i.created_at, i.updated_at
  FROM inquiries i LEFT JOIN parties p ON p.id = i.party_id`;

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

function toInquiry(r: Record<string, unknown>, role: Role): InquiryRow {
  const parsed = (r.parsed as Record<string, unknown> | null) ?? null;
  const owner = role === 'owner';
  const safeParsed = parsed && !owner ? { ...parsed, target_rate: null, quoted_rate: null } : parsed;
  return {
    id: Number(r.id), party_id: num(r.party_id), party_name: (r.party_name as string) ?? null, party_phone: (r.party_phone as string) || null,
    source: r.source as Inquiry['source'], raw_text: String(r.raw_text), parsed: safeParsed,
    quality: (r.quality as string) ?? null, design: (parsed?.design as string) ?? null, meters: num(r.meters),
    target_rate: owner ? num(r.target_rate) : null, needed_by: (r.needed_by as string) ?? null,
    quoted_rate: owner ? num(r.quoted_rate) : null,
    reply_draft: owner ? ((r.reply_draft as string) ?? null) : stripRate((r.reply_draft as string) ?? null),
    status: r.status as Inquiry['status'], order_id: num(r.order_id), created_at: iso(r.created_at), updated_at: iso(r.updated_at),
    lang: (parsed?.lang as ChatLang) ?? inquiryLang(String(r.raw_text)),
  };
}

export async function loadParseContext(q: Q): Promise<ParseContext> {
  // One after another: inside a transaction all queries share one connection.
  const qs = await q(`SELECT DISTINCT quality FROM lots WHERE quality IS NOT NULL AND btrim(quality) <> ''`);
  const ds = await q(`SELECT DISTINCT design, quality FROM lots WHERE design IS NOT NULL AND btrim(design) <> ''`);
  const ps = await q(`SELECT id, name FROM parties WHERE active`);
  return { qualities: qs.rows.map((x) => x.quality), designs: ds.rows, parties: ps.rows.map((x) => ({ id: Number(x.id), name: x.name })), today: todayIST() };
}

// Extra romanised words common in order messages (the chat detector needs two hits from its own list).
const GU_ORDER = new Set(['joie', 'joiye', 'joiae', 'jove', 'aavta', 'avta', 'athvadiye', 'mokalvu', 'mokalo', 'mokli', 'che', 'chhe', 'kale', 'aapjo', 'bhav', 'sudhi', 'suddhi']);
const HI_ORDER = new Set(['chahiye', 'chaiye', 'chahie', 'bhejo', 'bhejna', 'tak', 'jaldi', 'dena', 'dijiye', 'bhav', 'kitne', 'milega', 'hai', 'agle', 'hafte', 'parso']);
export function inquiryLang(text: string): ChatLang {
  const base = detectLang(text);
  if (base !== 'en') return base;
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const gu = words.filter((w) => GU_ORDER.has(w)).length;
  const hi = words.filter((w) => HI_ORDER.has(w)).length;
  if (gu >= 2 && gu > hi) return 'gu';
  if (hi >= 2 && hi > gu) return 'hi';
  return 'en';
}

/** Low-tier LLM fallback for fields the rules could not read. Never throws. */
async function llmFill(text: string, ctx: ParseContext, p: ParsedInquiry): Promise<{ used: boolean; parsed: ParsedInquiry }> {
  if (!geminiKey() || (p.quality && p.meters)) return { used: false, parsed: p };
  try {
    const prompt =
      `Extract the fabric order inquiry fields from this message (it may be English, Hindi, Gujarati or romanised).\n` +
      `Known qualities: ${ctx.qualities.slice(0, 80).join(', ')}.\nToday is ${ctx.today}.\n` +
      `Answer JSON only: {"quality": one of the known qualities or null, "meters": number or null, "target_rate": number (₹ per meter) or null, "needed_by": "YYYY-MM-DD" or null}.\n` +
      `Message: """${text.slice(0, 1500)}"""`;
    const ans = parseJsonAnswer<{ quality?: unknown; meters?: unknown; target_rate?: unknown; needed_by?: unknown }>(
      await callGemini({ tier: 'low', feature: 'agent.inquiry', parts: [{ text: prompt }], json: true, timeoutMs: 15_000 }),
    );
    const out = { ...p, found: { ...p.found } };
    if (!out.quality && typeof ans.quality === 'string') {
      const hit = ctx.qualities.find((x) => nameKey(x) === nameKey(ans.quality as string));
      if (hit) { out.quality = hit; out.found.quality = `${hit} (AI)`; }
    }
    if (out.meters == null && Number(ans.meters) > 0 && Number(ans.meters) <= 1_000_000) { out.meters = round2(Number(ans.meters)); out.found.meters = 'AI'; }
    if (out.target_rate == null && Number(ans.target_rate) > 0 && Number(ans.target_rate) <= 5000) out.target_rate = round2(Number(ans.target_rate));
    if (out.needed_by == null && typeof ans.needed_by === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ans.needed_by) && ans.needed_by >= ctx.today) out.needed_by = ans.needed_by;
    return { used: true, parsed: out };
  } catch (e) {
    console.error('[agent.inquiry] LLM fallback failed', e);
    return { used: false, parsed: p };
  }
}

/** Free stock for a quality (design-specific when the design has free lots). */
export async function stockFor(q: Q, quality: string | null, design: string | null): Promise<StockInfo> {
  if (!quality) return { free: 0, lots: [], design_only: false };
  let lots: LotStock[] = design ? await freeLotsForQuality(q, quality, design) : [];
  const designOnly = lots.length > 0;
  if (!designOnly) lots = await freeLotsForQuality(q, quality);
  return {
    free: round2(lots.reduce((s, l) => s + l.free, 0)),
    lots: lots.map((l) => ({ lot_id: l.lot_id, design: l.design, free: l.free, location: l.location })),
    design_only: designOnly,
  };
}

/** Stock + rate + promise date + reply draft for an inquiry's current fields. */
async function enrich(q: Q, f: { quality: string | null; design: string | null; meters: number | null; party_id: number | null; party_name: string | null; quoted_rate: number | null; lang: ChatLang }, role: Role) {
  const stock = await stockFor(q, f.quality, f.design);
  const rate = f.quality ? (f.quoted_rate ?? (await rateFor(q, f.quality, f.party_id))) : null;
  const promise = f.quality && f.meters != null && stock.free >= f.meters ? addDays(todayIST(), 2) : null;
  const draft = replyDraft({
    lang: f.lang, party: f.party_name, quality: f.quality, design: f.design, meters: f.meters, free: stock.free,
    rate, promise, includeRate: role === 'owner',
  });
  return { stock, rate, promise, draft };
}

async function view(q: Q, id: number, role: Role): Promise<InquiryView> {
  const r = await q(`${INQ_SQL} WHERE i.id = $1`, [id]);
  if (!r.rows[0]) throw new LedgerError(`Inquiry #${id} not found.`, 404);
  const inquiry = toInquiry(r.rows[0], role);
  const stock = await stockFor(q, inquiry.quality, inquiry.design);
  const rate = role === 'owner' && inquiry.quality ? (inquiry.quoted_rate ?? (await rateFor(q, inquiry.quality, inquiry.party_id))) : null;
  const promise = inquiry.quality && inquiry.meters != null && stock.free >= inquiry.meters ? addDays(todayIST(), 2) : null;
  return { inquiry, stock, rate, promise_date: promise };
}

export const getInquiry = (q: Q, id: unknown, role: Role) => view(q, idValue(id, 'inquiry'), role);

export async function listInquiries(q: Q, f: { status?: string | null; role: Role; limit?: number }): Promise<InquiryRow[]> {
  const st = (f.status ?? '').trim();
  const statuses = st && st !== 'all' ? st.split(',').map((s) => s.trim()) : null;
  if (statuses?.some((s) => !(INQUIRY_STATUSES as readonly string[]).includes(s))) throw new LedgerError('Unknown inquiry status.');
  const r = await q(`${INQ_SQL} WHERE ($1::text[] IS NULL OR i.status = ANY($1::text[])) ORDER BY i.created_at DESC, i.id DESC LIMIT $2`,
    [statuses, Math.min(Math.max(f.limit ?? 100, 1), 500)]);
  return r.rows.map((x) => toInquiry(x, f.role));
}

/** Read + save a new inquiry. */
export async function createInquiry(q: Q, b: Record<string, unknown>, role: Role, actorRaw: string | null): Promise<InquiryView> {
  const raw = typeof b.raw_text === 'string' ? b.raw_text.trim() : '';
  if (!raw) throw new LedgerError('Paste or type the inquiry first.');
  if (raw.length > 4000) throw new LedgerError('The inquiry text is too long (max 4,000 characters).');
  const source = b.source == null || b.source === '' ? 'other' : String(b.source);
  if (!(INQUIRY_SOURCES as readonly string[]).includes(source)) throw new LedgerError('Source must be WhatsApp, phone, visit or other.');

  const ctx = await loadParseContext(q);
  const rules = parseInquiryText(raw, ctx);
  const { used: llm, parsed: p } = await llmFill(raw, ctx, rules);
  const lang = inquiryLang(raw);

  // A party typed in the form wins over a name found in the text.
  let partyId = p.party_id;
  let partyName = p.party_name;
  const given = nameValue(b.party_name, 'Party');
  if (given) {
    const known = await partyByName(q, given, false);
    partyId = known?.id ?? null;
    partyName = known?.name ?? given;
  }
  const f = { quality: p.quality, design: p.design, meters: p.meters, party_id: partyId, party_name: partyName, quoted_rate: null, lang };
  const e = await enrich(q, f, role);
  const parsed = { ...p, party_id: partyId, party_name: partyName, lang, llm, found: p.found };
  const ins = await q(
    `INSERT INTO inquiries (party_id, party_name, source, raw_text, parsed, quality, meters, target_rate, needed_by, reply_draft, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [partyId, partyName, source, raw, JSON.stringify(parsed), p.quality, p.meters, p.target_rate, p.needed_by, e.draft, await knownActor(q, actorRaw)],
  );
  return view(q, Number(ins.rows[0].id), role);
}

/** Edit fields / status / draft. Changing a field re-writes the draft unless a draft is sent too. */
export async function updateInquiry(q: Q, idRaw: unknown, b: Record<string, unknown>, role: Role): Promise<InquiryView> {
  const id = idValue(idRaw, 'inquiry');
  const cur = await q(`SELECT * FROM inquiries WHERE id = $1 FOR UPDATE`, [id]);
  const row = cur.rows[0];
  if (!row) throw new LedgerError(`Inquiry #${id} not found.`, 404);
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined;
  const parsed: Record<string, unknown> = { ...(row.parsed ?? {}) };
  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  let fieldsChanged = false;

  if (has('status')) {
    const s = String(b.status);
    if (!(INQUIRY_STATUSES as readonly string[]).includes(s)) throw new LedgerError('Status must be new, quoted, won or lost.');
    set('status', s);
  }
  if (has('quoted_rate')) {
    if (role !== 'owner') throw new LedgerError('Only the owner can set a rate.', 403);
    set('quoted_rate', rateValue(b.quoted_rate, 'Quoted rate'));
    fieldsChanged = true;
  }
  if (has('quality')) {
    const qi = nameValue(b.quality, 'Quality');
    const quality = qi ? (await canonicalLotAttr(q, 'quality', qi)) ?? qi : null;
    set('quality', quality);
    if (quality?.toLowerCase() !== String(row.quality ?? '').toLowerCase()) parsed.design = null;
    fieldsChanged = true;
  }
  if (has('design')) {
    const di = nameValue(b.design, 'Design');
    parsed.design = di ? (await canonicalLotAttr(q, 'design', di)) ?? di : null;
    fieldsChanged = true;
  }
  if (has('meters')) { set('meters', metersValue(b.meters, 'Meters')); fieldsChanged = true; }
  if (has('needed_by')) { set('needed_by', dateValue(b.needed_by, 'Needed by')); fieldsChanged = true; }
  if (has('party_name')) {
    const n = nameValue(b.party_name, 'Party');
    const known = n ? await partyByName(q, n, false) : null;
    set('party_id', known?.id ?? null);
    set('party_name', known?.name ?? n);
    fieldsChanged = true;
  }
  if (has('source')) {
    const s = String(b.source);
    if (!(INQUIRY_SOURCES as readonly string[]).includes(s)) throw new LedgerError('Source must be WhatsApp, phone, visit or other.');
    set('source', s);
  }
  if (has('reply_draft')) {
    const d = b.reply_draft == null ? null : String(b.reply_draft).slice(0, 4000);
    if (role !== 'owner' && d && stripRate(d) !== d) throw new LedgerError('Supervisors cannot put a rate in the reply. Ask the owner.', 403);
    set('reply_draft', d);
  }
  if (fieldsChanged) { parsed.edited = true; set('parsed', JSON.stringify(parsed)); }
  if (!sets.length) throw new LedgerError('Nothing to change.');
  await q(`UPDATE inquiries SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, params);

  if (fieldsChanged && !has('reply_draft')) {
    const r = await q(`${INQ_SQL} WHERE i.id = $1`, [id]);
    const i = toInquiry(r.rows[0], 'owner');
    const e = await enrich(q, { quality: i.quality, design: (parsed.design as string) ?? null, meters: i.meters, party_id: i.party_id, party_name: i.party_name, quoted_rate: i.quoted_rate, lang: i.lang }, role);
    await q(`UPDATE inquiries SET reply_draft = $2 WHERE id = $1`, [id, e.draft]);
  }
  return view(q, id, role);
}

/** Won inquiry → order (owner). */
export async function convertInquiry(q: Q, idRaw: unknown, b: Record<string, unknown>, actor: string | null): Promise<{ order: OrderRow; warnings: string[] }> {
  const id = idValue(idRaw, 'inquiry');
  const cur = await q(`SELECT * FROM inquiries WHERE id = $1 FOR UPDATE`, [id]);
  const row = cur.rows[0];
  if (!row) throw new LedgerError(`Inquiry #${id} not found.`, 404);
  if (row.order_id) throw new LedgerError(`This inquiry already has order #${row.order_id}.`);
  if (row.status === 'lost') throw new LedgerError('This inquiry is marked lost. Change its status first.');
  const partyName = b.party ?? b.party_name ?? row.party_name;
  let partyId: number | null = row.party_id ? Number(row.party_id) : null;
  if (!partyId || b.party || b.party_name) {
    const p = await partyByName(q, partyName, true);
    if (!p) throw new LedgerError('Add the party name before creating the order.');
    partyId = p.id;
  }
  const quality = b.quality ?? row.quality;
  const meters = b.meters ?? row.meters;
  if (!quality) throw new LedgerError('Add the quality before creating the order.');
  if (meters == null || meters === '') throw new LedgerError('Add the meters before creating the order.');
  const rate = rateValue(b.rate_per_m, 'Rate') ?? num(row.quoted_rate) ?? num(row.target_rate) ?? null; // null → createOrder uses rateFor
  // pg returns DATE as a JS Date — read it as text.
  const nb = await q(`SELECT to_char(needed_by, 'YYYY-MM-DD') AS d FROM inquiries WHERE id = $1`, [id]);
  let promise = b.promise_date !== undefined ? b.promise_date : (nb.rows[0].d ?? null);
  if (b.promise_date === undefined && promise && promise < todayIST()) promise = null; // needed-by already passed: leave blank
  const res = await createOrder(q, {
    party_id: partyId, quality, design: b.design ?? row.parsed?.design ?? null, meters, rate_per_m: rate, promise_date: promise,
    notes: b.notes ?? `From inquiry #${id}`, inquiry_id: id,
  }, actor);
  await q(`UPDATE inquiries SET status = 'won', order_id = $2, party_id = $3, updated_at = NOW() WHERE id = $1`, [id, res.order.id, partyId]);
  return res;
}
