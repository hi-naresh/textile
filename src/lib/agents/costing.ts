// Costing & Margin agent (owner only). Info-only alerts, no one-tap actions:
//  low_margin    — a party's dispatches in the last 30 days earned under 3% (fully costed moves only)
//  missing_rate  — a quality in stock / open orders has no selling rate
//  missing_cost  — a section has job cards but no process cost
import type { Q } from '../db';
import type { AgentModule } from './types';
import { resolveMissing, suggest } from './suggest';
import { marginReport } from '../money/costing';
import { rupees, seq } from '../money/validate';
import { sectionKey } from '../settings';

export const LOW_MARGIN_PCT = 3;

async function scan(q: Q): Promise<void> {
  // 1) low margin, one alert per party
  const { rows } = await marginReport(q, 'party', 30, { completeOnly: true });
  const low: string[] = [];
  for (const r of rows) {
    if (r.margin_pct == null || r.margin_pct >= LOW_MARGIN_PCT) continue;
    const key = `costing:low_margin:${r.key}`;
    low.push(key);
    await suggest(q, {
      agent: 'costing', kind: 'low_margin', severity: 'warn',
      title: `Low margin on ${r.label}: ${r.margin_pct}% in 30 days`,
      detail: `Sold ${Math.round(r.meters).toLocaleString('en-IN')} m for ${rupees(r.revenue)} against cost ${rupees(r.cost)}. Check the selling rate.`,
      payload: { party_id: r.party_id, margin_pct: r.margin_pct }, target: r.party_id ? { type: 'party', id: r.party_id } : null,
      ownerOnly: true, dedupeKey: key,
    });
  }
  await resolveMissing(q, 'costing', 'low_margin', low);

  // 2) qualities in stock or on open orders with no selling rate at all
  const noRate = await q(
    `SELECT DISTINCT ON (lower(btrim(x.quality))) btrim(x.quality) AS quality FROM (
       SELECT l.quality FROM lots l
       JOIN (SELECT lot_id, SUM(CASE WHEN direction = 'IN' THEN meters ELSE -meters END) AS bal FROM stock_movements GROUP BY lot_id) b ON b.lot_id = l.lot_id
       WHERE b.bal > 0
       UNION ALL SELECT quality FROM orders WHERE status IN ('open', 'partly_dispatched') AND rate_per_m IS NULL
     ) x
     WHERE NOT EXISTS (SELECT 1 FROM rates r WHERE lower(btrim(r.quality)) = lower(btrim(x.quality)) AND r.party_id IS NULL)
     ORDER BY lower(btrim(x.quality)), x.quality`,
  );
  // One summary instead of one alert per quality (keeps "Needs your attention" short).
  const mr: string[] = [];
  const names = noRate.rows.map((r) => String(r.quality));
  if (names.length) {
    const key = 'costing:missing_rate';
    mr.push(key);
    await suggest(q, {
      agent: 'costing', kind: 'missing_rate', severity: 'info',
      title: names.length === 1 ? `No selling rate for ${names[0]}` : `No selling rate for ${names.length} qualities: ${names.slice(0, 4).join(', ')}${names.length > 4 ? '…' : ''}`,
      detail: 'Set them in Settings → Selling rates so quotes, invoices and margin use them.',
      payload: { qualities: names }, target: { type: 'quality', id: names[0] }, ownerOnly: true, dedupeKey: key,
    });
  }
  await resolveMissing(q, 'costing', 'missing_rate', mr);

  // 3) sections with job cards but no process cost
  const [procs, costs] = await seq([
    () => q(`SELECT DISTINCT process FROM job_cards`),
    () => q(`SELECT DISTINCT section FROM process_costs`)]);
  const costed = new Set(costs.rows.map((r) => sectionKey(r.section)));
  const seen = new Set<string>();
  const mc: string[] = [];
  for (const r of procs.rows) {
    const k = sectionKey(String(r.process));
    if (!k || costed.has(k) || seen.has(k)) continue;
    seen.add(k);
    const name = String(r.process).replace(/\s*section\s*$/i, '').trim();
    const key = `costing:missing_cost:${k}`;
    mc.push(key);
    await suggest(q, {
      agent: 'costing', kind: 'missing_cost', severity: 'info',
      title: `No process cost for ${name}`,
      detail: 'Add the ₹ per meter in Settings → Process costs so lot costs and margins are complete.',
      payload: { section: name }, target: { type: 'section', id: name }, ownerOnly: true, dedupeKey: key,
    });
  }
  await resolveMissing(q, 'costing', 'missing_cost', mc);
}

export const agent: AgentModule = { scan };
