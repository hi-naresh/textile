# Stock regression tests

Lot status work: incoming Packed receipts, outgoing Running / End status, derived lot status (P → R → E), closing lots, hiding closed lots, editing / reopening and the register backfill (issues #3–#7).

Issue #27 supersedes the earlier supervisor End and section-total policy. `supervisor-access.test.ts` verifies read-only access to all open lots, absence of totals, denial of business writes/chat, and challan captures waiting for owner confirmation. It creates and drops a fresh local database and requires the local test role to have `CREATEDB`. Capture extraction uses the existing local mock OCR with external AI keys cleared; only the post-response photo-storage task is stubbed. No production services are contacted.

Use a disposable **local** PostgreSQL database with a name ending in `_test`. The suite refuses other database URLs and never loads the project's `.env`. It creates its own lots, users and sessions and removes them afterwards; the access switches it changes are put back.

```sh
DATABASE_URL=postgresql://localhost/textile_stock_test node scripts/migrate.js
DATABASE_URL=postgresql://localhost/textile_stock_test npm run test:stock
```

`scripts/migrate.js` reads `.env`, where `MIGRATION_DATABASE_URL` wins over `DATABASE_URL`. Unset it (or set it to the same local URL) before migrating a test database.
