# Deploying to Vercel + Supabase

One copy of the app per firm. Each firm gets its own Vercel project and its own Supabase database.

## What happens on every deploy
1. You push to GitHub → Vercel starts a build.
2. `npm run build` runs `scripts/migrate.js` first: it creates/updates the tables in the firm's database (only changes not yet applied; each runs once, all-or-nothing).
3. If a migration fails, the build fails and the live site stays on the previous version.
4. Then `next build` runs and the new version goes live.

No demo data is ever loaded on Vercel. `scripts/db-init.js` (demo data) is **local only** — it deletes all tables first. Never point it at a real database.

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

### 3. Other environment variables (Project → Settings → Environment Variables, Production)
- `GEMINI_API_KEY` — required. Without it, photo reading is refused (it never invents data in production).
- `GEMINI_MODEL` — optional (default `gemini-3.5-flash`).
- If the key is missing/rejected or the model is retired, the app shows a warning banner, disables photo capture for workers, and Settings → **Connections** explains what to fix.

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

## Local development
- Local Postgres + `npm run db:init` (demo data) → `npm run dev`
- Migrations also apply automatically when the local dev server starts.
- Copy `.env.example` to `.env.local` if you want to point at another database or storage.
