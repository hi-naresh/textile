-- 009 — Owner can edit the stock ledger like a sheet (with an edit log), remove team members,
-- and the developer can switch capabilities off/on per role.
-- Idempotent.

-- 1. Every change made in the ledger's edit mode (who, what, before → after).
CREATE TABLE IF NOT EXISTS ledger_edits (
  id          BIGSERIAL PRIMARY KEY,
  target      VARCHAR(20)  NOT NULL CHECK (target IN ('movement', 'lot')),
  target_id   VARCHAR(50)  NOT NULL,           -- stock_movements.id or lots.lot_id
  field       VARCHAR(40)  NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  edited_by   VARCHAR(50)  REFERENCES users(id),
  edited_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_edits_target ON ledger_edits (target, target_id, edited_at DESC);

-- 2. Removed team members stay in history (job cards, audit) but disappear from every list.
ALTER TABLE users   ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- 3. Developer-set capability switches: {"supervisor": {"orders.view": false}, "worker": {...}}.
--    Only capabilities a role has by default can be switched; owner is always full.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS access_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;
