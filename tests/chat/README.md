# Chat regression tests

Use a disposable **local** PostgreSQL database with a name ending in `_test`. The suite refuses other database URLs and never loads the project's `.env`. It creates synthetic fixtures and removes them afterward.

```sh
DATABASE_URL=postgresql://localhost/textile_chat_test node scripts/migrate.js
DATABASE_URL=postgresql://localhost/textile_chat_test npm run test:chat
```

The 16 tests cover authenticated handlers, persistence and clearing, concurrent requests, idempotent retries, abandoned turns, pagination, access isolation, language preferences, date boundaries, scoped data tools, app help, safe Markdown and market-name/code stock filtering after merging main. Gemini is disabled except for a simulated tool exchange; no test payload is sent externally.

Live response quality in Gujarati/Hinglish and speech on physical phones require separate acceptance checks. Desktop and mobile Chrome were checked on 9 Oct 2026 against a production build with synthetic local records: reopening, reloading, follow-ups, help links and New chat passed.
