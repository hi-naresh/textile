// Explicit target only; no .env loading. Default is a read-only dry run.
import pool, { query, withTransaction } from '../src/lib/db';
import { planBilledBackfill, billedPlanFingerprint, applyBilledBackfill } from '../src/lib/billed-backfill';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL explicitly to the intended database.');
  process.env.DB_QUIET = '1';
  const args = process.argv.slice(2);
  const plan = await planBilledBackfill(query);
  console.table(plan);
  const fingerprint = billedPlanFingerprint(plan);
  console.log(`Plan fingerprint: ${fingerprint}`);
  if (!args.includes('--apply')) { console.log('Dry run only. Review this list before applying.'); return; }
  const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const reviewed = value('--confirm-reviewed'), by = value('--by');
  if (!by || !reviewed || !/^[a-f0-9]{64}$/.test(reviewed)) throw new Error('Apply requires --confirm-reviewed <dry-run fingerprint> --by <owner user id>.');
  const saved = await withTransaction((q) => applyBilledBackfill(q, by, reviewed));
  console.log(`Corrected ${saved} NQTY values with an audit entry for each.`);
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
