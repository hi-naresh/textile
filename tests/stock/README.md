# Stock regression tests

Lot status work: incoming Packed receipts, outgoing Running / End status, derived lot status (P → R → E), closing lots, hiding closed lots, editing / reopening and the register backfill (issues #3–#7).

Issue #27 supersedes the earlier supervisor End and section-total policy. `supervisor-access.test.ts` verifies read-only access to all open lots, absence of totals, denial of business writes/chat, and challan captures waiting for owner confirmation. It creates and drops a fresh local database and requires the local test role to have `CREATEDB`. Capture extraction uses the existing local mock OCR with external AI keys cleared; only the post-response photo-storage task is stubbed. No production services are contacted.

Issue #28 is covered by `import-review.test.ts`: blank/A/unknown choices, exact file and row matching, owner binding, expiration, immutable confirmation, ordered chunk retries, End with later sales, and rollback of a failed chunk. It creates a fresh database with all migrations (including `018_import_reviews.sql`) and uses real XLSX files and API handlers. The review component is server-rendered for content checks; this is not a browser interaction test. No stock is written by validation or confirmation; only review metadata is stored until commit.

Use a disposable **local** PostgreSQL database with a name ending in `_test`. The suite refuses other database URLs and never loads the project's `.env`. It creates its own lots, users and sessions and removes them afterwards; the access switches it changes are put back.

```sh
DATABASE_URL=postgresql://localhost/textile_stock_test node scripts/migrate.js
DATABASE_URL=postgresql://localhost/textile_stock_test npm run test:stock
```

`scripts/migrate.js` reads `.env`, where `MIGRATION_DATABASE_URL` wins over `DATABASE_URL`. Unset it (or set it to the same local URL) before migrating a test database.


Five-issue batch (#18, #21, #23, #29, #30): `entry-batches.test.ts` covers automatic/custom NQTY across writes/imports/edits, a reviewed and audited backfill, incoming SR/weaver search, closure history plus owner-only reopening, keyboard dates and rejected invalid dates. It uses a fresh disposable database, applies all migrations, and drops it afterwards.

Existing NQTY corrections use an explicit database target and default to a dry run:

```sh
DATABASE_URL=<intended-database-url> npx tsx scripts/backfill-billed-meters.ts
# After reviewing the exact list and its fingerprint:
DATABASE_URL=<same-database-url> npx tsx scripts/backfill-billed-meters.ts --apply --confirm-reviewed <fingerprint> --by <owner-user-id>
```

The correction writes only missing NQTY on normal outgoing rows with L, uses two decimals, and logs each change. Typed values remain unchanged. Editing QTY/L treats an existing NQTY equal to the old formula result as calculated; an explicitly typed value equal to that result cannot be distinguished without a provenance flag.

Browser acceptance for the same batch is in `tests/blackbox/entry-batches.mjs`. It runs the production build in an isolated local server on port 3157, creates/drops its own database, uses the installed macOS Chrome with `en-IN`/Asia-Kolkata, and checks laptop (1366×768) and phone (390×844) layouts. Set `PLAYWRIGHT_PACKAGE_JSON` to a package.json whose node_modules contains Playwright if it is installed outside this repository. It does not emulate the Windows OS.

```sh
DATABASE_URL=postgresql://localhost/textile_stock_test PLAYWRIGHT_PACKAGE_JSON=/tmp/textile-browser-check/package.json node --import tsx tests/blackbox/entry-batches.mjs
```
