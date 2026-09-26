// Runs once when the Next.js server starts (dev and production).
// Applies any pending database migrations so the app never runs against an out-of-date schema.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { applyPendingMigrations } = await import('./lib/migrate');
    await applyPendingMigrations();
  }
}
