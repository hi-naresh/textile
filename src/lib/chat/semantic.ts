// Semantic query layer for chat: "how many workers do I have?", "who folded how much today?",
// "dispatch by party this month", "efficiency by section this week", …
//
// A question becomes a small spec — { metric, groupBy, filters, period } — chosen from a fixed catalog.
// The server compiles the spec into parameterised SQL. Neither the rules nor the LLM ever write SQL,
// and only catalogued metrics / dimensions / filters exist, so anything else is rejected.
import { query } from '../db';
import { nameKey } from '../normalize';
import type { Scope } from './templates';

// ---------- catalog ----------
export const DIMS = ['worker', 'section', 'quality', 'design', 'party', 'mill', 'lot', 'location', 'day', 'month'] as const;
export type Dim = (typeof DIMS)[number];
export const FILTERS = ['section', 'worker', 'quality', 'party', 'mill', 'lot', 'location'] as const;
export type FilterKey = (typeof FILTERS)[number];

interface MetricDef {
  describe: string; // for the LLM catalog
  title: string; // answer wording: counts → noun ("active workers"), measures → label ("Dispatched")
  unit: 'm' | '%' | 'count' | 'min';
  from: string;
  where?: string;
  agg?: string; // aggregate expression (ignored when ratio is set)
  ratio?: { num: string; den: string }; // percentage metrics
  time?: string; // column the period applies to (none = "as of now")
  dims: Partial<Record<Dim, string>>;
  filters: Partial<Record<FilterKey, string>>;
  list?: string; // expression listing names (for small counts)
  sectionScoped?: string; // supervisor scope: expression holding the section
  allTimeByDefault?: boolean; // no period asked → all time (e.g. "how many parties do we have")
}

const SEC = (col: string) => `lower(btrim(regexp_replace(${col}, '\\s*section\\s*$', '', 'i')))`;
const SECD = (col: string) => `initcap(btrim(regexp_replace(${col}, '\\s*section\\s*$', '', 'i')))`; // for display
const BAL = `(SELECT l.lot_id, l.quality, l.design,
   COALESCE(SUM(CASE WHEN sm.direction = 'IN' THEN sm.meters ELSE -sm.meters END), 0) AS bal,
   (SELECT location FROM lot_locations WHERE lot_id = l.lot_id ORDER BY ts DESC, id DESC LIMIT 1) AS location
 FROM lots l LEFT JOIN stock_movements sm ON sm.lot_id = l.lot_id GROUP BY l.lot_id, l.quality, l.design) b`;
const DAY = (c: string) => `to_char(${c}, 'YYYY-MM-DD')`;
const MONTH = (c: string) => `to_char(${c}, 'YYYY-MM')`;

export const METRICS: Record<string, MetricDef> = {
  workers: {
    title: 'active workers', describe: 'number of active workers', unit: 'count', from: 'workers w', where: 'w.active', agg: 'COUNT(*)',
    dims: { section: SECD('w.section'), worker: 'w.name' }, filters: { section: SEC('w.section'), worker: 'w.name' },
    list: `string_agg(w.name || ' (' || btrim(regexp_replace(w.section, '\\s*section\\s*$', '', 'i')) || ')', ', ' ORDER BY w.name)`,
    sectionScoped: SEC('w.section'),
  },
  supervisors: {
    title: 'supervisors', describe: 'number of active supervisors', unit: 'count', from: 'users u', where: `u.role = 'supervisor' AND u.active`, agg: 'COUNT(*)', dims: {}, filters: {},
    list: `string_agg(u.name || COALESCE(' (' || (SELECT string_agg(s.name, ', ' ORDER BY s.sort_order) FROM supervisor_sections ss JOIN sections s ON s.id = ss.section_id WHERE ss.user_id = u.id AND s.active) || ')', ''), '; ' ORDER BY u.name)`,
  },
  sections: {
    title: 'sections', describe: 'number of sections / processes', unit: 'count', from: 'sections s', where: 's.active', agg: 'COUNT(*)', dims: {}, filters: {},
    list: `string_agg(s.name, ', ' ORDER BY s.sort_order, s.name)`,
  },
  workers_on_duty: {
    title: 'workers with work', describe: 'workers who have work allotted in the period', unit: 'count',
    from: 'allotments a JOIN workers w ON w.id = a.worker_id JOIN job_cards jc ON jc.id = a.job_card_id', agg: 'COUNT(DISTINCT a.worker_id)', time: 'a.date',
    dims: { section: SECD('jc.process') }, filters: { section: SEC('jc.process') },
    list: `string_agg(DISTINCT w.name, ', ')`, sectionScoped: SEC('jc.process'),
  },
  output: {
    title: 'Work done', describe: 'meters completed on closed job cards (folded / dyed / woven / printed / cut)', unit: 'm',
    from: 'job_cards jc JOIN workers w ON w.id = jc.worker_id JOIN lots l ON l.lot_id = jc.lot_id', where: `jc.status = 'closed'`, agg: 'SUM(jc.meters_out)', time: 'jc.ts_closed',
    dims: { worker: 'w.name', section: 'jc.process', quality: 'l.quality', lot: 'jc.lot_id', day: DAY('jc.ts_closed') },
    filters: { section: SEC('jc.process'), worker: 'w.name', quality: 'l.quality', lot: 'jc.lot_id' }, sectionScoped: SEC('jc.process'),
  },
  cards_closed: {
    title: 'job cards completed', describe: 'number of job cards completed', unit: 'count',
    from: 'job_cards jc JOIN workers w ON w.id = jc.worker_id JOIN lots l ON l.lot_id = jc.lot_id', where: `jc.status = 'closed'`, agg: 'COUNT(*)', time: 'jc.ts_closed',
    dims: { worker: 'w.name', section: 'jc.process', quality: 'l.quality', day: DAY('jc.ts_closed') },
    filters: { section: SEC('jc.process'), worker: 'w.name', quality: 'l.quality', lot: 'jc.lot_id' }, sectionScoped: SEC('jc.process'),
  },
  on_floor: {
    title: 'On the floor', describe: 'meters currently on the floor (open job cards)', unit: 'm',
    from: 'job_cards jc JOIN workers w ON w.id = jc.worker_id JOIN lots l ON l.lot_id = jc.lot_id', where: `jc.status <> 'closed'`, agg: 'SUM(jc.meters_in)',
    dims: { worker: 'w.name', section: 'jc.process', quality: 'l.quality', lot: 'jc.lot_id' },
    filters: { section: SEC('jc.process'), worker: 'w.name', quality: 'l.quality', lot: 'jc.lot_id' }, sectionScoped: SEC('jc.process'),
  },
  allotted: {
    title: 'Allotted', describe: 'meters allotted to workers', unit: 'm',
    from: 'allotments a JOIN workers w ON w.id = a.worker_id JOIN job_cards jc ON jc.id = a.job_card_id', agg: 'SUM(a.meters_allotted)', time: 'a.date',
    dims: { worker: 'w.name', section: 'jc.process', day: DAY('a.date') },
    filters: { section: SEC('jc.process'), worker: 'w.name' }, sectionScoped: SEC('jc.process'),
  },
  efficiency: {
    title: 'Efficiency', describe: 'worker efficiency % (done ÷ allotted meters)', unit: '%',
    from: 'efficiency_daily e JOIN workers w ON w.id = e.worker_id', ratio: { num: 'SUM(e.done)', den: 'SUM(e.allotted)' }, time: 'e.date',
    dims: { worker: 'w.name', section: SECD('w.section'), day: DAY('e.date') },
    filters: { section: SEC('w.section'), worker: 'w.name' }, sectionScoped: SEC('w.section'),
  },
  shortage: {
    title: 'Shortage', describe: 'shortage % on completed job cards (meters lost ÷ meters in)', unit: '%',
    from: 'job_cards jc JOIN workers w ON w.id = jc.worker_id JOIN lots l ON l.lot_id = jc.lot_id', where: `jc.status = 'closed'`,
    ratio: { num: 'SUM(jc.shortage)', den: 'SUM(jc.meters_in)' }, time: 'jc.ts_closed',
    dims: { worker: 'w.name', section: 'jc.process', quality: 'l.quality', lot: 'jc.lot_id', day: DAY('jc.ts_closed') },
    filters: { section: SEC('jc.process'), worker: 'w.name', quality: 'l.quality', lot: 'jc.lot_id' }, sectionScoped: SEC('jc.process'),
  },
  idle: {
    title: 'Idle time', describe: 'idle minutes seen on CCTV', unit: 'min',
    from: 'cctv_activity c JOIN workers w ON w.id = c.worker_id', agg: 'SUM(c.idle_min)', time: 'c.ts',
    dims: { worker: 'w.name', section: SECD('w.section') }, filters: { section: SEC('w.section'), worker: 'w.name' }, sectionScoped: SEC('w.section'),
  },
  stock: {
    title: 'Stock', describe: 'meters in stock now', unit: 'm', from: BAL, where: 'b.bal > 0', agg: 'SUM(b.bal)',
    dims: { quality: 'b.quality', design: 'b.design', lot: 'b.lot_id', location: `COALESCE(b.location, '—')` },
    filters: { quality: 'b.quality', lot: 'b.lot_id', location: 'b.location' },
  },
  lots: {
    title: 'lots with stock', describe: 'number of lots with stock', unit: 'count', from: BAL, where: 'b.bal > 0', agg: 'COUNT(*)',
    dims: { quality: 'b.quality', location: `COALESCE(b.location, '—')` }, filters: { quality: 'b.quality', location: 'b.location' },
  },
  received: {
    title: 'Received', describe: 'meters received (incoming challans)', unit: 'm',
    from: 'stock_movements sm JOIN lots l ON l.lot_id = sm.lot_id', where: `sm.direction = 'IN'`, agg: 'SUM(sm.meters)', time: 'sm.ts',
    dims: { mill: `COALESCE(sm.mill_name, '—')`, quality: 'l.quality', lot: 'sm.lot_id', day: DAY('sm.ts'), month: MONTH('sm.ts') },
    filters: { mill: 'sm.mill_name', quality: 'l.quality', lot: 'sm.lot_id' },
  },
  dispatched: {
    title: 'Dispatched', describe: 'meters dispatched (outgoing challans)', unit: 'm',
    from: 'stock_movements sm JOIN lots l ON l.lot_id = sm.lot_id', where: `sm.direction = 'OUT'`, agg: 'SUM(sm.meters)', time: 'sm.ts',
    dims: { party: 'sm.party', quality: 'l.quality', lot: 'sm.lot_id', day: DAY('sm.ts'), month: MONTH('sm.ts') },
    filters: { party: 'sm.party', quality: 'l.quality', lot: 'sm.lot_id' },
  },
  challans: {
    title: 'challans', describe: 'number of challans (incoming + outgoing)', unit: 'count',
    from: 'stock_movements sm JOIN lots l ON l.lot_id = sm.lot_id', agg: 'COUNT(*)', time: 'sm.ts',
    dims: { party: 'sm.party', mill: 'sm.mill_name', quality: 'l.quality', day: DAY('sm.ts') },
    filters: { party: 'sm.party', mill: 'sm.mill_name', quality: 'l.quality', lot: 'sm.lot_id' },
  },
  parties: {
    title: 'parties', describe: 'number of parties (clients) dispatched to', unit: 'count', from: 'stock_movements sm', where: `sm.direction = 'OUT' AND sm.party IS NOT NULL`,
    agg: 'COUNT(DISTINCT sm.party)', time: 'sm.ts', allTimeByDefault: true, dims: {}, filters: {}, list: `string_agg(DISTINCT sm.party, ', ')`,
  },
  mills: {
    title: 'mills', describe: 'number of mills received from', unit: 'count', from: 'stock_movements sm', where: `sm.direction = 'IN' AND sm.mill_name IS NOT NULL`,
    agg: 'COUNT(DISTINCT sm.mill_name)', time: 'sm.ts', allTimeByDefault: true, dims: {}, filters: {}, list: `string_agg(DISTINCT sm.mill_name, ', ')`,
  },
};
export type MetricKey = keyof typeof METRICS;

/** Days back from the database's today (so "today" matches every other today-figure). Inclusive. */
export interface Period { fromBack: number; toBack: number; label: string }
export interface Spec {
  metric: MetricKey;
  groupBy?: Dim | null;
  filters?: Partial<Record<FilterKey, string>>;
  period?: Period | null;
  top?: number | null;
}

// ---------- periods ----------
export function periodFor(kind: 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'days', n = 1): Period {
  switch (kind) {
    case 'today': return { fromBack: 0, toBack: 0, label: 'today' };
    case 'yesterday': return { fromBack: 1, toBack: 1, label: 'yesterday' };
    case 'week': return { fromBack: 6, toBack: 0, label: 'in the last 7 days' };
    case 'month': return { fromBack: 29, toBack: 0, label: 'in the last 30 days' };
    case 'year': return { fromBack: 364, toBack: 0, label: 'in the last 12 months' };
    default: return { fromBack: Math.max(0, n - 1), toBack: 0, label: n === 1 ? 'today' : `in the last ${n} days` };
  }
}

// ---------- compile + run ----------
export interface SemanticResult { answer: string; rows: Record<string, unknown>[] }

/** Validates a spec (from rules or the LLM) against the catalog. Returns null if anything is unknown. */
export function cleanSpec(raw: unknown): Spec | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const metric = String(r.metric ?? '');
  if (!(metric in METRICS)) return null;
  const def = METRICS[metric];
  const groupBy = r.groupBy ?? r.group_by;
  const g = typeof groupBy === 'string' && (DIMS as readonly string[]).includes(groupBy) && def.dims[groupBy as Dim] ? (groupBy as Dim) : null;
  const filters: Partial<Record<FilterKey, string>> = {};
  if (r.filters && typeof r.filters === 'object') {
    for (const [k, v] of Object.entries(r.filters as Record<string, unknown>)) {
      if ((FILTERS as readonly string[]).includes(k) && def.filters[k as FilterKey] && typeof v === 'string' && v.trim()) filters[k as FilterKey] = v.trim().slice(0, 100);
    }
  }
  let period: Period | null = null;
  const p = r.period as Record<string, unknown> | string | undefined;
  if (typeof p === 'string' && ['today', 'yesterday', 'week', 'month', 'year'].includes(p)) period = periodFor(p as 'today');
  else if (p && typeof p === 'object' && typeof p.days === 'number') period = periodFor('days', Math.min(366, Math.max(1, Math.round(p.days))));
  const top = typeof r.top === 'number' ? Math.min(20, Math.max(1, Math.round(r.top))) : null;
  return { metric: metric as MetricKey, groupBy: g, filters, period, top };
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toLocaleString('en-IN', { maximumFractionDigits: 1 });
const unitText = (v: number, u: MetricDef['unit']) => (u === 'm' ? `${fmt(v)} m` : u === '%' ? `${fmt(v)}%` : u === 'min' ? `${fmt(v)} min` : fmt(v));

export async function runSpec(spec: Spec, scope: Scope): Promise<SemanticResult> {
  const def = METRICS[spec.metric];
  const params: unknown[] = [];
  const P = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where: string[] = def.where ? [def.where] : [];
  const period = def.time ? (spec.period ?? (def.allTimeByDefault ? null : periodFor('today'))) : null;
  if (period && def.time) where.push(`${def.time} >= CURRENT_DATE - ${P(period.fromBack)}::int AND ${def.time} < CURRENT_DATE - ${P(period.toBack)}::int + 1`);
  for (const [k, v] of Object.entries(spec.filters ?? {}) as [FilterKey, string][]) {
    const col = def.filters[k];
    if (!col || !v) continue;
    if (k === 'worker') where.push(`lower(${col}) LIKE '%' || lower(${P(v)}) || '%'`);
    else if (k === 'section') where.push(`${col} = lower(btrim(regexp_replace(${P(v)}, '\\s*section\\s*$', '', 'i')))`);
    else where.push(`regexp_replace(lower(${col}), '[^a-z0-9]', '', 'g') = ${P(nameKey(v))}`);
  }
  if (scope.role === 'supervisor' && def.sectionScoped) where.push(`${def.sectionScoped} = ANY(${P(scope.sections)}::text[])`);
  const value = def.ratio ? `ROUND((${def.ratio.num} / NULLIF(${def.ratio.den}, 0) * 100)::numeric, 1)` : `COALESCE(${def.agg}, 0)`;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const scopeNote = scope.role === 'supervisor' && def.sectionScoped ? ' in your sections' : '';
  const when = period ? ` ${period.label}` : '';
  const f = spec.filters ?? {};
  const about = [f.worker, f.quality, f.party ? `to ${f.party}` : '', f.mill ? `from ${f.mill}` : '', f.lot ? `lot ${f.lot}` : '', f.location ? `at ${f.location}` : ''].filter(Boolean).join(', ');
  const isCount = def.unit === 'count';
  // "Folding done", "Dispatched (Georgette)", "active workers in Folding"
  const label = spec.metric === 'output' && f.section ? `${f.section} done` : def.title;
  const measure = `${label}${about ? ` (${about})` : ''}${!isCount || !f.section ? '' : ` in ${f.section}`}`;
  const owned = ['workers', 'supervisors', 'sections', 'lots'].includes(spec.metric) || (!!def.allTimeByDefault && !period);

  if (!spec.groupBy) {
    const r = await query(`SELECT ${value} AS value${def.list ? `, ${def.list} AS names` : ''} FROM ${def.from} ${whereSql}`, params);
    const row = r.rows[0] ?? {};
    const v = row.value == null ? null : Number(row.value);
    if (v == null) return { answer: `No ${isCount ? measure : measure.toLowerCase()} data${when}.`, rows: [] };
    const names = typeof row.names === 'string' && v > 0 && v <= 15 ? `: ${row.names}` : '';
    const m1 = v === 1 ? measure.replace(/\b(workers|supervisors|sections|lots|cards|challans|mills)\b/, (w) => w.slice(0, -1)).replace(/\bparties\b/, 'party') : measure;
    const answer = isCount
      ? owned
        ? `You have ${fmt(v)} ${m1}${scopeNote}${names}.`
        : `${fmt(v)} ${m1}${when}${scopeNote}${names}.`
      : `${cap(measure)}${when}${scopeNote}: ${unitText(v, def.unit)}.`;
    return { answer, rows: [{ value: v, ...(row.names ? { names: row.names } : {}) }] };
  }

  const dimExpr = def.dims[spec.groupBy]!;
  const top = spec.top ?? 10;
  const order = spec.groupBy === 'day' || spec.groupBy === 'month' ? 'label' : 'value DESC NULLS LAST';
  const r = await query(
    `SELECT ${dimExpr} AS label, ${value} AS value FROM ${def.from} ${whereSql} GROUP BY 1 ORDER BY ${order} LIMIT ${top + 1}`,
    params,
  );
  const rows = r.rows.map((x) => ({ [spec.groupBy!]: x.label ?? '—', value: x.value == null ? null : Number(x.value) }));
  if (!rows.length) return { answer: `No ${isCount ? measure : measure.toLowerCase()}${when}${scopeNote}.`, rows: [] };
  const shown = rows.slice(0, top);
  const parts = shown.map((x) => `${x[spec.groupBy!]} ${x.value == null ? '—' : unitText(x.value, def.unit)}`);
  const total = def.unit === 'm' || def.unit === 'count' || def.unit === 'min' ? shown.reduce((s, x) => s + (x.value ?? 0), 0) : null;
  const head = isCount ? `${cap(measure)}${when}${scopeNote}, by ${spec.groupBy}` : `${cap(measure)}${when}${scopeNote}, by ${spec.groupBy}`;
  const totalText = total != null && shown.length > 1 ? ` Total ${unitText(total, def.unit)}${rows.length > top ? ` for the top ${top}` : ''}.` : '';
  return { answer: `${head}: ${parts.join(', ')}.${totalText}`, rows: shown };
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- deterministic parser (no AI) ----------
export interface Vocab { sections: string[]; workers: string[]; parties: string[]; mills: string[]; qualities: string[]; lots: string[]; locations: string[] }

function sectionStem(name: string) {
  let s = name.toLowerCase().replace(/\s*section\s*$/, '').trim();
  s = s.replace(/ing$/, '');
  if (/(.)\1$/.test(s)) s = s.slice(0, -1); // cutt → cut
  return s;
}
function findIn(qKey: string, names: string[]): string | null {
  let best: string | null = null;
  for (const n of names) {
    const k = nameKey(n);
    if (k.length >= 3 && qKey.includes(k) && (!best || k.length > nameKey(best).length)) best = n;
  }
  return best;
}

export function parsePeriod(q: string): Period | null {
  const n = q.match(/(?:last|past|pichhle|pichle)\s+(\d{1,3})\s*(?:days?|din)/);
  if (n) return periodFor('days', parseInt(n[1], 10));
  if (/\b(today|aaj|aje|aaje|so far)\b/.test(q)) return periodFor('today');
  if (/\b(yesterday|gaikale)\b/.test(q)) return periodFor('yesterday');
  if (/\b(week|weekly|hafte|hafta|athvadi\w*)\b/.test(q)) return periodFor('week');
  if (/\b(month|monthly|mahine|mahina)\b/.test(q)) return periodFor('month');
  if (/\b(year|yearly|saal)\b/.test(q)) return periodFor('year');
  return null;
}

const GROUP_WORDS: [RegExp, Dim][] = [
  [/\b(workers?|karigar|kaarigar|employees?|operators?|who|whom|kaun|kon)\b/, 'worker'],
  [/\b(sections?|process(es)?|departments?|units?)\b/, 'section'],
  [/\b(qualit(y|ies)|fabrics?)\b/, 'quality'],
  [/\b(part(y|ies)|clients?|customers?|buyers?)\b/, 'party'],
  [/\b(mills?|suppliers?)\b/, 'mill'],
  [/\b(lots?)\b/, 'lot'],
  [/\b(locations?|godowns?|places?)\b/, 'location'],
  [/\b(daily|day ?wise|each day|per day|by day)\b/, 'day'],
  [/\b(monthly|month ?wise|each month|per month|by month)\b/, 'month'],
];

/** Reads a question into a spec using keywords + the firm's own names. Returns null when unsure. */
export function parseSemantic(question: string, v: Vocab): Spec | null {
  const q = question.toLowerCase();
  const qKey = nameKey(question);
  const filters: Partial<Record<FilterKey, string>> = {};

  // Sections by name or by verb ("folded" → Folding, "dyed" → Dyeing)
  for (const s of v.sections) {
    const stem = sectionStem(s);
    if (stem.length >= 3 && new RegExp(`\\b${stem}`, 'i').test(q)) { filters.section = s; break; }
  }
  const worker = v.workers.find((w) => q.includes(w.toLowerCase()) || new RegExp(`\\b${w.toLowerCase().split(/\s+/)[0]}\\b`).test(q));
  if (worker) filters.worker = worker;
  const party = findIn(qKey, v.parties); if (party) filters.party = party;
  const mill = findIn(qKey, v.mills); if (mill) filters.mill = mill;
  const quality = findIn(qKey, v.qualities); if (quality) filters.quality = quality;
  const location = v.locations.find((l) => new RegExp(`\\b${l.toLowerCase()}\\b`).test(q)); if (location && location.toLowerCase() !== 'floor') filters.location = location;
  const tokens = question.toUpperCase().split(/[^A-Z0-9/-]+/);
  const lot = v.lots.find((l) => tokens.includes(l.toUpperCase())); if (lot) filters.lot = lot;

  const period = parsePeriod(q);
  const howMany = /\b(how many|number of|count|kitne|kitna|ketla|ketlu|total)\b/.test(q);
  const outputWord = /\b(fold\w*|output|produc\w*|made|complet\w*|finish\w*|done|dyed|woven|printed|cut)\b/.test(q) || (!!filters.section && /\b(how much|meters?|kitna|ketlu|kaam|work)\b/.test(q));

  // Group by: explicit words ("by party", "which workers", "who", "worker-wise")
  let groupBy: Dim | null = null;
  const groupCue = /\b(by|per|each|every|which|who|kaun|kon|top|wise|breakdown|split|list)\b/.test(q) || /-wise|\bwise\b/.test(q);

  let metric: MetricKey | null = null;
  if (/\bsupervisors?\b/.test(q)) metric = 'supervisors';
  else if (outputWord) metric = /\b(cards?)\b/.test(q) && howMany ? 'cards_closed' : 'output';
  else if (/\ballot\w*/.test(q)) metric = 'allotted';
  else if (/\b(efficien\w*|performance|productivity)\b/.test(q)) metric = 'efficiency';
  else if (/\b(idle|cctv|camera)\b/.test(q)) metric = 'idle';
  else if (/\bshortage\b/.test(q) && (groupCue || /%|percent/.test(q))) metric = 'shortage';
  else if (/\b(on the floor|on floor|in process|being worked)\b/.test(q) && (groupCue || howMany)) metric = 'on_floor';
  else if (/\b(workers?|karigar|kaarigar|employees?|staff|operators?)\b/.test(q) && /\b(working|on duty|present|allotted)\b/.test(q)) metric = 'workers_on_duty';
  else if (/\b(workers?|karigar|kaarigar|employees?|staff|operators?|people)\b/.test(q) && (howMany || /\b(list|who are|names?)\b/.test(q))) metric = 'workers';
  else if (/\bsections?\b/.test(q) && (howMany || /\b(list|which|names?)\b/.test(q))) metric = 'sections';
  else if (/\b(parties|clients|customers|buyers)\b/.test(q) && howMany) metric = 'parties';
  else if (/\b(mills|suppliers)\b/.test(q) && howMany) metric = 'mills';
  else if (/\blots\b/.test(q) && howMany) metric = 'lots';
  else if (/\bchallans?\b/.test(q) && howMany) metric = 'challans';
  else if (groupCue || Object.keys(filters).length) {
    // Flow questions with a breakdown or a filter (simple ones are answered by the fixed templates)
    if (/\b(dispatch\w*|sent|sold|outgoing|out)\b/.test(q)) metric = 'dispatched';
    else if (/\b(receiv\w*|incoming|inward|arrived)\b/.test(q)) metric = 'received';
    else if (/\b(stock|balance|inventory)\b/.test(q)) metric = 'stock';
  }
  if (!metric) return null;

  const def = METRICS[metric];
  if (groupCue || metric === 'output') {
    for (const [re, d] of GROUP_WORDS) {
      // "workers" is the thing being counted in "how many workers", not a breakdown
      if (d === 'worker' && (metric === 'workers' || metric === 'workers_on_duty')) continue;
      if (d === 'section' && metric === 'sections') continue;
      if (re.test(q) && def.dims[d]) { groupBy = d; break; }
    }
  }
  // "how many workers per section" / "workers in each section"
  if ((metric === 'workers' || metric === 'workers_on_duty') && /\b(each|per|by|every|wise)\b/.test(q) && /\bsections?\b/.test(q)) groupBy = 'section';
  // Output without an explicit breakdown: by worker when a section is named ("who folded how much"), else by section
  if (metric === 'output' && !groupBy && !filters.worker) groupBy = filters.section ? 'worker' : 'section';
  // Don't group by the dimension we filter on
  if (groupBy && groupBy in filters) groupBy = null;
  const top = q.match(/\btop\s+(\d{1,2})\b/)?.[1];

  const dropUnknown: Partial<Record<FilterKey, string>> = {};
  for (const [k, val] of Object.entries(filters) as [FilterKey, string][]) if (def.filters[k]) dropUnknown[k] = val;
  const periodFinal = period ?? (def.time && (dropUnknown.party || dropUnknown.mill || dropUnknown.quality || dropUnknown.lot) ? periodFor('month') : null);
  return { metric, groupBy, filters: dropUnknown, period: periodFinal, top: top ? parseInt(top, 10) : null };
}

/** Catalog text for the LLM classifier. */
export function catalogForLlm(): string {
  const m = Object.entries(METRICS)
    .map(([k, d]) => `- ${k}: ${d.describe}; group_by: ${Object.keys(d.dims).join('/') || 'none'}; filters: ${Object.keys(d.filters).join('/') || 'none'}${d.time ? '; has period' : ''}`)
    .join('\n');
  return `${m}\nperiod: "today" | "yesterday" | "week" | "month" | "year" | {"days": N}`;
}

// ---------- "what's happening?" ----------
export async function briefing(scope: Scope): Promise<SemanticResult> {
  const sec = scope.role === 'supervisor' ? scope.sections : null;
  const r = await query(
    `SELECT
       (SELECT COALESCE(SUM(meters), 0) FROM stock_movements WHERE direction = 'OUT' AND ts::date = CURRENT_DATE) AS out_today,
       (SELECT COUNT(*) FROM stock_movements WHERE direction = 'OUT' AND ts::date = CURRENT_DATE) AS out_n,
       (SELECT COALESCE(SUM(meters), 0) FROM stock_movements WHERE direction = 'IN' AND ts::date = CURRENT_DATE) AS in_today,
       (SELECT COALESCE(SUM(meters_out), 0) FROM job_cards WHERE status = 'closed' AND ts_closed::date = CURRENT_DATE
          AND ($1::text[] IS NULL OR ${SEC('process')} = ANY($1::text[]))) AS done_today,
       (SELECT COUNT(*) FROM job_cards WHERE status <> 'closed' AND ($1::text[] IS NULL OR ${SEC('process')} = ANY($1::text[]))) AS open_cards,
       (SELECT COALESCE(SUM(meters_in), 0) FROM job_cards WHERE status <> 'closed' AND ($1::text[] IS NULL OR ${SEC('process')} = ANY($1::text[]))) AS on_floor,
       (SELECT COUNT(DISTINCT worker_id) FROM allotments WHERE date = CURRENT_DATE) AS workers_today,
       (SELECT COUNT(*) FROM capture_events WHERE status = 'pending') AS pending`,
    [sec],
  );
  const x = r.rows[0];
  const n = (k: string) => Number(x[k] ?? 0);
  const parts = [
    `On the floor: ${fmt(n('on_floor'))} m on ${n('open_cards')} open card${n('open_cards') === 1 ? '' : 's'}`,
    `completed today: ${fmt(n('done_today'))} m`,
    scope.role === 'owner' ? `dispatched today: ${fmt(n('out_today'))} m on ${n('out_n')} challan${n('out_n') === 1 ? '' : 's'}` : '',
    scope.role === 'owner' ? `received today: ${fmt(n('in_today'))} m` : '',
    `${n('workers_today')} worker${n('workers_today') === 1 ? '' : 's'} with work today`,
    n('pending') ? `${n('pending')} photo read${n('pending') === 1 ? '' : 's'} waiting for review` : '',
  ].filter(Boolean);
  return { answer: `${parts.join('; ')}.`, rows: [x] };
}
