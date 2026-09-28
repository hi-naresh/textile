-- 006 — Login, sign up + approval, sessions, developer role, audit trail.
-- Additive: existing users keep working (status 'approved'); they get a phone + password from the owner/developer.

-- ---------- users ----------
-- Role becomes optional (a pending sign up has none until the owner approves) and gains 'developer'.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'users'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE users ALTER COLUMN role DROP NOT NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone VARCHAR(15),
  ADD COLUMN IF NOT EXISTS email VARCHAR(200),
  ADD COLUMN IF NOT EXISTS password_hash TEXT,
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status VARCHAR(10) NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS requested_role VARCHAR(20),
  ADD COLUMN IF NOT EXISTS rejected_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS decided_by VARCHAR(50),
  ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IS NULL OR role IN ('owner', 'supervisor', 'worker', 'admin', 'developer'));
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('pending', 'approved', 'rejected'));
ALTER TABLE users ADD CONSTRAINT users_approved_has_role CHECK (status <> 'approved' OR role IS NOT NULL);
ALTER TABLE users ADD CONSTRAINT users_requested_role_check CHECK (requested_role IS NULL OR requested_role IN ('supervisor', 'worker'));
-- 10-digit Indian mobile number, digits only (the app normalises +91 / spaces before saving).
ALTER TABLE users ADD CONSTRAINT users_phone_check CHECK (phone IS NULL OR phone ~ '^[6-9][0-9]{9}$');
ALTER TABLE users ADD CONSTRAINT users_developer_email CHECK (role IS DISTINCT FROM 'developer' OR (email IS NOT NULL AND phone IS NULL));

CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users (phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_status_idx ON users (status);

-- ---------- sessions ----------
-- One row per signed-in device. Only SHA-256 hashes of the tokens are stored.
-- access token: short-lived (minutes), checked on every API call.
-- refresh token: long-lived, rotated on every use; the previous one is accepted for a few seconds
-- (two tabs refreshing at once) and after that means the token was stolen → session revoked.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id VARCHAR(40) PRIMARY KEY,
  user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('client', 'developer')),
  access_hash CHAR(64) NOT NULL,
  access_expires_at TIMESTAMPTZ NOT NULL,
  refresh_hash CHAR(64) NOT NULL,
  prev_refresh_hash CHAR(64),
  rotated_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL, -- sliding: pushed forward on every refresh
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip VARCHAR(64),
  user_agent VARCHAR(300),
  view_as_user_id VARCHAR(50) REFERENCES users(id) ON DELETE SET NULL, -- developer "View as"
  view_as_since TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_reason VARCHAR(40),
  revoked_by VARCHAR(50)
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_access_unique ON auth_sessions (access_hash);
CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_refresh_unique ON auth_sessions (refresh_hash);
CREATE INDEX IF NOT EXISTS auth_sessions_prev_refresh_idx ON auth_sessions (prev_refresh_hash) WHERE prev_refresh_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS auth_sessions_user_live_idx ON auth_sessions (user_id) WHERE revoked_at IS NULL;

-- ---------- audit trail ----------
-- Logins, failed logins, sign ups, approvals, rejections, deactivations, role changes,
-- session revokes and every developer action on client data.
CREATE TABLE IF NOT EXISTS auth_audit (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  event VARCHAR(40) NOT NULL,
  actor_id VARCHAR(50),        -- who did it (NULL = someone not signed in)
  target_user_id VARCHAR(50),  -- who it was about
  login VARCHAR(200),          -- phone / email typed at login (failed logins have no user)
  session_id VARCHAR(40),
  ip VARCHAR(64),
  user_agent VARCHAR(300),
  detail JSONB
);
CREATE INDEX IF NOT EXISTS auth_audit_ts_idx ON auth_audit (ts DESC);
CREATE INDEX IF NOT EXISTS auth_audit_target_idx ON auth_audit (target_user_id, ts DESC);
CREATE INDEX IF NOT EXISTS auth_audit_login_idx ON auth_audit (login, ts DESC) WHERE event = 'login.failed';

-- ---------- technical errors (developer console only) ----------
CREATE TABLE IF NOT EXISTS app_errors (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  source VARCHAR(100) NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  user_id VARCHAR(50),
  detail JSONB
);
CREATE INDEX IF NOT EXISTS app_errors_ts_idx ON app_errors (ts DESC);
