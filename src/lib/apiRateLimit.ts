import { NextResponse } from 'next/server';
import type { Q } from './db';
import { LedgerError } from './ledger-error';

const POLICIES = {
  'stock-import': { env: 'API_RATE_LIMIT_STOCK_IMPORT', default: 60 },
  'stock-import-fix': { env: 'API_RATE_LIMIT_STOCK_IMPORT_FIX', default: 60 },
  'stock-import-commit': { env: 'API_RATE_LIMIT_STOCK_IMPORT_COMMIT', default: 300 },
  'stock-export': { env: 'API_RATE_LIMIT_STOCK_EXPORT', default: 60 },
  'invoice-export': { env: 'API_RATE_LIMIT_INVOICE_EXPORT', default: 60 },
  'report-export': { env: 'API_RATE_LIMIT_REPORT_EXPORT', default: 60 },
} as const;

export function apiRateLimitBudget(scope: keyof typeof POLICIES): number {
  const policy = POLICIES[scope];
  const raw = process.env[policy.env];
  if (raw === undefined || raw === '') return policy.default;
  const limit = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) {
    throw new Error(`${policy.env} must be an integer between 1 and 1000000.`);
  }
  return limit;
}

/** Deployment-configurable budgets; keep the same values on every app instance. */
export function enforceApiRateLimit(q: Q, userId: string, scope: keyof typeof POLICIES) {
  return enforceRateLimit(q, userId, scope, apiRateLimitBudget(scope));
}

export class RateLimitError extends LedgerError {
  constructor(public readonly retryAfterSeconds: number) {
    super(`Too many requests. Try again in ${retryAfterSeconds} seconds.`, 429);
  }
}

/** Atomic, per-user fixed-window limiter shared by all app instances through PostgreSQL. */
export async function enforceRateLimit(q: Q, userId: string, scope: string, limit: number, windowSeconds = 60) {
  if (!userId || !scope || !Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error('Rate limit configuration is invalid.');
  }
  const result = await q(
    `INSERT INTO api_rate_limits (user_id, scope, window_started_at, request_count)
     VALUES ($1, $2, NOW(), 1)
     ON CONFLICT (user_id, scope) DO UPDATE
       SET window_started_at = CASE
             WHEN api_rate_limits.window_started_at <= NOW() - ($4::int * INTERVAL '1 second') THEN NOW()
             ELSE api_rate_limits.window_started_at
           END,
           request_count = CASE
             WHEN api_rate_limits.window_started_at <= NOW() - ($4::int * INTERVAL '1 second') THEN 1
             ELSE api_rate_limits.request_count + 1
           END
       WHERE api_rate_limits.window_started_at <= NOW() - ($4::int * INTERVAL '1 second')
          OR api_rate_limits.request_count < $3
     RETURNING request_count`,
    [userId, scope, limit, windowSeconds],
  );
  if (result.rowCount) return;
  const current = await q(
    `SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM
       (window_started_at + ($3::int * INTERVAL '1 second') - NOW())))::int) AS retry_after
     FROM api_rate_limits WHERE user_id = $1 AND scope = $2`,
    [userId, scope, windowSeconds],
  );
  throw new RateLimitError(Number(current.rows[0]?.retry_after ?? windowSeconds));
}

export function rateLimitResponse(error: unknown): NextResponse | null {
  if (!(error instanceof RateLimitError)) return null;
  return NextResponse.json(
    { error: error.message },
    { status: 429, headers: { 'Retry-After': String(error.retryAfterSeconds), 'Cache-Control': 'no-store' } },
  );
}
