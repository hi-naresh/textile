// One-time backfill of outgoing-entry statuses from the sales register's LOT S codes (issue #7).
//
//   npm run db:backfill-lot-status                  → DRY RUN: prints what would change and writes
//                                                     lot-status-backfill.csv for the owner to check. Nothing is saved.
//   npm run db:backfill-lot-status -- --apply --by <owner user id>
//                                                   → applies it in one transaction (S, R → Running; E, A → End and
//                                                     the lot closes on that row's date). Running it again changes nothing.
//
// Uses DATABASE_URL (or POSTGRES_URL) like the app; .env.local / .env are read when the variable isn't set.
// Run migrations 015 and 016 first. See src/lib/lot-status-backfill.ts for the rules.
import './load-env';
import fs from 'node:fs';
import pool, { query, withTransaction } from '../src/lib/db';
import { applyBackfill, planBackfill } from '../src/lib/lot-status-backfill';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const byIdx = args.indexOf('--by');
const by = byIdx >= 0 ? args[byIdx + 1] ?? null : null;
process.env.DB_QUIET = '1';

const csv = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

async function main() {
  const raw = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  console.log(`Database: ${raw ? new URL(raw).host : 'local default'}`);
  const plan = await planBackfill((text, params) => query(text, params));
  console.log('\nStatuses from LOT S codes:');
  for (const s of plan.statuses) console.log(`  ${s.code} → ${s.status}: ${s.rows} rows`);
  for (const u of plan.unknown) console.log(`  ${u.code} → (unknown code, left empty): ${u.rows} rows`);
  const close = plan.lots.filter((l) => l.action === 'close');
  const review = plan.lots.filter((l) => l.action === 'review');
  console.log(`\nLots that would close: ${close.length}`);
  for (const l of close) {
    const adj = l.adjustment > 0 ? `${l.adjustment} m left over written off` : l.adjustment < 0 ? `${-l.adjustment} m sent extra written back` : 'balance already 0';
    console.log(`  ${l.lot_id}${l.reg_lot_no && l.reg_lot_no !== l.lot_id ? ` (register ${l.reg_lot_no})` : ''} · ${l.quality} · ${l.end_code} on bill ${l.end_bill ?? '—'} (${l.end_date}) · balance ${l.balance} m · ${adj}`);
  }
  if (review.length) {
    console.log(`\nLots to look at (not closed): ${review.length}`);
    for (const l of review) console.log(`  ${l.lot_id} · ${l.end_code} on bill ${l.end_bill ?? '—'} (${l.end_date}) · ${l.why}`);
  }

  const file = 'lot-status-backfill.csv';
  fs.writeFileSync(file, [
    ['Lot', 'Register lot no.', 'Quality', 'Code', 'Bill', 'Date', 'Meters on that bill', 'Balance now', 'Written off (+) / back (−)', 'Action', 'Why'].join(','),
    ...plan.lots.map((l) => [l.lot_id, l.reg_lot_no, l.quality, l.end_code, l.end_bill, l.end_date, l.end_meters, l.balance, l.adjustment, l.action, l.why].map(csv).join(',')),
  ].join('\n'));
  console.log(`\nWrote ${file} (${plan.lots.length} lots).`);

  if (!apply) { console.log('\nDry run: nothing was saved. Add --apply --by <owner user id> once the owner has checked the list.'); return; }
  if (!by) throw new Error('Pass --by <owner user id> with --apply (it is recorded as who closed the lots).');
  const out = await withTransaction((q) => applyBackfill(q, by));
  console.log(`\nApplied: ${out.statuses} statuses set, ${out.closed.length} lots closed, ${out.review.length} left for review.`);
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => pool.end());
