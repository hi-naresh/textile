# Local stock stress fixtures

The local fixture and measurement scripts create synthetic ledger rows to measure database and export behavior. They do not load `.env` and refuse all targets except `localhost` databases whose name ends in `_test`. The separate HTTP staging driver is described below. Never point load tests at production.

Run the local import, idempotency, and streamed-export regression suite with:

```sh
DATABASE_URL=postgresql://localhost/textile_stock_test npm run test:stress
```

The per-user request budgets are 60 validations/fix-file exports, 300 import chunks, and 60 data exports per minute. Tests use unique disposable users/scopes and clean up their rate-limit rows.

Measure a single real import commit (up to the current 1,000-row chunk maximum), including an idempotent retry:

```sh
DATABASE_URL=postgresql://localhost/textile_stock_test npm run stress:import-chunk -- --rows=1000
```

Apply database migrations and run this suite before testing rate limits:

```sh
SKIP_DOTENV=1 MIGRATION_DATABASE_URL=postgresql://localhost/textile_stock_test \
  DATABASE_URL=postgresql://localhost/textile_stock_test npm run db:migrate
DATABASE_URL=postgresql://localhost/textile_stock_test npm run db:check
DATABASE_URL=postgresql://localhost/textile_stock_test npm run test:stress
```

Measure the XLSX workbook writers using generated rows (no database writes or output files):

```sh
npm run stress:export-writers -- --rows=1000000
```

Measure report generation against a generated local database fixture:

```sh
DATABASE_URL=postgresql://localhost/textile_stock_test \
  npm run stress:generate -- --rows=1000000 --run-id=report-check --apply
DATABASE_URL=postgresql://localhost/textile_stock_test npm run stress:report
DATABASE_URL=postgresql://localhost/textile_stock_test npm run stress:check -- --run-id=report-check
DATABASE_URL=postgresql://localhost/textile_stock_test npm run stress:generate -- --cleanup=report-check
```

Start with a small run and verify the calculated lot totals:

```sh
DATABASE_URL=postgresql://localhost/textile_stock_test \
  npm run stress:generate -- --rows=1000 --run-id=trial-1000 --apply

DATABASE_URL=postgresql://localhost/textile_stock_test \
  npm run stress:check -- --run-id=trial-1000
```

Increase `--rows` gradually (for example 10,000, 20,000, then 100,000). A million rows is available as an explicit upper limit, but generates one million database movements and should only be attempted after confirming there is enough local disk space and time.

The generator is idempotency-protected by a unique run ID: it refuses to overwrite an existing fixture. If a run is interrupted, check its partial rows and remove only that run:

```sh
DATABASE_URL=postgresql://localhost/textile_stock_test \
  npm run stress:generate -- --cleanup=trial-1000
```

The checker compares the generated movement sums with the lot's stored incoming, outgoing, and balance totals. It exits nonzero if those totals disagree.

After generating a fixture, measure the XLSX writer without saving the large output file:

```sh
DATABASE_URL=postgresql://localhost/textile_stock_test npm run stress:export -- --run-id=trial-1000
```

See [the baseline report](../../docs/stress-test-report.md) for the local database measurements and the stress scenarios that remain untested.


## Full application imports and concurrent local users

These commands generate complete XLSX files, validate them through the authenticated route handler, commit 500-row chunks, and probe reads/exports during imports. They report sample counts, p50/p95/max latency, HTTP-style status counts, sampled process memory and pool use. They reconcile stock totals and clean their unique users/lots in `finally`. They do not exercise HTTP transport or hosted limits. Run benchmarks sequentially so they do not compete with one another.

```sh
DATABASE_URL=postgresql://localhost/textile_stock_test npm run stress:import-workload -- --rows=20000 --users=1 --validation-runs=5
DATABASE_URL=postgresql://localhost/textile_stock_test npm run stress:import-workload -- --rows=1000 --users=5 --validation-runs=3
DATABASE_URL=postgresql://localhost/textile_stock_test npm run stress:import-workload -- --rows=1000 --users=20 --validation-runs=3
```

Arguments allow 1–20 users, 1–20,000 rows per user and 1–20 validation repetitions. A failed run exits nonzero after attempting cleanup. Abrupt process termination can prevent cleanup; retain the printed run ID and remove only that run's `LOAD-<run-id>-<user>` lots and `load-<run-id>-<user>` accounts from the disposable database, or reset the disposable database.

## Deployment preflight

Select the intended staging database explicitly. The CLI migrator shares an advisory lock with runtime migrations and checks the schema afterward. Check the application connection separately because it may use a different role/search path. These commands require the operator to supply both URLs; they do not fall back to `.env`.

```sh
SKIP_DOTENV=1 MIGRATION_DATABASE_URL="${STAGING_MIGRATION_DATABASE_URL:?Set the disposable staging migration URL}" npm run db:migrate
DATABASE_URL="${STAGING_APPLICATION_DATABASE_URL:?Set the disposable staging application URL}" npm run db:check
```

`db:check` is read-only and verifies migration records, the rate-limit columns, and the `(user_id, scope)` primary key. Passing against a local database says nothing about a deployment database. All deployed instances should use the same `API_RATE_LIMIT_*` settings from `.env.example`; defaults remain 60/minute except commits at 300/minute. Values must be integers from 1 to 1,000,000.

## Prepared staging HTTP workload

Use a disposable staging instance and synthetic data only. Create 5, then 20 distinct owner sessions and fresh XLSX fixtures using the stock import template. Each user's file should contain incoming rows for a distinct `STRESS-` lot, with valid quality/design/meter fields. Start with 1,000 rows and then use representative 20,000-row files. This driver does not generate remote users or delete remote data.

Save a private manifest outside the repository with restrictive file permissions. Session cookies are credentials; do not commit or include them in reports. Example structure (replace placeholders and add one entry per user):

```json
{
  "origin": "https://your-disposable-staging.example",
  "disposable": true,
  "validationRuns": 5,
  "users": [
    {
      "cookie": "tb_at=<staging-session-token>",
      "lot": "STRESS-RUN1-USER1",
      "file": "user1.xlsx"
    }
  ]
}
```

File paths resolve relative to the manifest. The target must exactly match its HTTPS origin; redirects are rejected. The default command validates local inputs without sending requests:

```sh
npm run stress:http -- --manifest=/private/path/staging.json --target=https://your-disposable-staging.example
```

After verifying that the target is disposable staging, add `--apply` to execute the workload. Imports persist. Use new fixtures for each run; an already-imported file is rejected by the driver. Review/reconcile the fixture counts and balances, then reset the disposable environment. Do not use the local-only fixture cleanup scripts against remote databases.

Record the commit, provider/region, database size, instance count, rate settings, file rows and sizes, warm/cold runs, and sample counts alongside the JSON output. The driver consumes complete export bodies and reports errors without automatic retry. Fetches time out after five minutes. Collect **server** RSS/heap, function timeouts and database connection peaks separately from provider/database monitoring. Set latency acceptance targets before interpreting p95 values; the local measurements are baselines, not service guarantees.

For staging failure injection, interrupt a browser during a chunk and reopen the same file; interrupt a download and verify snapshot connections are released; inject transient provider errors and inspect retry/exhaustion behavior; edit/delete later export rows during downloads. Invoice snapshot write conflicts intentionally fail the whole download and roll back markers; retry the complete export. Local tests cover these server/client behaviors deterministically, but do not establish real browser termination or remote-provider behavior.


## Existing reset workflow and destructive-test isolation

`reset.test.ts` creates a **new local database** from the explicitly supplied local `_test` connection, applies migrations, runs the password-confirmed reset and backup scenarios, then drops that new database. It never resets the shared `textile_stock_test` database. The local role needs CREATE DATABASE permission. The same helper provides the two-database firm-isolation regression.

Measure the supported backup/reset path at large volume:

```sh
DATABASE_URL=postgresql://localhost/textile_stock_test npm run stress:reset -- --rows=1000000
```

The benchmark generates 1–1,000,000 synthetic movements in its own new database, reconciles balances, consumes the JSON backup without buffering it all, performs an authenticated password-confirmed stock reset, checks counts/owner/audit records, and drops its database. This exercises local route handlers, not HTTP or hosted infrastructure. An abruptly killed process may leave its uniquely named `textile_resetbench_<random>_test` database; inspect before cleaning it up. Normal completion drops it without using FORCE.

Connection-loss regressions call `pg_terminate_backend` **only for the backend PID acquired by that test**, with the local `_test` database guard. They never terminate unrelated sessions. Logs from injected failures are expected; test assertions determine success. These tests cover real PostgreSQL disconnections but not a remote provider outage.

The staging workload driver now rejects nonempty fixture lots, imports whose validated rows do not belong solely to the declared fixture lot, and non-XLSX export responses. Use fresh incoming template fixtures for each run. Do not interpret a zero-error run as meeting the issue's proposed latency targets: compare the measured sample percentiles explicitly.
