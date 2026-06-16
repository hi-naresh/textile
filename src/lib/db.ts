import { Pool, PoolConfig } from 'pg';

const connectionString = process.env.DATABASE_URL || 'postgresql://naresh@localhost:5432/textile_db';

const poolConfig: PoolConfig = {
  connectionString,
  // Configure pool limits for reliability
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
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
