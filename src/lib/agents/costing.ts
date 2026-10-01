// Costing & Margin agent (owner only). SWITCHED OFF by default (catalog.ts): it needs selling rates and
// process costs, which the owner turned off — a margin without process costs overstates profit.
// Info-only alerts, no one-tap actions:
//  low_margin    — a party's dispatches in the last 30 days earned under 3% (fully costed moves only;
//                  cost = purchase + grey→finished shortage, rate = invoice or order rate)
import type { Q } from '../db';
import type { AgentModule } from './types';
import { resolveMissing, suggest } from './suggest';
import { marginReport } from '../money/costing';
import { rupees } from '../money/validate';

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
      detail: `Sold ${Math.round(r.meters).toLocaleString('en-IN')} m for ${rupees(r.revenue)} against cost ${rupees(r.cost)}. Check the rates given to this party.`,
      hint: 'Open Money → Margin to see which orders earned least.',
      payload: { party_id: r.party_id, margin_pct: r.margin_pct }, target: r.party_id ? { type: 'party', id: r.party_id } : null,
      ownerOnly: true, dedupeKey: key,
    });
  }
  await resolveMissing(q, 'costing', 'low_margin', low);

  // Selling rates and process costs are turned off (every party gets its own rate; process costs later),
  // so the old "missing rate" / "missing process cost" alerts are closed and never raised again.
  await resolveMissing(q, 'costing', 'missing_rate', []);
  await resolveMissing(q, 'costing', 'missing_cost', []);
}

export const agent: AgentModule = { scan };
