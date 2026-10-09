# Textile Brain — To-do (deferred)

These are parked on purpose: build them once the product flow is confirmed and the app is delivering real value, before production.

Last updated: 9 Oct 2026

---

## Chat assistant rebuild — implemented 9 Oct 2026

- [x] **Actionable answers:** data tools return named job cards, lots, workers, processes and age, with links to permitted screens. Cards open 7+ days prompt a progress check; no invented overdue deadline.
- [x] **Language and script:** romanised Gujarati and Hinglish are detected, explicit language choices persist, and the model receives matching script/tone instructions. Undated totals use all recorded dates; digits remain 0–9.
- [x] **Conversation memory:** the server supplies the latest 10 turns plus bounded older context; the model summarizes older turns when available.
- [x] **Formatting:** safe Markdown lists, bold text and tables, with working role-checked app links and readable job-card details.
- [x] **Conversational assistant:** Gemini receives history and validated read-only data, app-help and firm-policy tools. Fixed queries still enforce permissions; no AI-written SQL. A limited fallback works when AI is unavailable.
- [x] **Saved chat:** per-user, per-access-scope server history, pagination and New chat. Request IDs, revisions and leases protect retries, concurrent tabs and interrupted turns.
- [x] **App help:** plain-language instructions alongside the feature catalog, filtered by role/capability; firm notes stay separate. Empty chat explains what users can ask.

Validation and rollout:

- [x] 16 repeatable regression tests: persistence, reset, retries, concurrent turns, expired leases, scope isolation, language preferences, date boundaries, help, Markdown, authenticated handlers and simulated model/tool exchanges. Run `npm run test:chat` with a disposable local `DATABASE_URL` ending in `_test` (see `tests/chat/README.md`).
- [x] Desktop and mobile Chrome checks against a production build: close/reopen, reload, follow-up help, navigation links, New chat and clearing across reloads.
- [x] Migration `012_chat_conversations.sql` applied successfully on an isolated PostgreSQL database.
- [x] TypeScript, lint and production build pass; lint retains 15 existing warnings in older black-box test files.
- [ ] **Live Gemini acceptance:** run the reported Gujarati/Hinglish examples with the configured service. Local model/tool simulation passes; live service testing is deferred at the user’s request to keep testing local.
- [ ] **Configured database migration:** read-only inspection on 9 Oct confirms migration `012` and both chat tables are absent. Apply the tested migration when rolling out this change; it is included in the normal build/start migration flow. No deployment performed.
- [ ] Check speech recognition and spoken replies on the firm's actual phones; browser validation above covers typed chat.

---

## Discussed changes — 27 Sep 2026 (Phase 1 built, Phase 2 = agents)

### Done — Phase 1
- [x] Demo/test accounts: `npm run db:seed-demo` → owner, 1 supervisor (Ramesh Patel), 1 worker (Suresh Rathod, linked to a worker record), 3 sample lots, 2 job cards, 3 knowledge notes. Never drops data; refuses non-local DBs unless `ALLOW_DEMO_SEED=1`
- [x] Capture rights: owner any; supervisor incoming + outgoing challans; worker job card (cut) only — also checked by `/api/capture`
- [x] Worker sees only Capture + Settings (theme/language)
- [x] Owner Compact / Detailed switch in the header (Compact hides charts, sections table and detail columns)
- [x] Floating chat pop-up with voice input (right side, above the bottom nav on phones); Ask tab removed
- [x] Theme + language moved into Settings → Preferences (all roles); header theme button removed
- [x] Floating rounded bottom nav on phones
- [x] Verbose scope labels removed (scope card, "Viewing all sections", "Every answer audited", lock notes)
- [x] Challans: S.No column + Excel export (challans / lots); manual stock Excel import with template, all-or-nothing, row errors
- [x] Fixed location list only (no free text); strict formats for lot/challan numbers and meters; canonical spellings for mill/weaver/party/quality/design
- [x] Decision layer for photos: Google Vision OCR + deterministic parser with arithmetic cross-checks → low-tier LLM on OCR text → high-tier vision LLM
- [x] Chat: fixed parameterised query templates (no AI-written SQL) + firm knowledge notes (full-text search + low-tier LLM)
- [x] LLM/OCR usage + cost log (`llm_usage`), developer endpoint `/api/dev/usage`
- [x] Raw photo used only for reading; compressed WEBP (≤1600 px) stored in `YYYY/MM/DD` folders by a background job
- [x] Time saved vs manual baseline (Settings → Rules) as an Overview KPI

### Done — 28 Sep follow-ups
- [x] Phones: no pinch / double-tap zoom (viewport + iOS gesture block + 16px inputs); "Add to Home Screen" opens full-screen
- [x] Bottom nav sits lower on iPhone (inside the home-indicator area) and is fully rounded
- [x] Phones: no floating chat — chat icon next to the profile in the top bar opens a full-screen chat; desktop keeps the round button
- [x] Voice mode: hands-free loop (listen → answer out loud → listen again) plus one-shot dictation
- [x] Owner home "Right now": on the floor, dispatched today, received today, activity feed
- [x] Stock flow: Today (hourly) / Week / Month / Year / All years, quality filter, demand by quality
- [x] Preview-as role, supervisor/worker picker and Compact/Detailed moved to Settings → View (header is clean)
- [x] `npm run db:seed-demo -- --history` adds 2 years of sample movements for the charts

### Done — 28 Sep voice + language
- [x] Voice mode like ChatGPT: always listening (no pause / tap-to-talk), mute + end buttons, tap the orb to interrupt; every turn shows in the chat
- [x] Answers in the language of the question (English / Hindi / Gujarati, script or romanised). Templates understand Hindi/Gujarati words without AI; the reply is translated by the low-tier model (needs GEMINI_API_KEY — without it replies stay English)
- [x] Voice mode switches its listening language to the one you last spoke
- [x] Phone: chat slides down from the top, close (×) slides it back up

### Done — 28 Sep chat coverage + phone voice
- [x] Chat "semantic layer": counts / sums / % by worker, section, quality, party, mill, lot, location, day, month with filters and periods — compiled to parameterised SQL from a fixed catalog (no AI-written SQL). Answers "how many workers / supervisors", "who folded how much today", "dispatch by party this month", "efficiency by section", "how many workers per section", etc. without AI
- [x] "What's happening today?" briefing (floor, completed, dispatched, received, workers with work, reads waiting)
- [x] Unmatched questions: the low-tier model picks a template or a catalog query (still no SQL)
- [x] Mic + voice buttons always visible; on an http:// Wi-Fi link they explain that phones need https (`npm run tunnel`)
- [x] Voice fallback for browsers without speech recognition (iPhone home-screen app): records the mic, the server transcribes (`/api/chat/transcribe`, logged as voice.stt)

### Check / tune after first real use
- [ ] **Set real keys**: `GOOGLE_VISION_API_KEY`, `GEMINI_API_KEY`; set `LLM_PRICE_*` / `OCR_PRICE_PER_IMAGE` to the current Google price list (defaults are estimates)
- [ ] Test the OCR parser on 20–30 real photos of each layout (cutting report, dispatch challan). Only the "Job Card/Cutting Report" layout has a dedicated parser; dispatch challans go through a generic reader and usually reach the LLM
- [ ] Tune `OCR_MIN_CONFIDENCE` (default 0.75) and the auto-confirm % once corrections data exists (`/api/dev/usage` → captureEngines)
- [ ] Owner to confirm the manual baseline minutes (defaults 6 min per challan, 4 per job card)
- [ ] Voice input works in Chrome/Edge/Android; Safari/iOS support is partial — check on the phones the firm uses
- [ ] Language setting translates the capture screen + voice; other screens are English only — decide if more is needed
- [ ] Excel import posts every row with today's date — add a Date column if they want to back-fill history
- [ ] Old photos saved before this change stay where they were (no re-compression)
- [ ] **Timezone**: "today" uses the database date. Supabase runs in UTC, so between 00:00 and 05:30 IST "today" is still yesterday. Fix before go-live: store `timestamptz` and compute days in Asia/Kolkata (needs a careful migration of existing rows)
- [ ] Extend the chat catalog as new questions come up (add a metric in `src/lib/chat/semantic.ts`); review `chat_audit` for questions that fell through to "help"
- [ ] Voice mode on iPhone: speech recognition needs Safari 14.5+ and mic permission each session; test on the owner's phone
- [ ] Gujarati speech: Chrome/Android support gu-IN recognition and voices; iPhone has no Gujarati text-to-speech voice (reply shows on screen, spoken voice may fall back). Consider Google Cloud TTS for Gujarati if needed

### Phase 2 — agents (built 28 Sep 2026)
- [x] Master data: parties (GSTIN checked), selling rates (per quality, party overrides), process costs, billing & GST, agent thresholds — Settings
- [x] Inquiry agent: reads pasted/typed inquiries (en/hi/gu, rule-based; AI only if fields missing), checks free stock + rate, drafts the reply (WhatsApp link)
- [x] Order agent: orders, due/overdue alerts; Allocation agent: reserves lots (FIFO), one-tap "Allocate" suggestions
- [x] Logistics agent: every dispatch (manual, photo, import, dispatch screen) links to its order automatically, or asks which order
- [x] Documents: delivery challan, packing list, GST tax invoice, party statement (PDF); Tally export (Excel + TallyPrime XML); record invoices made in Tally
- [x] Credit agent: outstanding, ageing, overdue / over-limit alerts, reminders (en/hi/gu), credit warning before dispatch
- [x] Costing agent: lot cost (purchase + process + shortage), margin by order/party/quality/lot, low-margin & missing-rate alerts
- [x] Inventory agent: low stock, short for orders, ageing stock, missing location, mill loss; days of cover
- [x] Reports agent: day/week/month report with comparisons + Excel; daily/weekly "report ready"
- [x] Alerts + one-tap actions in "Needs your attention" (owner) and on the Floor screen (supervisor); chat answers orders / outstanding / invoiced / collected / free stock
- [ ] Owner to fill Billing & GST, rates and process costs with real values; check the first real invoice against Tally
- [ ] PDFs use a Latin font: Gujarati/Hindi party names print as "?" — add a Noto font if needed
- [ ] Tally XML is accounting-only (no stock items); ledger names fixed (Sales, CGST/SGST/IGST Output, Round Off) — confirm with the accountant
- [ ] Duplicate challan numbers are checked in code only; add a unique index if two people dispatch at the same moment
- [ ] Reports "overdue orders" for past periods use today's status (no status history)
- [ ] Not doing: supply-chain visibility, quality/inspection, production agents
---

## Review — 26 Sep 2026 (field & workflow gap review)

### Done — §1 new fields (built 26 Sep)
- [x] Grey meters and finished meters stored separately on incoming stock
- [x] Mill name and weaver name as separate fields ("Same as mill" shortcut)
- [x] Party = destination client on outgoing stock only (required); incoming no longer uses party
- [x] Lot location with full history: set on arrival, → Floor on job card, → Godown when the last card closes, → Dispatched when fully sent out, plus manual moves
- [x] AI photo reading, review queue and chat updated for the new fields
- [x] Run `npm run db:migrate` on existing databases (adds the columns + `lot_locations` table)

### Check with the owner
- [ ] **Which meters count as stock?** Built as: finished meters if known, else grey. Confirm this matches how they count.
- [ ] **Old lots have no location** ("Not recorded"). Set them once from Stock ledger → Lots & balance → Move.
- [x] **Location list**: fixed list only now (Settings → Lot locations). Owner to add their named godowns/shops there.
- [ ] Old incoming entries keep their supplier in `party` (shown as "old entry"); decide if these should be moved into mill name.

### §2 Parked — ask the owner first
- [ ] **"L option"** — meaning unclear (possibly "Length"). Ask the owner directly before building anything.

### §3 Architecture decision — needs owner sign-off
- [ ] Mill / weaver / party master data may live in an existing Windows textile ERP (Tejtantra-style), no API.
- [ ] Proposed: copy that master data into our own database and treat the old ERP as legacy.
- [ ] Decide: one-time migration + cutover, or run both in parallel for a transition period.
- [ ] Until decided, mill / weaver / party are plain text with suggestions from past entries (no master tables yet).

### §4 Workflow gaps — decision round before building
1. [ ] Split / partial incoming deliveries (one challan → many lots/qualities; partial shipment against one order)
2. [ ] Quality grading — who grades, when, and reconciling with what the challan claims
3. [ ] Returns & rejections — reverse flow for client returns and disputed shortages
4. [ ] Dispatch & packaging — parcel / packing list bundling partial quantities from several lots
5. [ ] Chain job cards across stages (weaving → dyeing → folding) so a defect traces back to its stage and worker
6. [ ] Wages — rate table turning meters completed into worker pay (still on paper)
7. [ ] Offline conflict rule — two conflicting offline updates to the same lot
8. [ ] Full per-lot audit trail — one history view of everything that happened to a lot (location history is a first step)
9. [ ] Review-queue owner and turnaround time for low-confidence AI reads
10. [ ] Units & names — meters vs yards, and one spelling per quality/mill/party so reports don't split

---

## Selling to other firms (26 Sep 2026)
Decision: **one copy per firm** (own install + own database). Nothing firm-specific is in the code.

- [x] Owner-only **Settings** screen: firm name & city, owner name, supervisors + their sections, workers, sections, lot locations, rules (shortage %, efficiency %, AI auto-confirm %)
- [x] Settings stored in the database (`app_settings`, `sections`, `supervisor_sections`, `users`, `workers`)
- [ ] New firm's copy: delete `scripts/migrations/003_setup_narmada_group.sql` (Narmada-specific), start the app, then fill in Settings
- [ ] Remove the demo seed data (`scripts/db-init.js`) for a real new firm, or add a "start empty" option
- [ ] Later: one shared server for many firms (firm_id on every table, sign-up per firm) — needs login first

---

## 1. Authentication (who is this person?) — built on branch `auth` (migration 006)
- [x] Phone number + password for owner / supervisors / workers; email + password for the developer (separate `/dev/login`)
- [x] Passwords hashed (scrypt); starting password `12345678` only for created/reset accounts, must be changed at first sign-in
- [x] Server-side sessions (`auth_sessions`): httpOnly + Secure + SameSite cookies, 15-min access token + rotating refresh token, sliding 60-day client / 12-h developer sessions, logout
- [x] Sign up → pending → owner approves + assigns role (supervisor / worker); rejected numbers may retry 3 times
- [x] Owner: deactivate / reactivate, change role, reset password, see + end sessions per user (immediate sign-out)
- [x] "Preview as" removed; developer "View as" (read-only by default, banner, every call logged)
- [x] Developer console `/dev`: health, connections, AI usage + cost, technical errors, users, audit trail
- [x] Link `users` to `workers` (`users.worker_id`, migration 004)
- [x] Installable app manifest (home-screen app keeps its sign-in)
- [ ] OTP (SMS / WhatsApp) — later; passwords only for now
- [ ] App icons 192 px + 512 px for the Android install prompt (only 180 px exists)
- [ ] Offline / service worker (not needed for sign-in)

## 2. Authorization (what may this person see and change?)
- [x] Every API route checks the session + capability on the server (`src/lib/apiAuth.ts`); `npm run lint` fails on an unchecked route
- [x] Take `confirmed_by` / `moved_by` / `captured_by` / chat `user_id` / `created_by` from the session, never the request body
- [x] Workers get only their own job cards, photos and worker record; no stock / efficiency data
- [ ] Supervisor section scoping is still applied by the screens for job cards / review queue (chat is scoped on the server) — move to the server
- [x] Supervisor → section mapping in the database (editable by owner)

## 3. Security and data safety
- [x] Chat: no AI-generated SQL any more (fixed templates only)
- [ ] Chat: still run templates with a separate **read-only** database user + statement timeout
- [x] Chat: scope by role (supervisor = own sections for job cards / shortage / efficiency; workers can't chat)
- [x] Fix transactions for stock, job cards and photo confirm (now `withTransaction` in `src/lib/db.ts`)
- [x] Validate uploads (file type, size limit) on `/api/capture`
- [ ] Move `DATABASE_URL` / `GEMINI_API_KEY` to proper secrets for production
- [x] Rate-limit login (5 wrong passwords per phone/email → 15-min pause) and sign up (10 per network per hour)
- [ ] Rate-limit chat
- [ ] Local development photos in `public/uploads` are served without sign-in (production uses the private Supabase bucket)

## 4. Data model gaps
- [ ] Rates table (₹ per meter by quality/party) — replaces the owner's per-device "average rate"
- [x] Record which worker took each photo — `capture_events.captured_by` from the session
- [x] Record who moved a lot from the session
- [ ] Stop allotting more meters than a lot's balance (today the API allows it)
- [ ] Shift stored with efficiency records (history currently has no shift)

## 5. Production readiness
- [ ] Error monitoring and structured logs
- [ ] Database backups
- [ ] Deployment setup (hosting, HTTPS, domain)
- [ ] Basic tests for stock balance, shortage, confirm flow and permissions

---

## Open product decisions (need answers before building the above)
- How do workers sign in on the floor — own phone, shared tablet, or supervisor enters for them?
- Can a supervisor cover more than one section / swap sections per shift?
- Who can confirm stock IN/OUT photo reads — owner only, or a stores/dispatch supervisor?
- Should workers be able to mark a job done without a photo?
- Which ₹ numbers matter to the owner (stock value, shortage loss, party-wise), and where do rates come from?
- Languages needed on every screen, or only worker screens? (Settings now has one language switch; only the capture screen + voice use it)
