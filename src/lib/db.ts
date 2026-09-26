import { Pool, PoolConfig, QueryResult } from 'pg';
import { resolveDbConfig } from './dbUrl';

// Local: DATABASE_URL or the local default.
// Vercel + Supabase: the integration provides POSTGRES_URL (pooled connection).
const onVercel = !!process.env.VERCEL;
const { connectionString, ssl } = resolveDbConfig(
  process.env.DATABASE_URL || process.env.POSTGRES_URL,
  'postgresql://naresh@localhost:5432/textile_db',
);

const poolConfig: PoolConfig = {
  connectionString,
  ssl,
  // Serverless functions each hold their own pool; keep it small there.
  max: onVercel ? 3 : 10,
  idleTimeoutMillis: onVercel ? 10_000 : 30_000,
  connectionTimeoutMillis: onVercel ? 8_000 : 2_000,
};

// Create a single instance of Pool
let pool: Pool;

if (process.env.NODE_ENV === 'production') {
  pool = new Pool(poolConfig);
} else {
  // In development mode, use a global variable so that the value
  // is preserved across module reloads caused by HMR (Hot Module Replacement).
  const globalWithPool = global as typeof globalThis & {
    _postgresPool?: Pool;
  };
  if (!globalWithPool._postgresPool) {
    globalWithPool._postgresPool = new Pool(poolConfig);
  }
  pool = globalWithPool._postgresPool;
}

export default pool;

export async function query(text: string, params?: any[]) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log(`[DB Query] executed query`, { text, duration, rowsCount: res.rowCount });
    return res;
  } catch (error) {
    console.error(`[DB Query Error]`, { text, error });
    throw error;
  }
}

/**
 * Run several statements as ONE transaction on ONE connection.
 * (pool.query('BEGIN') is unsafe: each pool.query may use a different client.)
 * The callback gets a `q` with the same signature as `query`.
 */
export type Q = (text: string, params?: unknown[]) => Promise<QueryResult>;

export async function withTransaction<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const q: Q = (text, params) => client.query(text, params as unknown[] | undefined);
  try {
    await client.query('BEGIN');
    const result = await fn(q);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rbErr) { console.error('[DB] Rollback failed', rbErr); }
    throw err;
  } finally {
    client.release();
  }
}
