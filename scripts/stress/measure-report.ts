import { performance } from 'node:perf_hooks';
import { buildReport } from '../../src/lib/reports/build';
import { reportWorkbook } from '../../src/lib/reports/export';
import { toBuffer } from '../../src/lib/excel';
import { readBilling } from '../../src/lib/billing';
import { closePool, pool } from './db';

async function main() {
  const started = performance.now();
  const [expected, billing] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN meters ELSE -meters END), 0) AS balance
       FROM stock_movements WHERE ts < CURRENT_DATE + 1`,
    ),
    readBilling((text, params) => pool.query(text, params)),
  ]);
  const report = await buildReport((text, params) => pool.query(text, params), 'day', 'owner');
  const workbook = await toBuffer(reportWorkbook(report, billing.firmName));
  const expectedBalance = Number(expected.rows[0].balance);
  const consistent = Math.abs(report.stock.closing - expectedBalance) < 0.01;
  console.log(JSON.stringify({
    report: 'daily-owner',
    stock_closing_m: report.stock.closing,
    independently_calculated_closing_m: expectedBalance,
    workbook_bytes: workbook.length,
    elapsed_ms: Math.round(performance.now() - started),
    consistent,
  }, null, 2));
  if (!consistent || workbook.length === 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closePool);
