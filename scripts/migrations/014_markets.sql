-- 014 — Markets and their shops for lot locations. Idempotent. Runs inside one transaction (scripts/migrate.js).
--
-- The owner (Surat): "Location on arrival: remove Godown, Shop and Floor. Keep only the market options. Add Landmark
-- and Raghuveer Scarlet, with initials for each. We can also have the shop number … Pipe numbers are typed by hand."
--
-- markets        one row per textile market. code = the initials / shortcut used in a lot's location label
--                ("LM 245 · Pipe 3"): 1–6 capital letters or digits. Name and code are unique, ignoring case.
--                active = offered when picking a location (switched-off markets stay for history).
-- market_shops   the firm's shop numbers in each market (digits + optional letter: 245, 12A). Picked from the list
--                or added while picking (owner + supervisor); active = offered (removing a shop switches it off).
-- lot_locations  + market_id / shop_no / pipe_no: structured copy of a market location (NULL for system places and
--                for every row written before this migration). The location text stays the display label.
--
-- Locations a person can pick are ONLY "<CODE> <shop> · Pipe <pipe>" from an active market (shop required, pipe
-- optional 1–999). "Floor" (job cards) and "Dispatched" (fully sent out) are written by the app only.
-- app_settings.location_presets and app_settings.markets are no longer read (left in place, see the comments below).
-- Old lot locations (Godown, Shop, RRTM 245 · Pipe 3 …) are history and are NOT rewritten.

CREATE TABLE IF NOT EXISTS markets (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(60) NOT NULL CHECK (length(btrim(name)) > 0),
  code       VARCHAR(6)  NOT NULL CHECK (code ~ '^[A-Z0-9]{1,6}$'),
  active     BOOLEAN     NOT NULL DEFAULT true,
  sort_order INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by VARCHAR(50) REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS markets_name_ci ON markets (lower(btrim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS markets_code_ci ON markets (lower(code));

CREATE TABLE IF NOT EXISTS market_shops (
  id         SERIAL PRIMARY KEY,
  market_id  INTEGER     NOT NULL REFERENCES markets(id) ON DELETE RESTRICT,
  shop_no    VARCHAR(8)  NOT NULL CHECK (shop_no ~ '^[1-9][0-9]{0,6}[A-Z]?$'),
  active     BOOLEAN     NOT NULL DEFAULT true,
  created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by VARCHAR(50) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (market_id, shop_no)
);

ALTER TABLE lot_locations
  ADD COLUMN IF NOT EXISTS market_id INTEGER REFERENCES markets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS shop_no   VARCHAR(8),
  ADD COLUMN IF NOT EXISTS pipe_no   SMALLINT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lot_locations_pipe_no_range') THEN
    ALTER TABLE lot_locations ADD CONSTRAINT lot_locations_pipe_no_range CHECK (pipe_no IS NULL OR pipe_no BETWEEN 1 AND 999);
  END IF;
END $$;
-- Shop list "most used first", search / filter by market.
CREATE INDEX IF NOT EXISTS idx_lot_locations_market ON lot_locations (market_id, shop_no) WHERE market_id IS NOT NULL;

-- Seed: only Landmark and Raghuveer Scarlet (the owner: "for now keep Landmark and Raghuveer Scarlet").
-- Old app_settings.markets entries (RRTM …) are deliberately not carried over. Seeded only into an empty table,
-- so a re-run never brings back a market the owner renamed.
INSERT INTO markets (name, code, sort_order)
SELECT v.name, v.code, v.sort_order
  FROM (VALUES ('Landmark', 'LM', 1), ('Raghuveer Scarlet', 'RS', 2)) AS v(name, code, sort_order)
 WHERE NOT EXISTS (SELECT 1 FROM markets);

COMMENT ON COLUMN app_settings.location_presets IS 'Unused since migration 014 (fixed places Godown / Shop / Floor are no longer offered). Kept for old data.';
COMMENT ON COLUMN app_settings.markets IS 'Unused since migration 014 — markets live in the markets table.';
