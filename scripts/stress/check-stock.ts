import { closePool, pool } from './db';

function runIdFromArgs(): string {
  const value = process.argv.find((arg) => arg.startsWith('--run-id='))?.slice('--run-id='.length);
  if (!value || !/^[a-zA-Z0-9-]{1,30}$/.test(value)) throw new Error('Pass --run-id=<1-30 letters, numbers, or hyphens>.');
  return value.toLowerCase();
}

async function main() {
  const runId = runIdFromArgs();
  const lotId = `STRESS-${runId}`.toUpperCase();
  const result = await pool.query(
    `SELECT l.lot_id, l.in_total_m, l.out_total_m, l.bal_m,
            COUNT(sm.id)::bigint AS movement_count,
            COUNT(sm.id) FILTER (WHERE sm.direction = 'IN')::bigint AS incoming_count,
            COUNT(sm.id) FILTER (WHERE sm.direction = 'OUT')::bigint AS outgoing_count,
            COALESCE(SUM(sm.meters) FILTER (WHERE sm.direction = 'IN'), 0) AS incoming_m,
            COALESCE(SUM(sm.meters) FILTER (WHERE sm.direction = 'OUT'), 0) AS outgoing_m,
            (SELECT COUNT(*)::bigint FROM stock_movements unexpected
              WHERE unexpected.lot_id = l.lot_id
                AND (unexpected.import_ref IS NULL OR unexpected.import_ref NOT LIKE $2)) AS unexpected_movement_count
       FROM lots l
       LEFT JOIN stock_movements sm ON sm.lot_id = l.lot_id AND sm.import_ref LIKE $2
      WHERE l.lot_id = $1
      GROUP BY l.lot_id, l.in_total_m, l.out_total_m, l.bal_m`,
    [lotId, `stress:${runId}:%`],
  );

  if (!result.rowCount) throw new Error(`No stress fixture found for ${runId}.`);
  const row = result.rows[0];
  const inMeters = Number(row.incoming_m);
  const outMeters = Number(row.outgoing_m);
  const mismatches = [
    Number(row.in_total_m) !== inMeters && `stored incoming total ${row.in_total_m} != movement total ${inMeters}`,
    Number(row.out_total_m) !== outMeters && `stored outgoing total ${row.out_total_m} != movement total ${outMeters}`,
    Math.abs(Number(row.bal_m) - (inMeters - outMeters)) >= 0.005 && `stored balance ${row.bal_m} != calculated balance ${inMeters - outMeters}`,
    Number(row.unexpected_movement_count) > 0 && `${row.unexpected_movement_count} lot movements are outside this stress fixture`,
  ].filter((message): message is string => typeof message === 'string');

  console.log(JSON.stringify({
    run_id: runId,
    lot_id: lotId,
    movement_count: Number(row.movement_count),
    incoming_count: Number(row.incoming_count),
    outgoing_count: Number(row.outgoing_count),
    incoming_m: inMeters,
    outgoing_m: outMeters,
    stored_balance_m: Number(row.bal_m),
    calculated_balance_m: inMeters - outMeters,
    mismatches,
  }, null, 2));
  if (mismatches.length) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closePool);
