# Deploying to Vercel + Supabase

One copy of the app per firm. Each firm gets its own Vercel project and its own Supabase database.

## What happens on every deploy
1. You push to GitHub → Vercel starts a build.
2. `npm run build` runs `scripts/migrate.js` first: it creates/updates the tables in the firm's database (only changes not yet applied; each runs once, all-or-nothing).
3. If a migration fails, the build fails and the live site stays on the previous version.
4. Then `next build` runs and the new version goes live.

No demo data is ever loaded on Vercel. `scripts/db-init.js` (demo data) is **local only** — it deletes all tables first. Never point it at a real database.

For a **test** database (e.g. staging), `npm run db:seed-demo` adds test accounts + sample lots without deleting anything. It refuses non-local databases unless `ALLOW_DEMO_SEED=1` is set.

## One-time setup (per firm)

### 1. Database — Supabase via Vercel Marketplace
- Vercel → project → **Storage → Create → Supabase**
- Region: **Mumbai (ap-south-1)** — closest to Surat
- Connect it to **Production** only
- It adds these to the project automatically (names only, values are secret):
  - `POSTGRES_URL` — pooled connection, used by the app
  - `POSTGRES_URL_NON_POOLING` — direct connection, used by migrations
  - `SUPABASE_URL`, `SUPABASE_SECRET_KEY` — used for photo storage

### 2. Photo storage
- Nothing to do. Photos go to a private Supabase Storage bucket (`capture-photos`), created automatically on the first upload.
- Photos are resized in the browser before upload (Vercel limits uploads to 4.5 MB).
- The raw photo is only used for reading. A background job then keeps a compressed WEBP copy (≤1600 px, usually 100–400 KB) in a `YYYY/MM/DD` folder. At ~500 photos a day that is roughly 3–6 GB a month — check the Supabase storage quota.

### 3. Other environment variables (Project → Settings → Environment Variables, Production)
- `GOOGLE_VISION_API_KEY` — OCR, the default photo reader (cheapest). Google Cloud → enable **Cloud Vision API** → Credentials → API key (restrict it to Cloud Vision API).
- `GEMINI_API_KEY` — AI fallback for photos OCR can't read, plus chat. Recommended.
- At least one of the two is required for photo capture. The app never invents data in production.
- `GEMINI_MODEL` (both tiers) or `GEMINI_MODEL_LOW` / `GEMINI_MODEL_HIGH` — optional (default `gemini-3.5-flash`).
- `LLM_PRICE_*`, `OCR_PRICE_PER_IMAGE` — optional; set to Google's current prices so the cost log is accurate.
- `DEV_ADMIN_EMAIL` + `DEV_ADMIN_PASSWORD` (12+ characters) — **required**: the developer account. Sign in at `https://<site>/dev/login`. Changing the password here (and redeploying) changes it and signs the developer out everywhere.
- If a key is missing/rejected or a model is retired, the developer console (**/dev → Health**) says what to fix. Client screens never show service details; workers only see that photo reading is off (capture is blocked only when neither OCR nor AI works).

### 3b. Agents (Phase 2)
- The agents scan every few minutes while the app is open, and once a day via Vercel Cron (`vercel.json` → `/api/agents/run`, 07:00 IST).
- Set `CRON_SECRET` (any long random string) so only Vercel can call the daily run.
- Owner → Settings: fill **Billing & GST** (legal name, GSTIN, address, bank) before making invoices, then **Selling rates** and **Process costs**.

### 4. Server region
- `vercel.json` pins the app to Mumbai (`bom1`), next to the database.

### 5. Sign in (see "Sign in & roles" below)
- Every page and API needs a signed-in session; the old Deployment Protection password is no longer needed.

### 6. Firm-specific setup
- `scripts/migrations/003_setup_narmada_group.sql` sets Narmada Group / Surat / Mukesh.
- **For another firm:** delete that file before the first deploy, then fill in **Settings** in the app.

### 7. First login to the live app
1. Developer: open `/dev/login`, sign in with `DEV_ADMIN_EMAIL` / `DEV_ADMIN_PASSWORD`.
2. Developer console → **Users & view as → Owner account**: enter the owner's name + phone → **Set up owner**.
3. The console shows a one-time **starting password** (random, shown once). Give it to the owner: they open the site, sign in with that phone and the starting password, then choose their own.
4. Owner → **Settings**: add sections. Supervisors and workers sign up themselves on the sign-in page; the owner approves them under **Users & sign ups** and picks their role (supervisor → sections, worker → section).

## Sign in & roles
- **Owner / supervisor / worker**: phone number + password at `/`. Sessions last 60 days and slide forward with use (`AUTH_CLIENT_SESSION_DAYS`), survive closing the browser, and are stored server-side (`auth_sessions`). Cookies are httpOnly + Secure + SameSite=Lax; nothing is kept in localStorage.
- **Starting password**: a random one-time password (e.g. `maple-4821-river3`) for accounts the developer/owner creates or resets — shown once to whoever set it up. Anyone on it must choose their own before they can do anything. Sign ups choose their own password. Easy passwords (`12345678`, digits only, …) are refused.
- **Sign up → pending**: sees nothing until the owner approves and gives a role. A rejected phone number can sign up again up to 3 times.
- **Owner** can switch people off, change role, reset a forgotten password and see / end each person's devices (**Users & sign ups**). Switching off, role change and password change sign that person out everywhere immediately.
- **Developer**: separate login (`/dev/login`, email + password, 12 h sessions), no sign up. Sees service health, connections, AI usage + cost, technical errors, the audit trail, and can **View as** any user (read-only unless `DEV_VIEW_AS_WRITE=1`; every call logged).
- Every API route checks the session on the server (`src/lib/apiAuth.ts`); `npm run lint` fails if a route handler has no check (`scripts/check-route-auth.js`).
- Audit trail: `auth_audit` (logins, failed logins, sign ups, approvals, rejections, deactivations, role changes, session revokes, developer actions). Technical errors: `app_errors`.
- Five wrong passwords for one phone/email pause sign in for 15 minutes.
- No OTP for now (passwords only).

## Preview deployments (branches / pull requests)
- The database is connected to Production only, so previews have no database: migrations are skipped and the app shows "can't reach the database".
- To test previews with data, create a second Supabase database (e.g. `narmada-staging`) and connect it to **Preview** only. Never connect the live database to Preview.

## Before each release — quick check
- [ ] Build passes on a preview/staging database
- [ ] Stock IN/OUT, photo upload → review → confirm, job card create/close all work
- [ ] Settings save correctly
- [ ] Supabase backups are on (Supabase dashboard → Database → Backups)

## Testing on a phone (voice needs https)
Phones block the microphone on plain `http://192.168.x.x:3000` Wi-Fi links, so the mic / voice buttons explain that instead of working. Use one of:
- **Tunnel (easiest):** run `npm run dev` in one terminal and `npm run tunnel` in another. Open the `https://….trycloudflare.com` link it prints on the phone.
- **Vercel preview:** push a branch — the preview URL is https.
- `npm run dev:https` works on the computer itself (https://localhost:3000); a phone will warn about the certificate.

Voice engines: Chrome / Android / Safari tabs use the phone's built-in speech recognition (free). The iPhone home-screen app and browsers without it record the mic and the server transcribes it with the low-tier AI model (needs `GEMINI_API_KEY`; logged as `voice.stt`).

## Local development
- Local Postgres + `npm run db:init` (demo data) → `npm run db:seed-demo` (test accounts) → `npm run dev`
- Demo sign-ins (password `12345678`): owner `9000000001`, supervisor `9000000002`, worker `9000000003`. Developer: set `DEV_ADMIN_EMAIL` / `DEV_ADMIN_PASSWORD` in `.env.local` or run `npm run dev:create -- --email you@example.com`.
- After pulling this version run `npm install` (adds `exceljs`, `sharp` and `pdf-lib`).
- Migrations also apply automatically when the local dev server starts.
- Copy `.env.example` to `.env.local` if you want to point at another database or storage.
