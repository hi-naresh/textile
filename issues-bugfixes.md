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
  - Stock import validation and fix-file export: 60 requests per minute each by default.
  - Stock import chunk commits: 300 requests per minute by default.
  - Stock, invoice, and report data exports: 60 requests per minute each by default.
- Throttled requests receive HTTP 429, a clear message, and a `Retry-After` header.
- Added migration `scripts/migrations/017_api_rate_limits.sql`; it has been applied to the disposable local test database. It must also be applied to the intended deployment database before deploying this code.

### Test and measurement tooling

- Added disposable-local-database-only fixture generation and reconciliation scripts. They require a localhost database whose name ends in `_test`, do not load `.env`, and support explicit cleanup by run ID.
- Added stress regression tests for chunk rollback, 20 simultaneous same-batch import retries, lost-response retries, rate limiting, 500 simultaneous ledger edits, malformed imports, formula-like export data, and concurrent exports.
- Added writer benchmarks for one million generated lot and invoice rows, plus a report benchmark for a one-million-movement database fixture.
- Results and caveats are recorded in [the stress-test report](./docs/stress-test-report.md); local run instructions are in [the stress test README](./tests/stress/README.md).

## Original verification (commit `62d0f30`)

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

## Follow-up implementation and verification — 2026-10-30

The implementation was committed in `2e2251c` and merged by PR #25. Current verification uses checkout `483b30a`, which also includes the subsequent quality-catalog work.

- **Consistent exports:** Stock challans, lots, invoices and report queries now share a PostgreSQL repeatable-read snapshot per export. Concurrent edits/deletes cannot change later pages. Cancellation, preparation errors and writer errors release the connection. Streamed snapshots have a five-minute deadline and 60-second statement/idle-transaction limits.
- **Invoice tracking:** Export markers and the audit write share the invoice snapshot transaction. A concurrent invoice edit/delete (including another export updating the same markers) may cause a serialization conflict; the download fails and markers roll back. Retry the entire download. A swallowed SQL error cannot turn a rolled-back transaction into a successful response.
- **Pool capacity:** Long import transactions and export snapshots use a per-process queue, capped at half the database pool (at least one slot). Waiting operations do not hold connections. Queue waits expire after 60 seconds with a retryable 503. This preserves capacity for authentication and ordinary reads; it is not a cross-instance concurrency limit.
- **Import recovery:** The client retries truncated/invalid success acknowledgements and checks cancellation before retrying. Tests reopen the same 1,001-row workbook after each of its three chunk boundaries, replay lost responses, and verify that no rows are duplicated.
- **Deployment checks:** `npm run db:check` verifies all migration records plus the rate-limit table and primary key using an explicitly selected database. The CLI migrator uses the runtime migrator's advisory lock and verifies the resulting schema. `SKIP_DOTENV=1` prevents unintended environment-file loading for explicitly targeted runs.
- **Rate policy:** All six per-minute budgets can now be overridden with the `API_RATE_LIMIT_*` variables in `.env.example`. Defaults are unchanged. Invalid, zero and excessive values are rejected. Keep values identical across instances.
- **Workload tooling:** `stress:import-workload` measures authenticated local route handlers with validation, commits, reads and exports; it reconciles and removes its fixtures. `stress:http` provides an explicit-target, dry-run-first staging driver. Instructions are in [the README](./tests/stress/README.md).

Current checks:

- **88/88 regression tests passed:** 44 stress and 44 stock tests on the migrated disposable local database.
- TypeScript and the production build passed; lint passed with the same 15 unrelated blackbox warnings; route-auth check passed for 144 handlers. The sandboxed build stalled and was stopped; the normal build rerun completed successfully.
- The staging HTTP driver passed a dry-run input check without network requests.
- The final 20-user local workload imported **20,000 rows**, completed **200/200 requests successfully**, and reconciled all balances. Read-during-import p95 was **47 ms**; 500-row commit p95 **10,085 ms**, export p95 **6,286 ms** (both include queueing). Fixtures were removed.
- Before admission control, the same 20-user workload produced **11 HTTP 500 responses** from pool timeouts. The successful rerun verifies that specific fix; it is not a hosted performance guarantee.
- A prior single-user 20,000-row application import completed in **14.7 seconds**, including five validations and concurrent read/export probes. A five-user run imported 5,000 rows without errors. Full measurement details and memory caveats are in [the stress report](./docs/stress-test-report.md).

## Review follow-up — remote schema, reset, failure injection and isolation

Reviewed the original [issue #14 specification](https://github.com/hi-naresh/textile/issues/14), `DEPLOY.md`, and the supported reset routes. The earlier summary overlooked the existing owner/developer Reset Data workflow: it is a supported bulk-removal operation even though there is no arbitrary movement-delete API.

Completed in this follow-up:

- **Remote schema verified:** The Supabase application database configured in this workspace passed a read-only check of all repository migration records, the rate-limit columns and its primary key. No remote data or schema was changed. The standard schema-check CLI initially failed TLS certificate validation; it now shares the existing migrator connection settings, enforces read-only transactions and passes against that connection. Vercel project-to-database mapping is not yet verified because the hosting connection is unavailable.
- **Reset correctness fixed:** Stock reset now includes `lot_closures` in its backup, counts and truncate set. Previously the foreign key from that table prevented stock truncation. Reset backups respect download backpressure and release snapshots/locks on cancellation. Locks are taken before the backup starts so a concurrent stock reset cannot truncate a table not yet exported.
- **Failure reporting fixed:** `withTransaction` rejects PostgreSQL's `ROLLBACK` response to a `COMMIT` after a swallowed SQL error. Reset sequence restarts are transactional, so a failed audit write restores both rows and sequence state instead of reporting success or changing future IDs.
- **Real database failures tested:** The tests terminate their own PostgreSQL backend after a chunk write, verify rollback, and retry without duplicates. Another test terminates the snapshot connection during a slow download, verifying that the writer fails and releases its slot. Checked-out connection errors are now handled explicitly.
- **Bulk removal measured:** In a newly created, isolated local database, **1,000,000 movements** reconciled to **333,334 m** before reset. The complete backup streamed **589,729,789 bytes** in **2,285 ms**; reset removed **1,000,002 stock/history records** in **378 ms**, retained the owner, and wrote one reset audit record. Counts, derived stock tables and balances were checked, then the isolated database was dropped. This measures the existing confirmed reset workflow, not selective deletion or a hosted endpoint.
- **Firm isolation reviewed and tested:** `DEPLOY.md` already specifies one Vercel project and Supabase database per firm. A local two-database regression uses identical lot/user IDs, verifies distinct data under concurrent reads, and rejects the other database's session token. Shared-database tenancy/RLS was not added; hosted project/credential separation still needs verification.
- **Staging driver hardened:** It rejects fixture lots with existing movements, validated rows belonging to a different lot, partial/reused imports, and non-XLSX export responses. A local authenticated smoke run passed and cleaned its fixture.

**Final verification:** 112/112 tests passed (52 stress, 44 stock, 16 chat). TypeScript and the production build passed. Lint passed with 15 pre-existing unrelated warnings; route-auth checked 144 handlers. All newly created reset/benchmark/isolation databases were removed. The changes are local and have not been deployed.

The reset test/benchmark utilities create fresh local databases rather than resetting the shared test database. They require a local `_test` parent connection, apply repository migrations in the new database, and drop only that newly created database after closing their connections.

## Remaining acceptance work and scope

Issue #14 is **not fully accepted**. The user confirmed there is no staging environment yet. Supabase and Vercel integrations were found but are not connected; the local CLIs are also unavailable. The configured remote database was used only for read-only schema verification, never load testing.

1. **Hosted staging:** Connect Supabase and Vercel, identify/provision a disposable staging project separate from the live database, verify the deployed commit and database mapping, and run the prepared 5–20-user HTTP workloads. Collect provider function timeouts, server memory, total database connections and read latency. Never load-test production.
2. **Performance target gap:** The original issue proposes validation p95 <10 s, commit p95 <2 s, and read p95 <300 ms, with targets to confirm. The measured 20-user local commit p95 is **10.085 s**, so it does **not** meet the proposed commit target, despite zero request failures. Confirm/measure the hosted target and address contention; do not treat correctness success as performance acceptance.
3. **Remaining original-spec scenarios:** Sustained 100k–1M application imports split across files, 100k–1M audited updates in supported batches, lossless export/re-import semantics, large register/fix-file boundaries, real browser termination and provider-level outages are not all established by the existing measurements. The SQL million-row generator and million-row reset benchmark are not substitutes for those scenarios.
4. **Isolation scope:** The supported deployment model is separate databases per firm. Verify real project/credential isolation in staging. If the issue specifically requires shared-database RLS, that is a change to the product architecture and needs an explicit scope decision.
5. **Deletion scope:** The existing password-confirmed full/section reset is now tested at one million movements. Arbitrary selective movement deletion remains unsupported and needs explicit balance/audit requirements; the 500-change edit limit remains in place.
6. **Policy tuning:** Review request budgets, queue limits and export timeouts using hosted measurements. Local timings and small sample percentiles are evidence, not service-level guarantees.
