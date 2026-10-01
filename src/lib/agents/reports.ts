// Analytics & Reporting agent (docs/AGENTS_PHASE2.md §8). Deterministic.
//   daily_report  (info) once a day: yesterday's numbers, links to the report (target report/day:<date>)
//   weekly_report (info) on Mondays: last week's numbers (target report/week:<monday>)
// Only the newest of each stays open; older ones are resolved. Owner only (supervisors have no Reports screen);
// titles carry meters only.
import type { Q } from '../db';
import type { AgentModule, SuggestionInput } from './types';
import { resolveMissing, suggest } from './suggest';
import { buildReport, type Report } from '../reports/build';
import { addDays, dbToday, weekStart } from '../reports/dates';

/** True when this report alert already exists (open, dismissed or resolved) — raise each one once. */
async function exists(q: Q, key: string): Promise<boolean> {
  const r = await q(`SELECT 1 FROM agent_suggestions WHERE dedupe_key = $1 LIMIT 1`, [key]);
  return !!r.rowCount;
}

const fm = (v: number) => Math.round(v).toLocaleString('en-IN');

function headline(r: Report): string {
  const parts = [
    r.dispatch.total > 0 ? `${fm(r.dispatch.total)} m dispatched` : 'nothing dispatched',
    `${fm(r.receipts.total)} m received`,
  ];
  if (r.production.cards > 0) parts.push(`${fm(r.production.total)} m produced`);
  if (r.production.flagged.length) parts.push(`${r.production.flagged.length} shortage flag${r.production.flagged.length === 1 ? '' : 's'}`);
  return parts.join(', ');
}

export function reportSuggestion(kind: 'daily_report' | 'weekly_report', r: Report): SuggestionInput {
  const daily = kind === 'daily_report';
  return {
    agent: 'reports', kind, severity: 'info', actionLabel: null,
    // Owner only: supervisors can't open Reports, so for them the card was a dead end.
    ownerOnly: true,
    hint: 'Open it for the full report (Excel download there too). This card is replaced by tomorrow\'s.',
    title: `${daily ? "Yesterday's" : "Last week's"} report is ready: ${headline(r)}`,
    detail: r.narrative.filter((l) => !l.includes('₹')).join(' '),
    payload: { period: r.period, from: r.from, to: r.to, dispatched: r.dispatch.total, received: r.receipts.total, production: r.production.total, shortagePct: r.production.shortagePct, efficiencyPct: r.efficiency.pct },
    target: { type: 'report', id: `${r.period}:${r.from}` },
    dedupeKey: `${kind}:${r.from}`,
  };
}

export async function scanReports(q: Q, todayOverride?: string): Promise<SuggestionInput[]> {
  const today = todayOverride ?? (await dbToday(q));
  const yesterday = addDays(today, -1);
  const lastMonday = addDays(weekStart(today), -7);
  const isMonday = weekStart(today) === today;
  const raised: SuggestionInput[] = [];

  // Daily: one per date, built once (not on every scan), never re-created after it was dismissed.
  const dayKey = `daily_report:${yesterday}`;
  if (!(await exists(q, dayKey))) {
    // Supervisor view: meters only, so nothing owner-only ends up in the alert text.
    const r = await buildReport(q, 'day', 'supervisor', yesterday, { today });
    const s = reportSuggestion('daily_report', r);
    await suggest(q, s);
    raised.push(s);
  }
  await resolveMissing(q, 'reports', 'daily_report', [dayKey]);

  // Weekly: raised on Monday for the week that just ended; stays open through the week.
  const weekKey = `weekly_report:${lastMonday}`;
  if (isMonday && !(await exists(q, weekKey))) {
    const r = await buildReport(q, 'week', 'supervisor', lastMonday, { today });
    const s = reportSuggestion('weekly_report', r);
    await suggest(q, s);
    raised.push(s);
  }
  await resolveMissing(q, 'reports', 'weekly_report', [weekKey]);
  return raised;
}

export const agent: AgentModule = {
  scan: async (q) => { await scanReports(q); },
};
