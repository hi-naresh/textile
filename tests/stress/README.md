# Local stock stress fixtures

These scripts create synthetic ledger rows to measure database and export behavior. They do not load `.env` and refuse all targets except `localhost` databases whose name ends in `_test`. Never point them at production.

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
DATABASE_URL=postgresql://localhost/textile_stock_test npm run db:migrate
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
