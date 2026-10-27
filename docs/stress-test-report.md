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

## Findings and remaining work

- Stock challan and lot exports use keyset pages and ExcelJS streaming writers; the previous 200,000-lot in-memory export cap has been removed. Invoice XLSX and Tally XML exports now read in keyset pages and stream output. Report exports return fixed-size summary/grouped data rather than raw movement rows.
- The volume generator uses direct SQL for 1,000–1,000,000 movements. The 20,000-row validator uses a no-data database stub, and import commit timing currently covers one 1,000-row chunk only.
- The app has no general-purpose bulk-delete API. The existing supported bulk edit is capped at 500 changes per request and is tested at that limit; arbitrary stock movement deletion remains unavailable to preserve ledger history.
- Import validation/fix endpoints are capped at 60 requests per user per minute, commit chunks at 300, and exports at 60. These fixed-window limits are stored atomically in PostgreSQL and return 429 with `Retry-After`.
- Excel output keeps formula-like values as literal string cells; Tally XML text is escaped. No CSV export exists in the covered paths.
- Local writer and paging tests do not establish p95 validation/commit latency or prove Vercel/Supabase function duration, RLS, connection, and memory limits. Those require a disposable staging environment and must not run against production.
- Keyset pagination bounds memory and excludes later invoice IDs, but a multi-page export is not a repeatable-read snapshot if existing lots, invoices, or movements are edited/deleted while it runs; that concurrency consistency case remains open.
- The current data model is a single-firm database, so per-firm RLS isolation is not a supported scenario in this application.
