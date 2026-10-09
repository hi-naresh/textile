// Fixed, parameterised queries for chat. The LLM never writes SQL: it (optionally) picks one of
// these templates and fills its parameters; the values are validated and passed as $1, $2 … only.
import { query } from '../db';
import { readRules } from '../settings';
import { can } from '../access';

const canManage = (s: Scope) => can(s.role, 'jobs.manage');

export interface Scope {
  role: 'owner' | 'supervisor';
  sections: string[]; // supervisor's sections (lower-case match keys)
  userId?: string;
}

export interface TemplateResult {
  answer: string;
  rows: Record<string, unknown>[];
}

export interface Params {
  lot?: string | null;
  party?: string | null;
  mill?: string | null;
  worker?: string | null;
  challan?: string | null;
  quality?: string | null;
  days?: number | null;
}

export interface Template {
  id: string;
  describe: string; // shown to the intent LLM
  params: (keyof Params)[];
  run: (p: Params, s: Scope) => Promise<TemplateResult>;
}

const m = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100;
const fmt = (n: unknown) => m(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const daysOr = (d: number | null | undefined, def: number | null) => (d && d > 0 && d <= 366 ? Math.round(d) : def);
const period = (d: number | null) => (d === null ? 'across all recorded dates' : d === 1 ? 'today' : d === 7 ? 'in the last 7 days' : `in the last ${d} days`);
const sectionFilter = (s: Scope, col: string, idx: number) =>
  s.role === 'supervisor' ? ` AND lower(regexp_replace(${col}, '\\s*section\\s*$', '', 'i')) = ANY($${idx}::text[])` : '';

export const TEMPLATES: Template[] = [
  {
    id: 'lot_status',
    describe: 'Stock balance, location, quality and open job cards of one lot',
    params: ['lot'],
    run: async (p) => {
      if (!p.lot) return { answer: 'Which lot? For example: "status of lot 257A".', rows: [] };
      const r = await query(
        `SELECT l.lot_id, l.quality, l.design,
                COALESCE((SELECT SUM(CASE WHEN direction = 'IN' THEN meters ELSE -meters END) FROM stock_movements WHERE lot_id = l.lot_id), 0) AS balance_m,
                (SELECT location FROM lot_locations WHERE lot_id = l.lot_id ORDER BY ts DESC, id DESC LIMIT 1) AS location,
                (SELECT COUNT(*) FROM job_cards WHERE lot_id = l.lot_id AND status <> 'closed') AS open_cards
         FROM lots l WHERE l.lot_id = $1`,
        [p.lot],
      );
      const x = r.rows[0];
      if (!x) return { answer: `No lot ${p.lot} found.`, rows: [] };
      return {
        answer: `Lot ${x.lot_id} (${x.quality}${x.design && !/unknown/i.test(x.design) ? `, ${x.design}` : ''}): ${fmt(x.balance_m)} m in stock, at ${x.location ?? 'no location yet'}${Number(x.open_cards) ? `, ${x.open_cards} job card${Number(x.open_cards) === 1 ? '' : 's'} open` : ''}.`,
        rows: r.rows,
      };
    },
  },
  {
    id: 'stock_summary',
    describe: 'Total stock in meters across all lots, split by location',
    params: [],
    run: async () => {
      const r = await query(
        `WITH b AS (
           SELECT l.lot_id, COALESCE(SUM(CASE WHEN sm.direction = 'IN' THEN sm.meters ELSE -sm.meters END), 0) AS bal,
                  (SELECT location FROM lot_locations WHERE lot_id = l.lot_id ORDER BY ts DESC, id DESC LIMIT 1) AS loc
           FROM lots l LEFT JOIN stock_movements sm ON sm.lot_id = l.lot_id GROUP BY l.lot_id)
         SELECT COALESCE(loc, '—') AS location, COUNT(*) AS lots, SUM(bal) AS meters FROM b WHERE bal > 0 GROUP BY 1 ORDER BY meters DESC`,
      );
      const total = r.rows.reduce((s, x) => s + Number(x.meters), 0);
      const lots = r.rows.reduce((s, x) => s + Number(x.lots), 0);
      if (!lots) return { answer: 'No stock on hand right now.', rows: [] };
      return { answer: `${fmt(total)} m in stock across ${lots} lots: ${r.rows.map((x) => `${x.location} ${fmt(x.meters)} m`).join(', ')}.`, rows: r.rows };
    },
  },
  {
    id: 'stock_by_quality',
    describe: 'Stock in meters by fabric quality (optionally one quality)',
    params: ['quality'],
    run: async (p) => {
      const r = await query(
        `SELECT l.quality, SUM(CASE WHEN sm.direction = 'IN' THEN sm.meters ELSE -sm.meters END) AS meters, COUNT(DISTINCT l.lot_id) AS lots
         FROM lots l JOIN stock_movements sm ON sm.lot_id = l.lot_id
         WHERE ($1::text IS NULL OR lower(l.quality) LIKE '%' || lower($1) || '%')
         GROUP BY l.quality HAVING SUM(CASE WHEN sm.direction = 'IN' THEN sm.meters ELSE -sm.meters END) > 0 ORDER BY meters DESC LIMIT 20`,
        [p.quality ?? null],
      );
      if (!r.rowCount) return { answer: p.quality ? `No stock of ${p.quality}.` : 'No stock on hand.', rows: [] };
      return { answer: r.rows.slice(0, 6).map((x) => `${x.quality}: ${fmt(x.meters)} m (${x.lots} lots)`).join('; ') + '.', rows: r.rows };
    },
  },
  {
    id: 'dispatch_by_party',
    describe: 'Meters dispatched (outgoing) per party / client, optionally one party, over N days',
    params: ['party', 'days'],
    run: async (p) => {
      const d = daysOr(p.days, null);
      const r = await query(
        `SELECT party, SUM(meters) AS meters, COUNT(*) AS challans FROM stock_movements
         WHERE direction = 'OUT' AND ($1::int IS NULL OR ts >= CURRENT_DATE - ($1::int - 1))
           AND ($2::text IS NULL OR regexp_replace(lower(party), '[^a-z0-9]', '', 'g') = regexp_replace(lower($2), '[^a-z0-9]', '', 'g'))
         GROUP BY party ORDER BY meters DESC LIMIT 20`,
        [d, p.party ?? null],
      );
      if (!r.rowCount) return { answer: `No dispatches${p.party ? ` to ${p.party}` : ''} ${period(d)}.`, rows: [] };
      const total = r.rows.reduce((s, x) => s + Number(x.meters), 0);
      return { answer: `${fmt(total)} m dispatched ${period(d)}${p.party ? ` to ${r.rows[0].party}` : `: ${r.rows.slice(0, 5).map((x) => `${x.party} ${fmt(x.meters)} m`).join(', ')}`}.`, rows: r.rows };
    },
  },
  {
    id: 'receipts_by_mill',
    describe: 'Incoming grey and finished meters per mill, optionally one mill, over N days',
    params: ['mill', 'days'],
    run: async (p) => {
      const d = daysOr(p.days, null);
      const r = await query(
        `SELECT COALESCE(mill_name, '—') AS mill, SUM(grey_meters) AS grey_m, SUM(finished_meters) AS finished_m, SUM(meters) AS stock_m, COUNT(*) AS challans
         FROM stock_movements
         WHERE direction = 'IN' AND ($1::int IS NULL OR ts >= CURRENT_DATE - ($1::int - 1))
           AND ($2::text IS NULL OR regexp_replace(lower(mill_name), '[^a-z0-9]', '', 'g') = regexp_replace(lower($2), '[^a-z0-9]', '', 'g'))
         GROUP BY 1 ORDER BY stock_m DESC LIMIT 20`,
        [d, p.mill ?? null],
      );
      if (!r.rowCount) return { answer: `Nothing received${p.mill ? ` from ${p.mill}` : ''} ${period(d)}.`, rows: [] };
      return { answer: `Received ${period(d)}: ${r.rows.slice(0, 5).map((x) => `${x.mill} ${fmt(x.stock_m)} m (${x.challans} challan${Number(x.challans) === 1 ? '' : 's'})`).join(', ')}.`, rows: r.rows };
    },
  },
  {
    id: 'challan_lookup',
    describe: 'Find a challan by its number',
    params: ['challan'],
    run: async (p) => {
      if (!p.challan) return { answer: 'Which challan number?', rows: [] };
      const r = await query(
        `SELECT direction, lot_id, meters, grey_meters, finished_meters, mill_name, party, source_doc_id AS challan, ts::date AS date
         FROM stock_movements WHERE upper(source_doc_id) = upper($1) ORDER BY ts DESC LIMIT 10`,
        [p.challan],
      );
      if (!r.rowCount) return { answer: `No challan ${p.challan} found.`, rows: [] };
      const x = r.rows[0];
      return { answer: `Challan ${x.challan}: ${x.direction === 'IN' ? `received ${fmt(x.meters)} m of lot ${x.lot_id}${x.mill_name ? ` from ${x.mill_name}` : ''}` : `dispatched ${fmt(x.meters)} m of lot ${x.lot_id} to ${x.party}`} on ${new Date(x.date).toLocaleDateString('en-IN')}.`, rows: r.rows };
    },
  },
  {
    id: 'shortage_report',
    describe: 'Closed job cards whose shortage is above the firm limit, over N days',
    params: ['days'],
    run: async (p, s) => {
      const d = daysOr(p.days, null);
      const { shortageLimitPct } = await readRules();
      const r = await query(
        `SELECT jc.id AS job_card, jc.lot_id, jc.process, w.name AS worker, jc.meters_in, jc.meters_out,
                ROUND((jc.shortage / NULLIF(jc.meters_in, 0) * 100)::numeric, 2) AS shortage_pct
         FROM job_cards jc JOIN workers w ON w.id = jc.worker_id
         WHERE jc.status = 'closed' AND ($1::int IS NULL OR jc.ts_closed >= CURRENT_DATE - ($1::int - 1))
           AND jc.shortage / NULLIF(jc.meters_in, 0) * 100 > $2 ${sectionFilter(s, 'jc.process', 3)}
         ORDER BY shortage_pct DESC LIMIT 20`,
        s.role === 'supervisor' ? [d, shortageLimitPct, s.sections] : [d, shortageLimitPct],
      );
      if (!r.rowCount) return { answer: `No job cards above the ${shortageLimitPct}% shortage limit ${period(d)}.`, rows: [] };
      return { answer: `${r.rowCount} job card${r.rowCount === 1 ? '' : 's'} above the ${shortageLimitPct}% limit ${period(d)}. Worst: JC-${r.rows[0].job_card} (lot ${r.rows[0].lot_id}, ${r.rows[0].worker}) at ${r.rows[0].shortage_pct}%.`, rows: r.rows };
    },
  },
  {
    id: 'open_job_cards',
    describe: 'Job cards still open / in process',
    params: [],
    run: async (_p, s) => {
      const r = await query(
        `SELECT jc.id AS job_card, jc.lot_id, jc.process, COALESCE(w.name, 'Unassigned') AS worker, jc.meters_in, jc.ts_created::date AS since,
                GREATEST(0, CURRENT_DATE - jc.ts_created::date) AS days_open,
                COUNT(*) OVER () AS total_cards, SUM(jc.meters_in) OVER () AS total_meters
         FROM job_cards jc LEFT JOIN workers w ON w.id = jc.worker_id
         WHERE jc.status <> 'closed' ${sectionFilter(s, 'jc.process', 1)}
         ORDER BY jc.ts_created LIMIT 30`,
        s.role === 'supervisor' ? [s.sections] : [],
      );
      if (!r.rowCount) return { answer: 'No open job cards.', rows: [] };
      const total = Number(r.rows[0].total_cards);
      const items = r.rows.slice(0, 8).map((x) => `- **JC-${x.job_card}** · lot ${x.lot_id} · ${x.worker} · ${x.process} · ${fmt(x.meters_in)} m · open ${x.days_open} day${Number(x.days_open) === 1 ? '' : 's'}${Number(x.days_open) >= 7 ? ' — check progress (open 7+ days)' : ''}`).join('\n');
      return { answer: `**${total} open job card${total === 1 ? '' : 's'}**, ${fmt(r.rows[0].total_meters)} m on the floor.\n\n${items}${total > 8 ? `\n\nShowing the oldest ${Math.min(8, total)} of ${total}.` : ''}\n\n${canManage(s) ? 'For completed work, open [Job cards](#app=jobs) → Close, enter actual Meters out, then Close card. For unfinished work, check with the assigned worker.' : 'Check progress with the assigned worker; ask someone with job-card management access to close completed work.'} Cards have no recorded due date; age alone does not mean overdue.`, rows: r.rows };
    },
  },
  {
    id: 'worker_efficiency',
    describe: 'Worker efficiency (done vs allotted meters), optionally one worker, over N days',
    params: ['worker', 'days'],
    run: async (p, s) => {
      const d = daysOr(p.days, null);
      const args: unknown[] = [d, p.worker ?? null];
      if (s.role === 'supervisor') args.push(s.sections);
      const r = await query(
        `SELECT w.name AS worker, w.section, SUM(e.allotted) AS allotted_m, SUM(e.done) AS done_m,
                ROUND((SUM(e.done) / NULLIF(SUM(e.allotted), 0) * 100)::numeric, 1) AS efficiency_pct
         FROM efficiency_daily e JOIN workers w ON w.id = e.worker_id
         WHERE ($1::int IS NULL OR e.date >= CURRENT_DATE - ($1::int - 1)) AND ($2::text IS NULL OR lower(w.name) LIKE '%' || lower($2) || '%')
           ${sectionFilter(s, 'w.section', 3)}
         GROUP BY w.name, w.section ORDER BY efficiency_pct ASC NULLS LAST LIMIT 20`,
        args,
      );
      if (!r.rowCount) return { answer: `No efficiency records ${period(d)}${p.worker ? ` for ${p.worker}` : ''}.`, rows: [] };
      const low = r.rows[0];
      return { answer: p.worker ? `${low.worker}: ${low.efficiency_pct}% (${fmt(low.done_m)} of ${fmt(low.allotted_m)} m) ${period(d)}.` : `Lowest ${period(d)}: ${r.rows.slice(0, 3).map((x) => `${x.worker} ${x.efficiency_pct}%`).join(', ')}.`, rows: r.rows };
    },
  },
  {
    id: 'pending_reviews',
    describe: 'Photo reads waiting for review',
    params: [],
    run: async (_p, s) => {
      const r = await query(`SELECT id, type, confidence, ts FROM capture_events WHERE status = 'pending'
        AND ($1::text IS NULL OR captured_by = $1 OR (type = 'job_card_folding' AND 'folding' = ANY($2::text[])))
        ORDER BY ts LIMIT 20`, [s.role === 'supervisor' ? (s.userId ?? '') : null, s.sections]);
      return { answer: r.rowCount ? `${r.rowCount} photo read${r.rowCount === 1 ? '' : 's'} waiting for review. Open [Review queue](#app=review), check the photo and correct or confirm the read.` : 'Nothing waiting for review.', rows: r.rows };
    },
  },
  {
    id: 'time_saved',
    describe: 'Time saved by photo capture compared with manual entry, over N days',
    params: ['days'],
    run: async (p) => {
      const { timeSaved } = await import('../value');
      if (!p.days) return { answer: 'Which period should I use for time saved?', rows: [] };
      const d = daysOr(p.days, 30)!;
      const t = await timeSaved(d);
      const saved = t.savedMin >= 60 ? `${fmt(t.savedMin / 60)} hours` : `${Math.round(t.savedMin)} minutes`;
      return { answer: `${period(d)[0].toUpperCase()}${period(d).slice(1)}: ${t.captures} photo read${t.captures === 1 ? '' : 's'} saved about ${saved} compared with entering them by hand.`, rows: [t as unknown as Record<string, unknown>] };
    },
  },
];

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id) ?? null;
