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
- `DEV_ACCESS_TOKEN` — optional, 16+ characters. Enables the developer usage/cost log: `curl -H "x-dev-token: <token>" https://<site>/api/dev/usage?days=30`.
- If a key is missing/rejected or a model is retired, the app shows a warning banner and Settings → **Connections** explains what to fix. Workers can't capture only when neither OCR nor AI works.

### 4. Server region
- `vercel.json` pins the app to Mumbai (`bom1`), next to the database.

### 5. Protect the site until login exists
- Project → Settings → **Deployment Protection** → turn on password protection.
- There is no login yet: anyone with the link could otherwise open Settings.

### 6. Firm-specific setup
- `scripts/migrations/003_setup_narmada_group.sql` sets Narmada Group / Surat / Mukesh.
- **For another firm:** delete that file before the first deploy, then fill in **Settings** in the app.

### 7. First login to the live app
- Open the site → Preview as **Owner** → **Settings**
- Add sections, supervisors (tick their sections) and workers.

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
- After pulling this version run `npm install` (adds `exceljs` and `sharp`).
- Migrations also apply automatically when the local dev server starts.
- Copy `.env.example` to `.env.local` if you want to point at another database or storage.
