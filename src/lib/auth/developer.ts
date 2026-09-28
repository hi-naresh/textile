// The developer account comes only from environment config (or scripts/create-developer.js) —
// never from sign up. DEV_ADMIN_EMAIL + DEV_ADMIN_PASSWORD are the source of truth:
// at server start the account is created, or its password updated if the env value changed.
import pool from '../db';
import { hashPassword, PASSWORD_MIN, verifyPassword } from './password';
import { normalizeEmail } from './phone';

export async function ensureDeveloperFromEnv(): Promise<void> {
  const email = normalizeEmail(process.env.DEV_ADMIN_EMAIL);
  const password = process.env.DEV_ADMIN_PASSWORD ?? '';
  if (!email || !password) return;
  if (password.length < 12) {
    console.warn(`[auth] DEV_ADMIN_PASSWORD must be at least 12 characters (min for users is ${PASSWORD_MIN}); developer account not set up.`);
    return;
  }
  const name = process.env.DEV_ADMIN_NAME?.trim().slice(0, 100) || 'Developer';
  try {
    const cur = await pool.query(`SELECT id, password_hash FROM users WHERE lower(email) = $1`, [email]);
    const row = cur.rows[0];
    if (row && (await verifyPassword(password, row.password_hash))) return;
    const hash = await hashPassword(password);
    if (row) {
      await pool.query(`UPDATE users SET password_hash = $2, password_changed_at = now(), role = 'developer', status = 'approved', active = true WHERE id = $1`, [row.id, hash]);
      await pool.query(`UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'password_changed' WHERE user_id = $1 AND revoked_at IS NULL`, [row.id]);
      await pool.query(`INSERT INTO auth_audit (event, actor_id, target_user_id, detail) VALUES ('password.changed', $1, $1, '{"source":"env"}')`, [row.id]);
      console.log('[auth] Developer password updated from DEV_ADMIN_PASSWORD.');
    } else {
      const id = `dev-${Date.now().toString(36)}`;
      await pool.query(
        `INSERT INTO users (id, name, role, email, password_hash, password_changed_at, status, active) VALUES ($1, $2, 'developer', $3, $4, now(), 'approved', true)`,
        [id, name, email, hash],
      );
      await pool.query(`INSERT INTO auth_audit (event, actor_id, target_user_id, detail) VALUES ('user.created', $1, $1, '{"role":"developer","source":"env"}')`, [id]);
      console.log(`[auth] Developer account created for ${email}.`);
    }
  } catch (err) {
    // Database not reachable / not migrated yet: API routes will report it.
    console.warn('[auth] Could not set up the developer account:', (err as Error).message);
  }
}
