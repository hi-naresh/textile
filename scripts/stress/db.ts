import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set DATABASE_URL to a disposable local database ending in _test.');

const parsedUrl = new URL(databaseUrl);
if (!['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname) || !parsedUrl.pathname.endsWith('_test')) {
  throw new Error('Stress tooling only runs against a local database ending in _test.');
}

export const pool = new Pool({ connectionString: databaseUrl, max: 3 });

export async function closePool() {
  await pool.end();
}
