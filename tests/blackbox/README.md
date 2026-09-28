# Black-box tests (Phase 2)

Written by independent test agents that **never saw the source code** — only `SPEC.md` (business rules)
and `INTERFACE.md` (endpoint names). Expected values come from the spec, not from the app.

Run against a server with a **throwaway database** (they create lots of data; never point at production):

```bash
DATABASE_URL=postgresql://…/textile_test npm run db:init && npm run db:seed-demo
npm run build && npx next start -p 3000
BASE_URL=http://localhost:3000 node tests/blackbox/api/suite.mjs      # stock, sales, allocation, dispatch, agents, chat
BASE_URL=http://localhost:3000 node tests/blackbox/api/new.mjs
BASE_URL=http://localhost:3000 node tests/blackbox/money/suite.mjs    # GST, payments, credit, costing, docs, reports, access
BASE_URL=http://localhost:3000 node tests/blackbox/money/suite2.mjs
```

Last results (28 Sep 2026): API 214 pass / 0 fail / 11 ambiguous · Money 269 / 0 / 15 · UI (Playwright, desktop + phone) 41 / 0 / 4.
"Ambiguous" = the spec doesn't decide the outcome; see each `results.json`.
