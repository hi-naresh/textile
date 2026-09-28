// Analytics & Reporting: one structured report for a day, week or month, built from fixed queries.
// Money (₹) and AI cost are added for the owner only — supervisors get meters, workers get nothing.
// The narrative is deterministic; polishNarrative() may reword it on the low AI tier (optional).
import type { Q } from '../db';
import type { Role } from '../access';
import { LedgerError } from '../ledger-error';
import { dbToday, rangeFor, type Range, type ReportPeriod } from './dates';
import { inventorySnapshot } from './inventory';

export interface Named { name: string; meters: number; count: number }
export interface KpiChange {
  key: string;
  label: string;
  unit: 'm' | '%' | 'count' | 'inr' | 'usd' | 'min';
  value: number | null;
  prev: number | null;
  changePct: number | null; // % change vs previous period; null when there is nothing to compare
  upIsGood: boolean;
  ownerOnly?: boolean;
}

export interface Report {
  period: ReportPeriod;
  label: string;
  rangeText: string;
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  prevLabel: string;
  partial: boolean;
  role: Role;
  generatedAt: string;
  kpis: KpiChange[];
  stock: { opening: number; in: number; out: number; closing: number; inChallans: number; outChallans: number };
  dispatch: { total: number; challans: number; parties: number; byParty: Named[]; byQuality: Named[] };
  receipts: { total: number; challans: number; byMill: (Named & { lossPct: number | null })[] };
  production: {
    total: number; cards: number; shortagePct: number | null; limitPct: number;
    bySection: (Named & { shortagePct: number | null })[];
    byWorker: (Named & { section: string })[];
    flagged: { id: number; lot_id: string; process: string; worker: string; meters_in: number; shortagePct: number }[];
  };
  efficiency: { pct: number | null; targetPct: number; belowTarget: number; workers: number; bySection: { name: string; pct: number | null }[] };
  orders: { hasData: boolean; created: number; createdM: number; dispatchedM: number; completed: number; overdue: number; overdueM: number; open: number; openM: number };
  inquiries: { hasData: boolean; created: number; quoted: number; won: number; lost: number };
  money?: { hasData: boolean; invoiced: number; invoices: number; collected: number; payments: number; outstanding: number; overdue: number; topOutstanding: { name: string; amount: number; overdue: number }[] };
  ai?: { calls: number; failed: number; costUsd: number; byFeature: { feature: string; calls: number; costUsd: number }[] };
  timeSaved: { captures: number; savedMin: number; manualMin: number; actualMin: number };
  inventory: { included: boolean; short: string[]; low: string[]; ageingLots: number; ageingM: number };
  narrative: string[];
  narrativeSource: 'rules' | 'ai';
}

const n = (v: unknown) => (v == null ? 0 : Number(v));
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const pctOrNull = (num: number, den: number) => (den > 0 ? r1((num / den) * 100) : null);

/** Headline numbers for a date range (run for this period and the previous one). */
async function core(q: Q, from: string, to: string, owner: boolean) {
  const r = await q(
    `SELECT
       (SELECT COALESCE(SUM(meters), 0) FROM stock_movements WHERE direction = 'OUT' AND ts >= $1::date AND ts < $2::date + 1) AS out_m,
       (SELECT COUNT(*) FROM stock_movements WHERE direction = 'OUT' AND ts >= $1::date AND ts < $2::date + 1) AS out_n,
       (SELECT COALESCE(SUM(meters), 0) FROM stock_movements WHERE direction = 'IN' AND ts >= $1::date AND ts < $2::date + 1) AS in_m,
       (SELECT COUNT(*) FROM stock_movements WHERE direction = 'IN' AND ts >= $1::date AND ts < $2::date + 1) AS in_n,
       (SELECT COALESCE(SUM(meters_out), 0) FROM job_cards WHERE status = 'closed' AND ts_closed >= $1::date AND ts_closed < $2::date + 1) AS prod_m,
       (SELECT COUNT(*) FROM job_cards WHERE status = 'closed' AND ts_closed >= $1::date AND ts_closed < $2::date + 1) AS prod_n,
       (SELECT COALESCE(SUM(shortage), 0) FROM job_cards WHERE status = 'closed' AND ts_closed >= $1::date AND ts_closed < $2::date + 1) AS short_m,
       (SELECT COALESCE(SUM(meters_in), 0) FROM job_cards WHERE status = 'closed' AND ts_closed >= $1::date AND ts_closed < $2::date + 1) AS prod_in,
       (SELECT COALESCE(SUM(done), 0) FROM efficiency_daily WHERE date BETWEEN $1::date AND $2::date) AS eff_done,
       (SELECT COALESCE(SUM(allotted), 0) FROM efficiency_daily WHERE date BETWEEN $1::date AND $2::date) AS eff_allot,
       (SELECT COUNT(*) FROM orders WHERE status <> 'cancelled' AND created_at >= $1::date AND created_at < $2::date + 1) AS orders_n,
       (SELECT COUNT(*) FROM inquiries WHERE created_at >= $1::date AND created_at < $2::date + 1) AS inq_n`,
    [from, to],
  );
  const x = r.rows[0];
  const base = {
    out: n(x.out_m), outN: n(x.out_n), in: n(x.in_m), inN: n(x.in_n), prod: n(x.prod_m), prodN: n(x.prod_n),
    shortagePct: pctOrNull(n(x.short_m), n(x.prod_in)), effPct: pctOrNull(n(x.eff_done), n(x.eff_allot)),
    orders: n(x.orders_n), inquiries: n(x.inq_n), invoiced: null as number | null, collected: null as number | null, aiUsd: null as number | null,
  };
  if (owner) {
    const m = await q(
      `SELECT (SELECT COALESCE(SUM(total), 0) FROM invoices WHERE status <> 'cancelled' AND invoice_date BETWEEN $1::date AND $2::date) AS inv,
              (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE paid_on BETWEEN $1::date AND $2::date) AS paid,
              (SELECT COALESCE(SUM(cost_usd), 0) FROM llm_usage WHERE ts >= $1::date AND ts < $2::date + 1) AS ai`,
      [from, to],
    );
    base.invoiced = n(m.rows[0].inv); base.collected = n(m.rows[0].paid); base.aiUsd = Math.round(n(m.rows[0].ai) * 10000) / 10000;
  }
  return base;
}

function change(value: number | null, prev: number | null, unit: KpiChange['unit']): number | null {
  if (value == null || prev == null) return null;
  if (unit === '%') return r1(value - prev); // points, not % of a %
  if (prev === 0) return null;
  return r1(((value - prev) / Math.abs(prev)) * 100);
}

export interface BuildOptions { today?: string }

export async function buildReport(q: Q, period: ReportPeriod, role: Role, endDate?: string | null, opts: BuildOptions = {}): Promise<Report> {
  if (role === 'worker') throw new LedgerError('You are not allowed to see reports.', 403);
  const owner = role === 'owner';
  const today = opts.today ?? (await dbToday(q));
  const rg: Range = rangeFor(period, endDate || today, today);
  const P = [rg.from, rg.to];

  const settings = await q(`SELECT shortage_limit_pct, efficiency_target_pct FROM app_settings WHERE id = 1`);
  const limitPct = n(settings.rows[0]?.shortage_limit_pct ?? 3);
  const targetPct = n(settings.rows[0]?.efficiency_target_pct ?? 85);

  const cur = await core(q, rg.from, rg.to, owner);
  const prev = await core(q, rg.prevFrom, rg.prevTo, owner);

  // ---- stock ----
  const opening = await q(`SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN meters ELSE -meters END), 0) AS b FROM stock_movements WHERE ts < $1::date`, [rg.from]);
  const open = n(opening.rows[0].b);
  const stock = { opening: r2(open), in: r2(cur.in), out: r2(cur.out), closing: r2(open + cur.in - cur.out), inChallans: cur.inN, outChallans: cur.outN };

  // ---- dispatch ----
  const byParty = await q(
    `SELECT COALESCE(NULLIF(btrim(party), ''), '—') AS name, SUM(meters) AS m, COUNT(*) AS c
     FROM stock_movements WHERE direction = 'OUT' AND ts >= $1::date AND ts < $2::date + 1
     GROUP BY 1 ORDER BY m DESC LIMIT 10`, P);
  const byQuality = await q(
    `SELECT l.quality AS name, SUM(sm.meters) AS m, COUNT(*) AS c
     FROM stock_movements sm JOIN lots l ON l.lot_id = sm.lot_id
     WHERE sm.direction = 'OUT' AND sm.ts >= $1::date AND sm.ts < $2::date + 1
     GROUP BY 1 ORDER BY m DESC LIMIT 10`, P);
  const partiesN = await q(`SELECT COUNT(DISTINCT lower(btrim(party))) AS c FROM stock_movements WHERE direction = 'OUT' AND party IS NOT NULL AND ts >= $1::date AND ts < $2::date + 1`, P);
  const named = (rows: Record<string, unknown>[]): Named[] => rows.map((x) => ({ name: String(x.name), meters: r2(n(x.m)), count: n(x.c) }));

  // ---- receipts ----
  const byMill = await q(
    `SELECT COALESCE(NULLIF(btrim(mill_name), ''), '—') AS name, SUM(meters) AS m, COUNT(*) AS c,
            SUM(grey_meters) FILTER (WHERE finished_meters IS NOT NULL) AS g, SUM(finished_meters) FILTER (WHERE grey_meters IS NOT NULL) AS f
     FROM stock_movements WHERE direction = 'IN' AND ts >= $1::date AND ts < $2::date + 1
     GROUP BY 1 ORDER BY m DESC LIMIT 10`, P);

  // ---- production ----
  const bySection = await q(
    `SELECT initcap(btrim(regexp_replace(process, '\\s*section\\s*$', '', 'i'))) AS name, SUM(meters_out) AS m, COUNT(*) AS c, SUM(shortage) AS s, SUM(meters_in) AS i
     FROM job_cards WHERE status = 'closed' AND ts_closed >= $1::date AND ts_closed < $2::date + 1
     GROUP BY 1 ORDER BY m DESC`, P);
  const byWorker = await q(
    `SELECT COALESCE(w.name, '—') AS name, MAX(jc.process) AS section, SUM(jc.meters_out) AS m, COUNT(*) AS c
     FROM job_cards jc LEFT JOIN workers w ON w.id = jc.worker_id
     WHERE jc.status = 'closed' AND jc.ts_closed >= $1::date AND jc.ts_closed < $2::date + 1
     GROUP BY 1 ORDER BY m DESC LIMIT 15`, P);
  const flagged = await q(
    `SELECT jc.id, jc.lot_id, jc.process, COALESCE(w.name, '—') AS worker, jc.meters_in, ROUND(jc.shortage / jc.meters_in * 100, 1) AS pct
     FROM job_cards jc LEFT JOIN workers w ON w.id = jc.worker_id
     WHERE jc.status = 'closed' AND jc.ts_closed >= $1::date AND jc.ts_closed < $2::date + 1 AND jc.shortage / jc.meters_in * 100 > $3
     ORDER BY pct DESC LIMIT 20`, [...P, limitPct]);

  // ---- efficiency ----
  const effSec = await q(
    `SELECT initcap(btrim(regexp_replace(w.section, '\\s*section\\s*$', '', 'i'))) AS name, SUM(e.done) AS d, SUM(e.allotted) AS a
     FROM efficiency_daily e JOIN workers w ON w.id = e.worker_id
     WHERE e.date BETWEEN $1::date AND $2::date GROUP BY 1 ORDER BY 1`, P);
  const effWorkers = await q(
    `SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE d / NULLIF(a, 0) * 100 < $3) AS below
     FROM (SELECT worker_id, SUM(done) AS d, SUM(allotted) AS a FROM efficiency_daily WHERE date BETWEEN $1::date AND $2::date GROUP BY worker_id HAVING SUM(allotted) > 0) x`,
    [...P, targetPct]);

  // ---- orders + inquiries (tables may be empty) ----
  const ord = await q(
    `SELECT (SELECT COUNT(*) FROM orders) AS any,
            (SELECT COALESCE(SUM(meters), 0) FROM orders WHERE status <> 'cancelled' AND created_at >= $1::date AND created_at < $2::date + 1) AS created_m,
            (SELECT COALESCE(SUM(meters), 0) FROM stock_movements WHERE direction = 'OUT' AND order_id IS NOT NULL AND ts >= $1::date AND ts < $2::date + 1) AS dispatched_m,
            (SELECT COUNT(*) FROM orders WHERE status = 'dispatched' AND updated_at >= $1::date AND updated_at < $2::date + 1) AS completed`, P);
  const openOrd = await q(
    `SELECT COUNT(*) AS n, COALESCE(SUM(rem), 0) AS m,
            COUNT(*) FILTER (WHERE promise_date < $1::date) AS overdue, COALESCE(SUM(rem) FILTER (WHERE promise_date < $1::date), 0) AS overdue_m
     FROM (SELECT o.promise_date, GREATEST(o.meters - COALESCE((SELECT SUM(meters) FROM stock_movements WHERE direction = 'OUT' AND order_id = o.id), 0), 0) AS rem
           FROM orders o WHERE o.status IN ('open', 'partly_dispatched')) x`, [rg.to]);
  const inq = await q(
    `SELECT (SELECT COUNT(*) FROM inquiries) AS any,
            COUNT(*) FILTER (WHERE status = 'quoted') AS quoted, COUNT(*) FILTER (WHERE status = 'won') AS won, COUNT(*) FILTER (WHERE status = 'lost') AS lost
     FROM inquiries WHERE updated_at >= $1::date AND updated_at < $2::date + 1`, P);

  // ---- time saved (same rule as value.ts, for this date range) ----
  const ts = await q(
    `WITH s AS (SELECT manual_challan_min AS ch, manual_job_card_min AS jc FROM app_settings WHERE id = 1),
     reads AS (
       SELECT CASE WHEN ce.type = 'job_card_folding' THEN s.jc ELSE s.ch END * 60 AS manual_s,
              COALESCE(ce.capture_seconds, 60) + COALESCE(ce.review_seconds, 0) AS actual_s
       FROM capture_events ce, s
       WHERE ce.status IN ('confirmed', 'corrected') AND ce.ts >= $1::date AND ce.ts < $2::date + 1)
     SELECT COUNT(*) AS n, COALESCE(SUM(manual_s), 0) AS manual_s, COALESCE(SUM(actual_s), 0) AS actual_s,
            COALESCE(SUM(GREATEST(manual_s - actual_s, 0)), 0) AS saved_s FROM reads`, P);
  const mins = (s: unknown) => r1(n(s) / 60);

  const o0 = ord.rows[0], oo = openOrd.rows[0], i0 = inq.rows[0];
  const report: Report = {
    period, label: rg.label, rangeText: rg.rangeText, from: rg.from, to: rg.to, prevFrom: rg.prevFrom, prevTo: rg.prevTo, prevLabel: rg.prevLabel, partial: rg.partial,
    role, generatedAt: new Date().toISOString(),
    kpis: [],
    stock,
    dispatch: { total: r2(cur.out), challans: cur.outN, parties: n(partiesN.rows[0].c), byParty: named(byParty.rows), byQuality: named(byQuality.rows) },
    receipts: {
      total: r2(cur.in), challans: cur.inN,
      byMill: byMill.rows.map((x) => ({ name: String(x.name), meters: r2(n(x.m)), count: n(x.c), lossPct: n(x.g) > 0 ? r1(((n(x.g) - n(x.f)) / n(x.g)) * 100) : null })),
    },
    production: {
      total: r2(cur.prod), cards: cur.prodN, shortagePct: cur.shortagePct, limitPct,
      bySection: bySection.rows.map((x) => ({ name: String(x.name), meters: r2(n(x.m)), count: n(x.c), shortagePct: pctOrNull(n(x.s), n(x.i)) })),
      byWorker: byWorker.rows.map((x) => ({ name: String(x.name), section: String(x.section ?? ''), meters: r2(n(x.m)), count: n(x.c) })),
      flagged: flagged.rows.map((x) => ({ id: n(x.id), lot_id: String(x.lot_id), process: String(x.process), worker: String(x.worker), meters_in: n(x.meters_in), shortagePct: n(x.pct) })),
    },
    efficiency: {
      pct: cur.effPct, targetPct, belowTarget: n(effWorkers.rows[0].below), workers: n(effWorkers.rows[0].n),
      bySection: effSec.rows.map((x) => ({ name: String(x.name), pct: pctOrNull(n(x.d), n(x.a)) })),
    },
    orders: {
      hasData: n(o0.any) > 0, created: cur.orders, createdM: r2(n(o0.created_m)), dispatchedM: r2(n(o0.dispatched_m)), completed: n(o0.completed),
      overdue: n(oo.overdue), overdueM: r2(n(oo.overdue_m)), open: n(oo.n), openM: r2(n(oo.m)),
    },
    inquiries: { hasData: n(i0.any) > 0, created: cur.inquiries, quoted: n(i0.quoted), won: n(i0.won), lost: n(i0.lost) },
    timeSaved: { captures: n(ts.rows[0].n), savedMin: mins(ts.rows[0].saved_s), manualMin: mins(ts.rows[0].manual_s), actualMin: mins(ts.rows[0].actual_s) },
    inventory: { included: false, short: [], low: [], ageingLots: 0, ageingM: 0 },
    narrative: [],
    narrativeSource: 'rules',
  };

  if (owner) {
    // Outstanding / overdue as of the period's last day. Payments settle the oldest invoices first,
    // so a party's overdue = invoices already past due − everything it has paid (never below 0).
    const m = await q(
      `WITH inv AS (SELECT party_id, SUM(total) AS t, SUM(total) FILTER (WHERE due_date < $1::date) AS due
                    FROM invoices WHERE status <> 'cancelled' AND invoice_date <= $1::date GROUP BY party_id),
            pay AS (SELECT party_id, SUM(amount) AS t FROM payments WHERE paid_on <= $1::date GROUP BY party_id),
            per AS (SELECT p.name, COALESCE(inv.t, 0) - COALESCE(pay.t, 0) AS outstanding,
                           GREATEST(COALESCE(inv.due, 0) - COALESCE(pay.t, 0), 0) AS overdue
                    FROM parties p LEFT JOIN inv ON inv.party_id = p.id LEFT JOIN pay ON pay.party_id = p.id
                    WHERE inv.party_id IS NOT NULL OR pay.party_id IS NOT NULL)
       SELECT name, outstanding, overdue FROM per ORDER BY outstanding DESC`, [rg.to]);
    const counts = await q(
      `SELECT (SELECT COUNT(*) FROM invoices WHERE status <> 'cancelled' AND invoice_date BETWEEN $1::date AND $2::date) AS inv_n,
              (SELECT COUNT(*) FROM payments WHERE paid_on BETWEEN $1::date AND $2::date) AS pay_n,
              (SELECT COUNT(*) FROM invoices) + (SELECT COUNT(*) FROM payments) AS any`, P);
    const per = m.rows.map((x) => ({ name: String(x.name), amount: r2(n(x.outstanding)), overdue: r2(n(x.overdue)) }));
    report.money = {
      hasData: n(counts.rows[0].any) > 0,
      invoiced: r2(cur.invoiced ?? 0), invoices: n(counts.rows[0].inv_n), collected: r2(cur.collected ?? 0), payments: n(counts.rows[0].pay_n),
      outstanding: r2(per.reduce((s, x) => s + Math.max(0, x.amount), 0)), overdue: r2(per.reduce((s, x) => s + x.overdue, 0)),
      topOutstanding: per.filter((x) => x.amount > 0).slice(0, 8),
    };
    const ai = await q(
      `SELECT feature, COUNT(*) AS c, COUNT(*) FILTER (WHERE NOT success) AS f, COALESCE(SUM(cost_usd), 0) AS usd
       FROM llm_usage WHERE ts >= $1::date AND ts < $2::date + 1 GROUP BY feature ORDER BY usd DESC, c DESC`, P);
    report.ai = {
      calls: ai.rows.reduce((s, x) => s + n(x.c), 0), failed: ai.rows.reduce((s, x) => s + n(x.f), 0),
      costUsd: Math.round(ai.rows.reduce((s, x) => s + n(x.usd), 0) * 10000) / 10000,
      byFeature: ai.rows.map((x) => ({ feature: String(x.feature), calls: n(x.c), costUsd: Math.round(n(x.usd) * 10000) / 10000 })),
    };
  }

  // Current stock picture only makes sense when the period reaches today.
  if (rg.to === today) {
    const inv = await inventorySnapshot(q);
    report.inventory = {
      included: true,
      short: inv.qualities.filter((x) => x.status === 'short').map((x) => x.quality),
      low: inv.qualities.filter((x) => x.status === 'low').map((x) => x.quality),
      ageingLots: inv.ageing.count, ageingM: inv.ageing.meters,
    };
  }

  const k = (key: string, label: string, unit: KpiChange['unit'], value: number | null, prevV: number | null, upIsGood = true, ownerOnly = false): KpiChange =>
    ({ key, label, unit, value, prev: prevV, changePct: change(value, prevV, unit), upIsGood, ...(ownerOnly ? { ownerOnly } : {}) });
  report.kpis = [
    k('dispatched', 'Dispatched', 'm', r2(cur.out), r2(prev.out)),
    k('received', 'Received', 'm', r2(cur.in), r2(prev.in)),
    k('production', 'Production', 'm', r2(cur.prod), r2(prev.prod)),
    k('shortage', 'Shortage', '%', cur.shortagePct, prev.shortagePct, false),
    k('efficiency', 'Efficiency', '%', cur.effPct, prev.effPct),
    ...(report.orders.hasData ? [k('orders', 'New orders', 'count', cur.orders, prev.orders)] : []),
    ...(report.inquiries.hasData ? [k('inquiries', 'Inquiries', 'count', cur.inquiries, prev.inquiries)] : []),
    ...(owner ? [
      k('invoiced', 'Invoiced', 'inr', cur.invoiced, prev.invoiced, true, true),
      k('collected', 'Collected', 'inr', cur.collected, prev.collected, true, true),
      k('ai_cost', 'AI cost', 'usd', cur.aiUsd, prev.aiUsd, false, true),
    ] : []),
  ];
  report.narrative = narrativeFor(report);
  return report;
}

// ---------- narrative (deterministic) ----------
const fm = (v: number) => Math.round(v).toLocaleString('en-IN');
const rupees = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;
const s = (c: number, one: string, many = `${one}s`) => `${c} ${c === 1 ? one : many}`;
function trend(kp: KpiChange | undefined, prevLabel: string): string {
  if (!kp || kp.changePct == null) return '';
  if (Math.abs(kp.changePct) < 1) return `, about the same as the ${prevLabel}`;
  if (kp.unit === '%') return `, ${kp.changePct > 0 ? 'up' : 'down'} ${Math.abs(kp.changePct)} points on the ${prevLabel}`;
  return `, ${kp.changePct > 0 ? 'up' : 'down'} ${Math.abs(Math.round(kp.changePct))}% on the ${prevLabel}`;
}

export function narrativeFor(r: Report): string[] {
  const kp = (key: string) => r.kpis.find((x) => x.key === key);
  const out: string[] = [];
  const when = r.period === 'day' ? (r.partial ? ' today so far' : ' that day') : r.partial ? ` this ${r.period} so far` : ` that ${r.period}`;

  if (r.dispatch.total > 0) {
    const top = r.dispatch.byParty[0];
    out.push(`Dispatched ${fm(r.dispatch.total)} m on ${s(r.dispatch.challans, 'challan')}${trend(kp('dispatched'), r.prevLabel)}${top ? `; biggest party ${top.name} (${fm(top.meters)} m)` : ''}.`);
  } else out.push(`Nothing was dispatched${when}.`);

  if (r.receipts.total > 0 || r.stock.closing !== r.stock.opening) {
    const mill = r.receipts.byMill[0];
    out.push(`Received ${fm(r.receipts.total)} m${mill && r.receipts.total > 0 ? ` (most from ${mill.name})` : ''}; stock went from ${fm(r.stock.opening)} m to ${fm(r.stock.closing)} m.`);
  } else out.push(`No fabric received; stock stays at ${fm(r.stock.closing)} m.`);

  if (r.production.cards === 0) out.push(`No job cards were closed${when}.`);
  else {
    const flag = r.production.flagged.length;
    out.push(`Production closed ${s(r.production.cards, 'job card')} for ${fm(r.production.total)} m${r.production.shortagePct != null ? ` at ${r.production.shortagePct}% shortage` : ''}${flag ? `; ${s(flag, 'card')} over the ${r.production.limitPct}% limit` : ''}.`);
  }

  // Risks: the most pressing first.
  const risks: string[] = [];
  if (r.orders.overdue > 0) risks.push(`${s(r.orders.overdue, 'order')} past the promise date with ${fm(r.orders.overdueM)} m still to send`);
  if (r.inventory.short.length) risks.push(`not enough free stock for open orders in ${r.inventory.short.slice(0, 3).join(', ')}`);
  else if (r.inventory.low.length) risks.push(`${r.inventory.low.slice(0, 3).join(', ')} running low`);
  const eff = kp('efficiency');
  if (eff?.value != null && eff.value < r.efficiency.targetPct) risks.push(`efficiency ${eff.value}% is below the ${r.efficiency.targetPct}% target${r.efficiency.belowTarget ? ` (${s(r.efficiency.belowTarget, 'worker')} below)` : ''}`);
  if (risks.length) out.push(`${risks[0].charAt(0).toUpperCase()}${risks.slice(0, 2).join('; ').slice(1)}.`);

  if (r.money && r.money.hasData) {
    out.push(`Invoiced ${rupees(r.money.invoiced)} and collected ${rupees(r.money.collected)}; ${rupees(r.money.outstanding)} outstanding${r.money.overdue > 0 ? `, ${rupees(r.money.overdue)} overdue` : ''}.`);
  } else if (r.inquiries.hasData && r.inquiries.created > 0) {
    out.push(`${s(r.inquiries.created, 'new inquiry', 'new inquiries')}; ${r.inquiries.won} won, ${r.inquiries.lost} lost.`);
  } else if (r.timeSaved.captures > 0) {
    out.push(`Photo capture saved about ${fm(r.timeSaved.savedMin)} min on ${s(r.timeSaved.captures, 'read')}.`);
  }
  return out.slice(0, 5);
}

/** Remove owner-only parts (₹ and AI cost). buildReport already skips them for non-owners; use this on any copy. */
export function stripForRole<T extends Report>(r: T, role: Role): T {
  if (role === 'owner') return r;
  const { money: _m, ai: _a, ...rest } = r;
  void _m; void _a;
  const out = { ...rest, kpis: r.kpis.filter((x) => !x.ownerOnly), role } as T;
  // Rebuild the narrative so no ₹ sentence survives.
  return { ...out, narrative: narrativeFor(out), narrativeSource: 'rules' };
}
