import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import pool, { query } from '../../src/lib/db';
import { apiRateLimitBudget, enforceApiRateLimit, enforceRateLimit, RateLimitError, rateLimitResponse } from '../../src/lib/apiRateLimit';

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

test('deployment budget is enforced and rejects invalid or disabled limits', async () => {
  const previous = process.env.API_RATE_LIMIT_STOCK_EXPORT;
  try {
    delete process.env.API_RATE_LIMIT_STOCK_EXPORT;
    assert.equal(apiRateLimitBudget('stock-export'), 60);
    process.env.API_RATE_LIMIT_STOCK_EXPORT = '2';
    await enforceApiRateLimit(query, userId, 'stock-export');
    await enforceApiRateLimit(query, userId, 'stock-export');
    await assert.rejects(enforceApiRateLimit(query, userId, 'stock-export'), RateLimitError);
    for (const invalid of ['0', '-1', '1.5', 'NaN', '1000001']) {
      process.env.API_RATE_LIMIT_STOCK_EXPORT = invalid;
      assert.throws(() => apiRateLimitBudget('stock-export'), /must be an integer/);
    }
  } finally {
    if (previous === undefined) delete process.env.API_RATE_LIMIT_STOCK_EXPORT;
    else process.env.API_RATE_LIMIT_STOCK_EXPORT = previous;
  }
});

test('exhausted scopes stay independent and expired windows reopen atomically', async () => {
  await enforceRateLimit(query, userId, 'expired', 1);
  await assert.rejects(enforceRateLimit(query, userId, 'expired', 1), RateLimitError);
  await enforceRateLimit(query, userId, 'other-scope', 1);
  await query("UPDATE api_rate_limits SET window_started_at = NOW() - INTERVAL '61 seconds' WHERE user_id = $1 AND scope = 'expired'", [userId]);
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => enforceRateLimit(query, userId, 'expired', 1)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
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
