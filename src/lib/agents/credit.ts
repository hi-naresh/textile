// Credit & Payment agent (owner only). Scan: overdue parties + parties over their credit limit.
// Accept "Draft reminder": the reminder itself is built on demand in Money → Outstanding
// (GET /api/credit/reminder), so accepting only confirms where to find it.
import type { Q } from '../db';
import type { AgentModule } from './types';
import { resolveMissing, suggest } from './suggest';
import { creditSummary, bucketOf, BUCKET_LABEL } from '../money/credit';
import { rupees, seq } from '../money/validate';
import { LedgerError } from '../ledger-error';

/** Keys the owner accepted / dismissed recently: don't raise the same alert again for a week. */
async function recentlyDecided(q: Q): Promise<Set<string>> {
  const r = await q(
    `SELECT dedupe_key FROM agent_suggestions WHERE agent = 'credit' AND status IN ('accepted', 'rejected') AND decided_at > NOW() - interval '7 days'`,
  );
  return new Set(r.rows.map((x) => String(x.dedupe_key)));
}

async function scan(q: Q): Promise<void> {
  const [rows, snoozed] = await seq([() => creditSummary(q), () => recentlyDecided(q)]);
  const overdueKeys: string[] = [];
  const limitKeys: string[] = [];
  for (const p of rows) {
    if (p.overdue > 0) {
      // Key includes the ageing bucket, so an alert the owner dismissed comes back when it gets older.
      const key = `credit:overdue:${p.party_id}:${bucketOf(p.oldest_due_days)}`;
      overdueKeys.push(key);
      if (!snoozed.has(key)) {
        const n = p.invoices.filter((i) => i.unpaid > 0 && i.days_past_due > 0).length;
        await suggest(q, {
          agent: 'credit', kind: 'overdue', severity: p.oldest_due_days > 60 ? 'bad' : 'warn',
          title: `${p.name}: ${rupees(p.overdue)} overdue for ${p.oldest_due_days} day${p.oldest_due_days === 1 ? '' : 's'}`,
          detail: `${n} bill${n === 1 ? '' : 's'} past due (${BUCKET_LABEL[bucketOf(p.oldest_due_days)]} days). Total outstanding ${rupees(p.outstanding)}.`,
          payload: { party_id: p.party_id }, target: { type: 'party', id: p.party_id },
          actionLabel: 'Draft reminder', ownerOnly: true, dedupeKey: key,
        });
      }
    }
    if (p.limit != null && p.over_limit > 0) {
      const key = `credit:over_limit:${p.party_id}`;
      limitKeys.push(key);
      if (!snoozed.has(key)) {
        await suggest(q, {
          agent: 'credit', kind: 'over_limit', severity: 'bad',
          title: `${p.name} is ${rupees(p.over_limit)} over the credit limit`,
          detail: `Outstanding ${rupees(p.outstanding)} against a limit of ${rupees(p.limit)}. Hold new dispatches until paid.`,
          payload: { party_id: p.party_id }, target: { type: 'party', id: p.party_id },
          actionLabel: 'Draft reminder', ownerOnly: true, dedupeKey: key,
        });
      }
    }
  }
  await resolveMissing(q, 'credit', 'overdue', overdueKeys);
  await resolveMissing(q, 'credit', 'over_limit', limitKeys);
}

export const agent: AgentModule = {
  scan,
  async accept(s, q) {
    const pid = Number(s.payload?.party_id);
    if (!Number.isInteger(pid) || pid <= 0) throw new LedgerError('This alert has no party.');
    const r = await q(`SELECT name FROM parties WHERE id = $1`, [pid]);
    if (!r.rows[0]) throw new LedgerError('Party not found.', 404);
    return `Reminder for ${r.rows[0].name} ready in Money → Outstanding`;
  },
};
