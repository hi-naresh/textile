// Chat decision layer — cheapest path first:
//   1. Deterministic, no AI:
//      a. fixed templates for specific lookups (a challan, a lot, reviews waiting, time saved, "what's happening"),
//      b. the semantic layer (semantic.ts): counts / sums / % by worker, section, quality, party, mill, day …
//         ("how many workers", "who folded how much today", "dispatch by party this month"),
//      c. the remaining simple templates (stock, dispatch, receipts, shortage list, open cards).
//   2. Not matched → low-tier LLM only classifies the question: a template, or a semantic spec
//      (metric + group + filters + period from the catalog), or "knowledge". It never writes SQL.
//   3. Knowledge questions (policies, how-tos) → search the firm's notes (Postgres full-text) → low-tier LLM
//      answers from those notes only (RAG). Without an LLM, the best matching note is shown.
// The LLM never writes SQL and never sees the database directly.
import { query } from '../db';
import { callGemini, geminiKey, parseJsonAnswer } from '../gemini';
import { nameKey } from '../normalize';
import { detectLang, LANG_NAME, withEnglishHints, type ChatLang } from './lang';
import { TEMPLATES, templateById, type Params, type Scope } from './templates';
import { briefing, catalogForLlm, cleanSpec, parseSemantic, runSpec, type Spec } from './semantic';

export interface ChatAnswer {
  answer: string;
  rows: Record<string, unknown>[];
  route: 'template' | 'query' | 'knowledge' | 'help';
  template?: string;
  params?: Params;
  spec?: Spec;
  via: 'rules' | 'llm' | 'search';
  sources?: { id: number; title: string }[];
}

const HELP =
  'Try: "what\'s happening today?", "how many workers do I have?", "who folded how much today?", "dispatch by party this month", "stock by quality", "efficiency by section this week", "status of lot 257A", "challan 51". For policy questions, the owner can add notes in Settings → Firm knowledge.';

async function knownNames() {
  const [lots, parties, mills, workers, sections, qualities, settings] = await Promise.all([
    query(`SELECT lot_id FROM lots`),
    query(`SELECT DISTINCT party AS n FROM stock_movements WHERE direction = 'OUT' AND party IS NOT NULL`),
    query(`SELECT DISTINCT mill_name AS n FROM stock_movements WHERE mill_name IS NOT NULL`),
    query(`SELECT name AS n FROM workers WHERE active`),
    query(`SELECT name AS n FROM sections WHERE active ORDER BY sort_order`),
    query(`SELECT DISTINCT quality AS n FROM lots`),
    query(`SELECT location_presets FROM app_settings WHERE id = 1`),
  ]);
  return {
    lots: lots.rows.map((r) => String(r.lot_id)),
    parties: parties.rows.map((r) => String(r.n)),
    mills: mills.rows.map((r) => String(r.n)),
    workers: workers.rows.map((r) => String(r.n)),
    sections: sections.rows.map((r) => String(r.n)),
    qualities: qualities.rows.map((r) => String(r.n)),
    locations: (settings.rows[0]?.location_presets as string[] | undefined) ?? ['Godown', 'Shop', 'Floor'],
  };
}

const BRIEFING = /\b(what'?s|what is|whats) (happening|going on|up)|\b(summary|overview|briefing|status update|update me|how'?s (business|work|it going)|how is (business|work|everything))\b|kya chal|shu chal|aaj ka (hisab|haal)/;
const STRONG = new Set(['challan_lookup', 'time_saved', 'pending_reviews']);

function daysIn(q: string): number | null {
  const n = q.match(/(?:last|past|pichhle|pichle)\s+(\d{1,3})\s*(?:days?|din)/);
  if (n) return parseInt(n[1], 10);
  if (/\b(today|aaj|aje)\b/.test(q)) return 1;
  if (/\b(yesterday|kal)\b/.test(q)) return 2;
  if (/\b(week|hafte|hafta|saptah)\b/.test(q)) return 7;
  if (/\b(month|mahine|mahina)\b/.test(q)) return 30;
  if (/\b(year|saal)\b/.test(q)) return 365;
  return null;
}

/** Longest known name whose match key appears in the question. */
function findName(qKey: string, names: string[]): string | null {
  let best: string | null = null;
  for (const n of names) {
    const k = nameKey(n);
    if (k.length >= 4 && qKey.includes(k) && (!best || k.length > nameKey(best).length)) best = n;
  }
  return best;
}

function findWorker(q: string, workers: string[]): string | null {
  const words = new Set(q.split(/[^a-z]+/).filter((w) => w.length >= 3));
  for (const w of workers) {
    const first = w.toLowerCase().split(/\s+/)[0];
    if (words.has(first) || q.includes(w.toLowerCase())) return w;
  }
  return null;
}

export function matchRules(question: string, names: Awaited<ReturnType<typeof knownNames>>): { template: string; params: Params } | null {
  const q = question.toLowerCase();
  const qKey = nameKey(question);
  const tokens = question.toUpperCase().split(/[^A-Z0-9/-]+/).filter(Boolean);
  const lotSet = new Map(names.lots.map((l) => [l.toUpperCase(), l]));
  const lot = tokens.map((t) => lotSet.get(t)).find(Boolean) ?? null;
  const party = findName(qKey, names.parties);
  const mill = findName(qKey, names.mills);
  const worker = findWorker(q, names.workers);
  const days = daysIn(q);
  const challan = q.match(/(?:challan|chln|chalan)\s*(?:no\.?|number|#)?\s*[:#-]?\s*([a-z0-9][a-z0-9/-]*)/)?.[1]?.toUpperCase() ?? null;

  if (challan && /\d/.test(challan)) return { template: 'challan_lookup', params: { challan } };
  if (/time\s*saved|saving|roi|kitna\s*samay/.test(q)) return { template: 'time_saved', params: { days } };
  if (/review|pending|waiting|confirm/.test(q) && !/order|inquir|enquir|payment|paisa|invoice|bill/.test(q)) return { template: 'pending_reviews', params: {} };
  if (/shortage|short\b|ghat|kami/.test(q)) return { template: 'shortage_report', params: { days } };
  if (/efficien|slow|performance|output/.test(q) || (worker && !lot)) return { template: 'worker_efficiency', params: { worker, days } };
  if (/open\s*(job)?\s*cards?|on the floor|running|in process|chal rah/.test(q)) return { template: 'open_job_cards', params: {} };
  if (party || /dispatch|sent|outgoing|bheja|party|client|sold/.test(q)) {
    if (!lot || party) return { template: 'dispatch_by_party', params: { party, days } };
  }
  if (mill || /received|incoming|inward|aaya|mill|weaver|grey/.test(q)) {
    if (!lot || mill) return { template: 'receipts_by_mill', params: { mill, days } };
  }
  if (lot) return { template: 'lot_status', params: { lot } };
  if (/quality/.test(q) && /stock|maal|meter|balance/.test(q)) return { template: 'stock_by_quality', params: {} };
  if (/stock|maal|balance|inventory|godown|kitna|total meter/.test(q)) return { template: 'stock_summary', params: {} };
  return null;
}

async function classifyWithLlm(question: string, names: Awaited<ReturnType<typeof knownNames>>, ref: string) {
  const list = TEMPLATES.map((t) => `- ${t.id}: ${t.describe}${t.params.length ? ` (params: ${t.params.join(', ')})` : ''}`).join('\n');
  const prompt = `Route a question from a textile firm's owner or supervisor (English, Hindi or Gujarati).
Choose ONE:
A) a template: {"template": "<id>", "params": {…}}
${list}
- briefing: overall "what's happening today" summary
   template params: lot, party, mill, worker, challan, quality, days (integer look-back window)
B) a query over this catalog (counts / sums / % with optional breakdown): {"query": {"metric": "<metric>", "group_by": "<dim or null>", "filters": {"section"|"worker"|"quality"|"party"|"mill"|"lot"|"location": "<value>"}, "period": <period>, "top": <n or null>}}
${catalogForLlm()}
C) {"template": "knowledge"} for the firm's policies / rules / how-to, or {"template": "none"}.
Use names exactly as known. Sections: ${names.sections.join(', ')}. Workers: ${names.workers.slice(0, 40).join(', ')}.
Qualities: ${names.qualities.slice(0, 30).join(', ')}. Parties: ${names.parties.slice(0, 30).join(', ')}. Mills: ${names.mills.slice(0, 30).join(', ')}. Lots (sample): ${names.lots.slice(-30).join(', ')}.
Answer ONLY JSON.
Question: ${JSON.stringify(question)}`;
  const text = await callGemini({ tier: 'low', feature: 'chat.intent', parts: [{ text: prompt }], json: true, ref, timeoutMs: 20_000 });
  const out = parseJsonAnswer<{ template?: string; params?: Record<string, unknown>; query?: unknown }>(text);
  if (out.query) {
    const spec = cleanSpec(out.query);
    if (spec) return { template: 'query', params: {} as Params, spec };
  }
  const p = out.params ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null);
  const days = typeof p.days === 'number' ? p.days : parseInt(String(p.days ?? ''), 10);
  const params: Params = {
    lot: str(p.lot)?.toUpperCase() ?? null, party: str(p.party), mill: str(p.mill), worker: str(p.worker),
    challan: str(p.challan)?.toUpperCase() ?? null, quality: str(p.quality), days: Number.isFinite(days) ? days : null,
  };
  return { template: out.template ?? 'none', params, spec: null as Spec | null };
}

async function searchKnowledge(question: string) {
  const words = Array.from(new Set(question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])).slice(0, 12);
  if (!words.length) return [];
  const tsq = words.map((w) => w.replace(/'/g, '')).join(' | ');
  const r = await query(
    `SELECT id, title, body, ts_rank(search, to_tsquery('simple', $1)) AS rank
     FROM knowledge_docs WHERE active AND search @@ to_tsquery('simple', $1)
     ORDER BY rank DESC LIMIT 3`,
    [tsq],
  );
  return r.rows as { id: number; title: string; body: string }[];
}

async function answerFromKnowledge(question: string, ref: string, searchText = question): Promise<ChatAnswer | null> {
  const docs = await searchKnowledge(searchText);
  if (!docs.length) return null;
  const sources = docs.map((d) => ({ id: d.id, title: d.title }));
  if (geminiKey()) {
    try {
      const notes = docs.map((d, i) => `[${i + 1}] ${d.title}\n${d.body.slice(0, 3000)}`).join('\n\n');
      const text = await callGemini({
        tier: 'low', feature: 'chat.rag', ref, timeoutMs: 20_000, temperature: 0.2,
        parts: [{ text: `Answer the question using ONLY these notes from the firm. If the notes don't answer it, say you don't have that in the firm's notes. Reply in the question's language, in 1–4 short sentences.\n\nNotes:\n${notes}\n\nQuestion: ${question}` }],
      });
      return { answer: text, rows: [], route: 'knowledge', via: 'llm', sources };
    } catch {
      /* fall back to the note itself */
    }
  }
  const top = docs[0];
  return { answer: `From “${top.title}”: ${top.body.slice(0, 400)}${top.body.length > 400 ? '…' : ''}`, rows: [], route: 'knowledge', via: 'search', sources };
}

/**
 * Answer in the language the question was asked in (English / Hindi / Gujarati).
 * Hindi & Gujarati words get English hints so the fixed templates still match without AI;
 * the (English) template answer is then translated by the low-tier model. Without an AI key it stays English.
 */
export async function answerQuestion(question: string, scope: Scope, ref: string): Promise<ChatAnswer & { lang: ChatLang }> {
  const lang = detectLang(question);
  const r = await answerInEnglish(question, lang === 'en' ? question : withEnglishHints(question), scope, ref);
  if (lang === 'en' || !geminiKey() || (r.route === 'knowledge' && r.via === 'llm')) {
    return { ...r, lang: r.route === 'knowledge' && r.via === 'llm' ? lang : 'en' };
  }
  try {
    const text = await callGemini({
      tier: 'low', feature: 'chat.translate', ref, timeoutMs: 15_000, temperature: 0.1,
      parts: [{ text: `Translate this reply for a textile firm owner into ${LANG_NAME[lang]}. Natural, spoken style. Keep numbers, lot numbers, challan numbers, names and "m" (meters) exactly as they are. Reply with the translation only.\n\n${r.answer}` }],
    });
    return text ? { ...r, answer: text, lang } : { ...r, lang: 'en' };
  } catch {
    return { ...r, lang: 'en' };
  }
}

async function answerInEnglish(question: string, hinted: string, scope: Scope, ref: string): Promise<ChatAnswer> {
  const names = await knownNames();

  // 0. Clearly a policy / how-to question → firm notes first
  if (/\b(polic(y|ies)|rules?|procedure|how (do|to|should|can)|what should|niyam|kaise|terms)\b/i.test(hinted)) {
    const k = await answerFromKnowledge(question, ref, hinted);
    if (k) return k;
  }

  // 1a. "What's happening?" → today's briefing
  if (BRIEFING.test(hinted.toLowerCase())) {
    const r = await briefing(scope);
    return { ...r, route: 'query', template: 'briefing', via: 'rules' };
  }

  // 1b. Specific lookups, then the semantic layer, then simple templates
  const hit = matchRules(hinted, names);
  if (hit && STRONG.has(hit.template)) {
    const t = templateById(hit.template)!;
    const r = await t.run(hit.params, scope);
    return { ...r, route: 'template', template: t.id, params: hit.params, via: 'rules' };
  }
  const spec = parseSemantic(hinted, names);
  const onlyLot = spec && spec.metric === 'stock' && !spec.groupBy && Object.keys(spec.filters ?? {}).join() === 'lot';
  if (spec && !onlyLot) {
    const r = await runSpec(spec, scope);
    return { ...r, route: 'query', spec, via: 'rules' };
  }
  if (hit) {
    const t = templateById(hit.template)!;
    const r = await t.run(hit.params, scope);
    return { ...r, route: 'template', template: t.id, params: hit.params, via: 'rules' };
  }

  // 2. Low-tier LLM picks a template (never writes SQL)
  let wantsKnowledge = true;
  if (geminiKey()) {
    try {
      const c = await classifyWithLlm(question, names, ref);
      if (c.template === 'briefing') {
        const r = await briefing(scope);
        return { ...r, route: 'query', template: 'briefing', via: 'llm' };
      }
      if (c.spec) {
        const r = await runSpec(c.spec, scope);
        return { ...r, route: 'query', spec: c.spec, via: 'llm' };
      }
      const t = templateById(c.template);
      if (t) {
        const params: Params = {};
        for (const k of t.params) (params as Record<string, unknown>)[k] = c.params[k];
        const r = await t.run(params, scope);
        return { ...r, route: 'template', template: t.id, params, via: 'llm' };
      }
      wantsKnowledge = c.template === 'knowledge' || c.template === 'none';
    } catch {
      /* fall through to knowledge search */
    }
  }

  // 3. Firm knowledge (RAG)
  if (wantsKnowledge) {
    const k = await answerFromKnowledge(question, ref, hinted);
    if (k) return k;
  }
  return { answer: HELP, rows: [], route: 'help', via: 'rules' };
}
