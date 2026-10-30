# Import/export stress testing — baseline

## Scope and environment

This baseline measures synthetic `stock_movements` inserted in 10,000-row SQL batches into the disposable local PostgreSQL database `textile_stock_test`. Database triggers and indexes were active. The run did not call the application import or export APIs, and does not represent Vercel, Supabase, or multi-user performance.

All generated rows were reconciled against the lot's stored incoming, outgoing, and balance totals. Every run reported zero mismatches, and each fixture was removed after verification. No production or staging data was used.

## Results

| Synthetic movements | Generation time | Approx. throughput | Reconciliation |
|---:|---:|---:|---|
| 1,000 | 24 ms | 41,000 rows/s | Passed |
| 10,000 | 431 ms | 23,200 rows/s | Passed |
| 20,000 | 557 ms | 35,900 rows/s | Passed |
| 100,000 | 2,598 ms | 38,500 rows/s | Passed |
| 1,000,000 | 29,811 ms | 33,500 rows/s | Passed |

These are single-run local fixture-generation measurements, not p95 application import or export timings.

Additional local regression coverage passed:

- The import validator accepts exactly 20,000 rows and rejects 20,001 before database lookups.
- A failed multi-row chunk rolls back rows processed earlier in that chunk.
- Twenty concurrent retries for the same import batch save a row once; an injected database failure after a write rolls back its whole chunk; a lost client response retries without duplicating its committed row. 429 and 5xx responses are retried by the client, while 422 is not.
- Malformed workbooks, wrong sheets, empty templates, Unicode, and overlong text cells are handled as clear validation results.
- Keyset stock and invoice exports preserve row order; authenticated challan and lot export routes stream readable XLSX files; ten simultaneous stock exports completed without dropping rows.
- A maximum-size 500-field ledger edit completed atomically, created all 500 audit records, and kept the lot balance consistent.
- A PostgreSQL-backed per-user rate limit was verified under 20 simultaneous requests: only the configured five were accepted, and blocked requests returned HTTP 429 with `Retry-After`.
- Two real 1,000-row commits completed in 1,079 ms and 1,087 ms; each same-batch retry skipped all 1,000 rows, and the final balance matched the expected 1 meter. These are local single-run measurements, not p95.
- A 1,000,000-row challan XLSX streamed completely to a counting sink: 102,842,929 bytes in 39,120 ms, with a sampled Node heap peak of 119,191,080 bytes. The resulting fixture reconciled and was removed. This measures the local writer path, not the hosted API/function timeout.
- The lot XLSX writer streamed 1,000,000 synthetic lots in 6,714 ms (34,208,000 bytes; sampled heap growth about 20 MB). The Tally XLSX writer streamed 1,000,000 synthetic invoices in 15,675 ms (60,204,083 bytes; sampled heap growth about 26 MB). These measure the workbook writers, not the database query or hosted endpoint.
- Against a real one-million-movement local fixture, the owner daily report completed in 855 ms and its 16,046-byte workbook's closing balance matched an independent database sum (333,334 m). The fixture reconciled and was removed afterward.

## Findings at the original baseline (superseded where noted below)

- Stock challan and lot exports use keyset pages and ExcelJS streaming writers; the previous 200,000-lot in-memory export cap has been removed. Invoice XLSX and Tally XML exports now read in keyset pages and stream output. Report exports return fixed-size summary/grouped data rather than raw movement rows.
- The volume generator uses direct SQL for 1,000–1,000,000 movements. The 20,000-row validator uses a no-data database stub, and import commit timing currently covers one 1,000-row chunk only.
- The app has no general-purpose bulk-delete API. The existing supported bulk edit is capped at 500 changes per request and is tested at that limit; arbitrary stock movement deletion remains unavailable to preserve ledger history.
- Import validation/fix endpoints are capped at 60 requests per user per minute, commit chunks at 300, and exports at 60. These fixed-window limits are stored atomically in PostgreSQL and return 429 with `Retry-After`.
- Excel output keeps formula-like values as literal string cells; Tally XML text is escaped. No CSV export exists in the covered paths.
- Local writer and paging tests do not establish p95 validation/commit latency or prove Vercel/Supabase function duration, RLS, connection, and memory limits. Those require a disposable staging environment and must not run against production.
- Keyset pagination bounds memory and excludes later invoice IDs, but a multi-page export is not a repeatable-read snapshot if existing lots, invoices, or movements are edited/deleted while it runs; that concurrency consistency case remains open.
- The current data model is a single-firm database, so per-firm RLS isolation is not a supported scenario in this application.


## Application follow-up — 2026-10-30

The implementation now uses repeatable-read snapshots for exports, deployment-configurable rate budgets, explicit schema checks, and import recovery for malformed success acknowledgements. The current local regression run passed **88/88 tests** (44 stock + 44 stress). TypeScript, production build and route-auth checks passed; lint retained 15 pre-existing unrelated warnings. The staging driver passed a dry-run check without network requests. See `issues-bugfixes.md` for acceptance status and snapshot failure semantics.

### Authenticated local route-handler workloads

These runs use real PostgreSQL queries and authenticated route handlers, but bypass HTTP, the browser and the hosted runtime. Each user imports incoming movements into a unique fixture lot in 500-row chunks. Ledger reads run alongside every chunk; challan exports run on the first/last chunk and every ten chunks. Validation is repeated before committing. Percentiles are nearest-rank observations from a single run, including warm-up and queueing, not p95 guarantees. Workbook generation happens before timing.

| Workload | Validation p95 (samples) | Commit p95 (samples) | Read during import p95 (samples) | Export p95 (samples) | Elapsed | Result |
| --- | --- | --- | --- | --- | --- | --- |
| 1 user × 20,000 rows, 5 validations | 254 ms (5) | 692 ms (40) | 35 ms (40) | 783 ms (5) | 14.7 s | 20,000 rows, reconciled |
| 5 users × 1,000 rows, 3 validations each | 178 ms (15) | 2,926 ms (10) | 17 ms (10) | 40 ms (10) | 4.0 s | 5,000 rows, reconciled |
| 20 users × 1,000 rows, **before admission control** | 230 ms (60) | 11,352 ms (36) | 2,268 ms (36) | 3,103 ms (36) | 13.5 s | 11 HTTP 500s; 16,000/20,000 rows; incomplete |
| 20 users × 1,000 rows, **after admission control**, run `b2eb88f9` | 257 ms (60) | 10,085 ms (40) | 47 ms (40) | 6,286 ms (40) | 16.4 s | 200/200 HTTP-style responses successful; 20,000 rows, reconciled |

The first three measurements were taken during the initial implementation. The final run was performed on 2026-10-30 at checkout `483b30a`. All workload fixtures were removed, including the incomplete run. The failing run's percentiles include failed requests. Local runtime/database activity and small sample sizes limit comparisons.

The first 20-user run exhausted the shared connection pool while imports held transactions. Per-process admission now limits long transactions/snapshots to half the pool, reserving capacity for ordinary requests. The rerun eliminated observed timeouts and reduced read latency; commit/export waits remain substantial. A queued operation holds no database connection. Queueing is bounded at 60 seconds; streamed snapshots at five minutes. Hosted limits still require measurement.

### Sampled process memory and pool use

| Workload | Peak heap | Peak RSS | Peak pool connections | Peak pool waiting |
| --- | --- | --- | --- | --- |
| 1 × 20,000 | 427,144,088 bytes | 748,879,872 bytes | 6 | 0 |
| 5 × 1,000 | 153,264,520 bytes | 358,006,784 bytes | 10 | 0 |
| 20 × 1,000 after admission control | 267,778,736 bytes | 550,830,080 bytes | 10 | 34 |

These are 20 ms samples of the entire local Node process, including generated workbooks, request/response data and garbage awaiting collection. They are neither per-request memory requirements nor hosted-function memory measurements. Pool waiting includes transient authentication/read queries; the separate long-operation queue does not consume pool slots. Staging must assess total connections across instances and provider memory/function limits.

### Still open

No staging environment is available. The HTTP driver is prepared but has not been run against a hosted target. Deployment migration verification, hosted 5–20-user workloads with large files, realistic failure injection and latency-budget acceptance remain outstanding. Bulk deletion and multi-tenant RLS are outside the currently supported product model.


## Review follow-up: supported reset and actual connection loss

The original issue explicitly includes any supported path that removes many lots/movements. Review found the existing `/api/reset` and `/api/dev/reset` paths, so their bulk-removal behavior is now included. This does not add arbitrary ledger deletion.

Fixed stock reset's missing `lot_closures` dependency, incomplete closure-history backup, unbounded producer buffering in backups, nontransactional sequence restart, and success reporting after a swallowed SQL/audit error caused rollback. Backups now use the shared bounded snapshot lifecycle and backpressure; they acquire source-table locks before streaming. [PostgreSQL documents that sequence RESTART is transactional, unlike setval](https://www.postgresql.org/docs/current/sql-altersequence.html).

A new isolated local database was migrated from scratch for the million-row run. Generation used direct SQL in 10,000-row batches; backup/reset used authenticated route handlers with the actual password-confirmation flow. It did not use HTTP or any remote database.

| Measurement | Result |
| --- | --- |
| Synthetic movements | 1,000,000 |
| Generation time | 49,283 ms |
| Stored and independently calculated balance before reset | 333,334 m, matched |
| Backup bytes consumed without retaining the whole file | 589,729,789 |
| Backup time | 2,285 ms |
| Lot-bearing backup records | 1,000,002 (movements + one lot + one closure record) |
| Reset time including route authorization/password check | 378 ms |
| Removed stock/history records | 1,000,002 |
| Remaining stock, closure and derived stock rows | 0 |
| Reset audit records | 1 |
| Owner retained | Yes |
| Sampled process heap peak | 107,810,280 bytes |
| Sampled process RSS peak | 392,839,168 bytes |
| Isolated database cleanup | Dropped after checks |

The small reset regression parses the complete backup and checks closure history. The million-row benchmark counts fixture markers and checks completion while consuming the stream; it does not load/parse the entire JSON document. A reset-audit failure test verifies rollback of data **and** sequence state. Authentication, confirmation and password failures leave stock untouched. Cancellation releases the snapshot and table locks.

Real failure injection now terminates only a test-owned PostgreSQL backend after a chunk insert, confirms no partial rows/balance changes, then retries the same chunk twice to verify saved/skipped counts. A separate test kills a snapshot connection during a backpressured download and checks that the body, writer and connection lifecycle fail cleanly.

The supported separate-database-per-firm model is tested locally with two newly created databases, identical lot/user IDs, concurrent reads, and a foreign session token. This is not shared-database RLS testing and does not verify deployed Vercel/Supabase credential mapping.

### Remote schema evidence and remaining acceptance gaps

The remote Supabase database selected by this workspace's application connection passed the migration/rate-limit schema check in a read-only transaction. The check CLI now uses the same hosted TLS settings as the existing migrator. This verifies that configured database, not which Vercel project currently points to it. No remote mutation, load test or deployment occurred.

Original issue #14 proposes commit p95 <2 s. The local 20-user result of **10.085 s fails that proposed target**; zero errors is not performance acceptance. Hosted provider limits, realistic failure injection, the 100k–1M split-file import ladder, large audited updates, export/re-import semantics and remaining register/fix-file boundaries still need evidence or explicit scope decisions. Supabase/Vercel connections are needed to complete isolated hosted staging.

Final follow-up verification: **112/112 tests passed** (52 stress, 44 stock, 16 chat), TypeScript and production build passed, and route-auth checked 144 handlers. Lint retained the same 15 unrelated warnings. Local database inventory confirmed no remaining reset/benchmark/isolation databases from these runs. No hosted staging run or deployment was performed.
