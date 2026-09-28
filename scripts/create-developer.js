// Creates (or resets the password of) a developer account. The only other way is DEV_ADMIN_EMAIL /
// DEV_ADMIN_PASSWORD in the environment. There is no sign up for developers.
// Usage: npm run dev:create -- --email you@example.com --name "Your Name"
//        (asks for the password; or set DEV_PASSWORD in the environment for scripts)
/* eslint-disable @typescript-eslint/no-require-imports -- plain Node script, like migrate.js */
const { Client } = require('pg');
const crypto = require('crypto');
const readline = require('readline');

const url =
  process.env.MIGRATION_DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING ||
  process.env.DATABASE_URL || process.env.POSTGRES_URL || 'postgresql://naresh@localhost:5432/textile_db';

function dbConfig(raw) {
  const u = new URL(raw);
  const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  const mode = u.searchParams.get('sslmode');
  u.searchParams.delete('sslmode');
  u.searchParams.delete('sslrootcert');
  return { connectionString: u.toString(), ssl: !local && mode !== 'disable' ? { rejectUnauthorized: false } : false };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

// Same format as src/lib/auth/password.ts
function hashPassword(password) {
  const N = 16384, r = 8, p = 1;
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a); }));
}

async function main() {
  const email = (arg('email') || '').trim().toLowerCase();
  const name = (arg('name') || 'Developer').trim().slice(0, 100);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Pass --email you@example.com');
  const password = process.env.DEV_PASSWORD || (await ask('Password (12+ characters): '));
  if (password.length < 12) throw new Error('Password must be at least 12 characters.');

  const c = new Client(dbConfig(url));
  await c.connect();
  try {
    await c.query('BEGIN');
    const cur = await c.query(`SELECT id, role FROM users WHERE lower(email) = $1 FOR UPDATE`, [email]);
    let id;
    if (cur.rowCount) {
      id = cur.rows[0].id;
      if (cur.rows[0].role !== 'developer') throw new Error(`${email} belongs to a non-developer account.`);
      await c.query(`UPDATE users SET password_hash = $2, password_changed_at = now(), status = 'approved', active = true WHERE id = $1`, [id, hashPassword(password)]);
      await c.query(`UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'password_changed' WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
      await c.query(`INSERT INTO auth_audit (event, actor_id, target_user_id, detail) VALUES ('password.changed', $1, $1, '{"source":"script"}')`, [id]);
    } else {
      id = `dev-${Date.now().toString(36)}`;
      await c.query(
        `INSERT INTO users (id, name, role, email, password_hash, password_changed_at, status, active) VALUES ($1, $2, 'developer', $3, $4, now(), 'approved', true)`,
        [id, name, email, hashPassword(password)],
      );
      await c.query(`INSERT INTO auth_audit (event, actor_id, target_user_id, detail) VALUES ('user.created', $1, $1, '{"role":"developer","source":"script"}')`, [id]);
    }
    await c.query('COMMIT');
    console.log(`[create-developer] ${cur.rowCount ? 'Password reset for' : 'Created'} ${email} (${id}). Sign in at /dev/login.`);
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error('[create-developer] Failed:', e.message); process.exit(1); });
