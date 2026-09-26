// Applies scripts/migrations/*.sql in name order, once each.
// Usage: npm run db:migrate   (uses DATABASE_URL or the local default)
// The app also runs this automatically at server start (src/lib/migrate.ts).
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Migrations need a direct (non-pooled) connection. On Vercel + Supabase that's POSTGRES_URL_NON_POOLING.
const onVercel = !!process.env.VERCEL;
const url =
  process.env.MIGRATION_DATABASE_URL ||
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  (onVercel ? '' : 'postgresql://naresh@localhost:5432/textile_db');

function dbConfig(raw) {
  const u = new URL(raw);
  const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  const mode = u.searchParams.get('sslmode');
  u.searchParams.delete('sslmode');
  u.searchParams.delete('sslrootcert');
  return { connectionString: u.toString(), ssl: !local && mode !== 'disable' ? { rejectUnauthorized: false } : false };
}

const dir = path.join(__dirname, 'migrations');

async function main() {
  if (!url) {
    // e.g. a Vercel Preview build with no database connected: nothing to migrate.
    console.warn('[migrate] No database URL configured for this environment; skipping migrations.');
    return;
  }
  const client = new Client(dbConfig(url));
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(200) PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    let applied = 0;
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      console.log(`Applying ${file} ...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`Failed on ${file}:`, err.message);
        process.exitCode = 1;
        return;
      }
    }
    console.log(applied ? `Done. ${applied} migration(s) applied.` : 'Database is up to date.');
  } finally {
    await client.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
