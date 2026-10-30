import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/** Destructive tests get a NEW database; never reset the caller's shared test DB. */
export async function createDisposableDatabase(purpose: string) {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('Set an explicit local DATABASE_URL ending in _test.');
  const parent = new URL(raw);
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(parent.hostname) || !parent.pathname.endsWith('_test')) {
    throw new Error('Disposable databases can only be created from a local _test connection.');
  }
  if (!/^[a-z]{1,16}$/.test(purpose)) throw new Error('Invalid test database purpose.');
  const name = `textile_${purpose}_${randomUUID().replace(/-/g, '').slice(0, 12)}_test`;
  const admin = new Client({ connectionString: raw, connectionTimeoutMillis: 5000 });
  await admin.connect();
  let created = false;
  const cleanup = async () => {
    try {
      // No FORCE: a leaked app connection should fail the test, not kill other sessions.
      if (created) { await admin.query(`DROP DATABASE "${name}"`); created = false; }
    } finally { await admin.end(); }
  };
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const childUrl = new URL(parent);
    childUrl.pathname = `/${name}`;
    const client = new Client({ connectionString: childUrl.toString() });
    try {
      await client.connect();
      await client.query('CREATE TABLE schema_migrations (name VARCHAR(200) PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)');
      const dir = path.join(process.cwd(), 'scripts/migrations');
      for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
        await client.query('BEGIN');
        try {
          await client.query(await readFile(path.join(dir, file), 'utf8'));
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
      }
    } finally { await client.end(); }
    return { name, url: childUrl.toString(), cleanup };
  } catch (error) { await cleanup(); throw error; }
}
