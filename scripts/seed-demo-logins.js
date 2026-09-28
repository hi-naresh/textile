// Demo sign-ins for the accounts made by scripts/seed-demo.js: phone number + password 12345678.
// Runs after seed-demo (`npm run db:seed-demo`). Only fills a phone / password that isn't set yet,
// so it never changes a real account. Refuses non-local databases unless ALLOW_DEMO_SEED=1.
const { Client } = require('pg');
const crypto = require('crypto');

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || 'postgresql://naresh@localhost:5432/textile_db';

const LOGINS = [
  { id: 'usr-owner', phone: '9000000001' },
  { id: 'usr-demo-sup', phone: '9000000002' },
  { id: 'usr-demo-wrk', phone: '9000000003' },
];
const DEMO_PASSWORD = '12345678';

// Same format as src/lib/auth/password.ts
function hashPassword(password) {
  const N = 16384, r = 8, p = 1;
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function main() {
  const u = new URL(url);
  const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  if (!local && process.env.ALLOW_DEMO_SEED !== '1') {
    console.error(`[seed-demo-logins] Refusing to add demo sign-ins to ${u.hostname} (not a local database). Set ALLOW_DEMO_SEED=1 if this is a test database.`);
    process.exit(1);
  }
  const mode = u.searchParams.get('sslmode');
  u.searchParams.delete('sslmode');
  u.searchParams.delete('sslrootcert');
  const c = new Client({ connectionString: u.toString(), ssl: !local && mode !== 'disable' ? { rejectUnauthorized: false } : false });
  await c.connect();
  try {
    const ready = await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'password_hash'`);
    if (!ready.rowCount) { console.log('[seed-demo-logins] Migration 006 not applied yet; skipped.'); return; }
    let n = 0;
    for (const a of LOGINS) {
      const r = await c.query(
        `UPDATE users SET phone = COALESCE(phone, $2), password_hash = COALESCE(password_hash, $3), status = 'approved'
         WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM users o WHERE o.phone = $2 AND o.id <> $1)`,
        [a.id, a.phone, hashPassword(DEMO_PASSWORD)],
      );
      n += r.rowCount;
    }
    console.log(`[seed-demo-logins] ${n} demo sign-in(s) ready. Password ${DEMO_PASSWORD}: owner 9000000001, supervisor 9000000002, worker 9000000003.`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error('[seed-demo-logins] Failed:', e.message); process.exit(1); });
