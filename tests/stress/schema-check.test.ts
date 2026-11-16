import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import pool from '../../src/lib/db';
import { verifySchema } from '../../scripts/check-schema';

const url = new URL(process.env.DATABASE_URL || 'postgresql://localhost/invalid');
if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname) || !url.pathname.endsWith('_test')) {
  throw new Error('Use a disposable local DATABASE_URL ending in _test.');
}
after(() => pool.end());

test('deployment preflight accepts the migrated schema and detects missing migration 017', async () => {
  const client = await pool.connect();
  try {
    await verifySchema(client);
    await client.query('BEGIN');
    await client.query("DELETE FROM schema_migrations WHERE name = '017_api_rate_limits.sql'");
    await assert.rejects(verifySchema(client), /Unapplied migrations:.*017_api_rate_limits/);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('deployment preflight detects a missing SR uniqueness index despite recorded migrations', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DROP INDEX stock_movements_sr_unique');
    await assert.rejects(verifySchema(client), /unique \(direction, sr_series, sr_no\) index/);
  } finally { await client.query('ROLLBACK'); client.release(); }
});
