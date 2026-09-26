// Applies scripts/migrations/*.sql in name order, once each (tracked in schema_migrations).
// Called at server start from src/instrumentation.ts; `npm run db:migrate` does the same from the CLI.
import fs from 'fs';
import path from 'path';
import pool from './db';

const MIGRATIONS_DIR = path.join(process.cwd(), 'scripts', 'migrations');
const LOCK_KEY = 72_150_926; // pg advisory lock id: only one server applies migrations at a time

export async function applyPendingMigrations(): Promise<void> {
  if (process.env.SKIP_DB_MIGRATIONS === '1') return;
  // On Vercel migrations run during the build (`npm run build` → scripts/migrate.js), not at runtime.
  if (process.env.VERCEL) return;
  if (!fs.existsSync(MIGRATIONS_DIR)) return;

  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    // Don't stop the server; API routes will report the database error.
    console.warn('[migrate] Database not reachable at startup, skipped migrations:', (err as Error).message);
    return;
  }

  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(200) PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[migrate] Applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[migrate] Failed on ${file} — database left unchanged for this file:`, (err as Error).message);
        return;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}
