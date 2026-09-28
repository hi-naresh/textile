// Runs once when the Next.js server starts (dev and production).
// Applies any pending database migrations so the app never runs against an out-of-date schema,
// then makes sure the developer account from DEV_ADMIN_EMAIL / DEV_ADMIN_PASSWORD exists.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { applyPendingMigrations } = await import('./lib/migrate');
    await applyPendingMigrations();
    const { ensureDeveloperFromEnv } = await import('./lib/auth/developer');
    await ensureDeveloperFromEnv();
  }
}
