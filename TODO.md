# Textile Brain — To-do (deferred)

These are parked on purpose: build them once the product flow is confirmed and the app is delivering real value, before production.

Last updated: 26 Sep 2026

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
- [ ] **Location list**: presets are Godown / Shop / Floor + free text. Do they have named godowns/shops to fix as a list?
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

## 1. Authentication (who is this person?)
Today there is no login. The role comes from the "Preview as" switch.

- [ ] Login for owner and supervisors (phone/email + password, passwords hashed)
- [ ] Worker login that works on the shop floor (e.g. short PIN on a shared or personal phone) — *decide*
- [ ] Secure session cookie (httpOnly, sameSite), logout, session expiry
- [ ] Link `users` to `workers` (a worker login must map to one `workers.id`)
- [ ] Add a password/PIN column to `users` (schema change + migration)
- [ ] Remove "Preview as" from production (keep for development only)

## 2. Authorization (what may this person see and change?)
Rules exist in `src/lib/access.ts` but only the screens apply them.

- [ ] Check role + section in every API route (`/api/stock`, `/api/job-cards`, `/api/capture`, `/api/capture/confirm`, `/api/workers`, `/api/chat`)
- [ ] Filter data on the server by role (supervisor: own sections only; worker: own records only; ₹ values owner only)
- [ ] Take `confirmed_by` / chat `user_id` from the session, not from the request body (audit trail can be faked today)
- [ ] Move supervisor → section mapping from code into the database (editable by owner)
- [ ] Owner screen to add/disable users and assign sections ("Users, roles & sections" in the matrix)

## 3. Security and data safety
- [ ] Chat: run AI-generated SQL with a separate **read-only** database user
- [ ] Chat: block `SELECT … INTO` and system functions; add row limit and query timeout
- [ ] Chat: scope questions by role (supervisor = meters only, own sections)
- [x] Fix transactions for stock, job cards and photo confirm (now `withTransaction` in `src/lib/db.ts`)
- [ ] Validate uploads (file type, size limit) on `/api/capture`
- [ ] Move `DATABASE_URL` / `GEMINI_API_KEY` to proper secrets for production
- [ ] Rate-limit login and chat endpoints

## 4. Data model gaps
- [ ] Rates table (₹ per meter by quality/party) — replaces the owner's per-device "average rate"
- [ ] Record which worker/device took each photo (`capture_events.captured_by`)
- [ ] Record who moved a lot from the session (today `moved_by` comes from the browser)
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
- Languages needed on every screen, or only worker screens?
