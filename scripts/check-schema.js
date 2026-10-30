/* eslint-disable @typescript-eslint/no-require-imports -- plain Node deployment script */
const fs = require('fs');
const path = require('path');
const { dbConfig } = require('./db-config');

// Read-only check against the application connection, including its search_path.
async function verifySchema(client) {
  const files = fs.readdirSync(path.join(__dirname, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const pending = files.filter((f) => !done.has(f));
  if (pending.length) throw new Error(`Unapplied migrations: ${pending.join(', ')}`);
  await client.query('SELECT user_id, scope, window_started_at, request_count FROM api_rate_limits LIMIT 0');
  const constraints = await client.query(
    `SELECT 1 FROM pg_constraint
     WHERE conrelid = 'api_rate_limits'::regclass AND contype = 'p'
       AND pg_get_constraintdef(oid) = 'PRIMARY KEY (user_id, scope)'`,
  );
  if (!constraints.rowCount) throw new Error('api_rate_limits is missing its (user_id, scope) primary key.');
}

async function main() {
  // No .env loading or default database: the operator must select the target.
  const raw = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!raw) throw new Error('Set DATABASE_URL or POSTGRES_URL explicitly to the application database.');
  const { Client } = require('pg');
  const client = new Client({ ...dbConfig(raw), connectionTimeoutMillis: 8000, statement_timeout: 10000,
    options: '-c default_transaction_read_only=on' });
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    await verifySchema(client);
    console.log('Schema check passed: all migrations applied; rate-limit table and primary key present.');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

module.exports = { verifySchema };
if (require.main === module) {
  main().catch((error) => {
    console.error(`[schema] ${error.message}`);
    process.exitCode = 1;
  });
}
