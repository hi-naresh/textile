# Issues and bug fixes

This note summarizes the issue work completed on the `issues/bug-fixes` branch, how it was implemented and verified, and what remains before Issue #14 can be considered fully accepted.

## Completed issue work

### Stock status and closed-lot behavior

- **Stock status breakdown (#8):** Stock on hand is separated into Packed, Running, and On hold. Supervisor views remain scoped to their assigned sections, and stock summaries reflect the same breakdown.
- **Closed-lot meter corrections (#6):** Editing meters on a closed lot recalculates its closing adjustment in the same transaction, maintains a zero balance, and records the adjustment change in the audit history.
- **Sales-register LOT S mapping (#7):** Confirmed LOT S codes map to Running or End; unconfirmed and unknown codes remain unmapped instead of being guessed.
- Database-backed stock tests were repaired and passed before the related changes were pushed.

## Issue #14 — Import, export, and bulk-operation stress work

### Import reliability

- Added per-batch transaction locking for stock import chunks. Simultaneous retries of the same batch wait for one another, then skip already-saved rows instead of inserting duplicates.
- Kept a chunk atomic: a failed row or database error rolls back all writes in that chunk.
- The browser client retries network failures, HTTP 429, and HTTP 5xx responses up to two times, with exponential backoff and capped `Retry-After` handling. Non-retryable 4xx responses stop immediately.
- Added local tests for the 20,000-row file limit and rejection of 20,001 rows, corrupt workbooks, wrong sheets, empty templates, Unicode, overlong text, and files over the 8 MB limit.

### Export scalability and safety

- Stock challan export now reads rows using keyset pagination and writes the XLSX workbook with ExcelJS's streaming writer.
- Lot export now also uses keyset pagination and a streaming XLSX writer. The previous 200,000-lot in-memory cap was removed.
- Invoice Tally XLSX and XML exports now read invoice records in pages and stream the output. The workbook writer maintains totals while emitting rows.
- Report exports already contain fixed-size summaries and grouped totals rather than raw movement rows. A local report run was checked against an independent movement-balance query.
- Excel output treats formula-like text as string cells; Tally XML output escapes XML text.

### Request limits

- Added a PostgreSQL-backed, atomic per-user fixed-window limiter so limits apply across application instances:
  - Stock import validation and fix-file export: 60 requests per minute each.
  - Stock import chunk commits: 300 requests per minute.
  - Stock, invoice, and report data exports: 60 requests per minute each.
- Throttled requests receive HTTP 429, a clear message, and a `Retry-After` header.
- Added migration `scripts/migrations/017_api_rate_limits.sql`; it has been applied to the disposable local test database. It must also be applied to the intended deployment database before deploying this code.

### Test and measurement tooling

- Added disposable-local-database-only fixture generation and reconciliation scripts. They require a localhost database whose name ends in `_test`, do not load `.env`, and support explicit cleanup by run ID.
- Added stress regression tests for chunk rollback, 20 simultaneous same-batch import retries, lost-response retries, rate limiting, 500 simultaneous ledger edits, malformed imports, formula-like export data, and concurrent exports.
- Added writer benchmarks for one million generated lot and invoice rows, plus a report benchmark for a one-million-movement database fixture.
- Results and caveats are recorded in [the stress-test report](./docs/stress-test-report.md); local run instructions are in [the stress test README](./tests/stress/README.md).

## Verification completed

All performance numbers below are local single-run measurements, not p95 guarantees or hosted-platform results.

- Stress regression tests: **24/24 passed**.
- Stock regression tests: **39/39 passed**.
- TypeScript check and production build passed.
- Route-auth check passed for 137 handlers.
- Full lint completed with 15 warnings in pre-existing, unrelated blackbox test files.
- Local one-million-row stock challan XLSX writer: 1,000,000 rows, 102,842,929 bytes, approximately 39.1 seconds; sampled heap peak approximately 119 MB.
- Local lot XLSX writer: 1,000,000 synthetic rows, 34,208,000 bytes, approximately 6.7 seconds; sampled heap growth approximately 20 MB.
- Local invoice XLSX writer: 1,000,000 synthetic rows, 60,204,083 bytes, approximately 15.7 seconds; sampled heap growth approximately 26 MB.
- Local daily report with a one-million-movement fixture: approximately 855 ms. Its closing balance matched an independent database sum; the fixture was reconciled and removed.
- A real local 1,000-row import chunk took approximately 1.08 seconds in two runs. Each same-batch retry skipped all rows and preserved the expected balance.
- PostgreSQL-backed rate limiting was tested with 20 simultaneous requests against a limit of five: five were accepted and the rest received 429 responses.

## Remaining work and limitations

Issue #14 is **not fully accepted** until the applicable deployment and consistency checks below are resolved:

1. **Staging performance and concurrency:** Run representative 5–20 user import/export workloads against a disposable staging environment. Measure validation and commit p95, export duration, ordinary-read latency during imports, function timeouts, memory, and database connection use. Never run these load tests against production.
2. **Deployed migration:** Apply migration 017 to the intended staging/deployment database and confirm the rate-limit table is present before deploying the endpoint changes.
3. **Export snapshot consistency:** Keyset pagination bounds memory and the invoice export uses a high-water ID, but exports are not repeatable-read snapshots. Existing rows changed or deleted while a multi-page export runs may make its output inconsistent. Decide and implement the required snapshot semantics, then test concurrent edits/deletes during exports.
4. **Bulk deletion:** There is no general bulk-delete API. The supported ledger edit endpoint allows at most 500 changes in one request and was tested at that limit. Arbitrary movement deletion remains unsupported to preserve ledger history; any new delete workflow needs explicit product requirements and balance/audit behavior.
5. **Tenant isolation:** The current application uses a single-firm database model. Per-firm RLS isolation under load is not currently a supported product scenario; revisit if the data model becomes multi-tenant.
6. **Import volume/performance:** The one-million-movement generator inserts directly through SQL to exercise database triggers and reconciliation. The app validator has a 20,000-row boundary test, but large end-to-end file validation p95 and sustained application import throughput are still unmeasured.
7. **Failure and file-format matrix:** Local tests cover representative failure and malformed-file cases, not every specification combination (for example browser termination at every chunk boundary, remote provider failures, and all corrupt workbook variants). Add staging/API failure-injection coverage as appropriate.
8. **Rate-limit policy:** Current per-user budgets are fixed constants, not product-configurable. Review whether they suit actual usage and hosting limits after staging measurements.

The current branch tip at the time this note was written is `62d0f30` (`Harden large import and export paths`), pushed to `origin/issues/bug-fixes`. This note itself may be a subsequent uncommitted documentation change until it is committed.
