import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import pool, { query } from '../../src/lib/db';
import { enforceRateLimit, RateLimitError, rateLimitResponse } from '../../src/lib/apiRateLimit';

const databaseUrl = new URL(process.env.DATABASE_URL || 'postgresql://localhost/invalid');
if (!['localhost', '127.0.0.1', '::1'].includes(databaseUrl.hostname) || !databaseUrl.pathname.endsWith('_test')) {
  throw new Error('Use a disposable local DATABASE_URL ending in _test.');
}
process.env.DB_QUIET = '1';

const userId = `stress-rate-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const scope = 'stress-test';

after(async () => {
  await query('DELETE FROM api_rate_limits WHERE user_id = $1', [userId]);
  await pool.end();
});

test('database-backed rate limit is atomic under concurrent requests and returns Retry-After', async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => enforceRateLimit(query, userId, scope, 5)),
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 5);
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  assert.equal(rejected.length, 15);
  assert.ok(rejected.every((result) => result.reason instanceof RateLimitError));

  const response = rateLimitResponse(rejected[0].reason);
  assert.ok(response);
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('Retry-After')) >= 1);
});
