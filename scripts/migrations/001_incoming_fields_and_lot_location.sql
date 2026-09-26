-- 001 — Review 26 Sep 2026 §1: incoming-stock fields + lot location tracking.
-- Additive and idempotent: nullable columns (no table rewrite), new table, index.
-- Safe to run on a live database and to re-run.

-- Incoming stock: grey vs finished meters, mill and weaver as separate fields.
-- `meters` stays the stock quantity used for balances (finished if known, else grey).
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS grey_meters NUMERIC(10, 2) CHECK (grey_meters IS NULL OR grey_meters > 0),
  ADD COLUMN IF NOT EXISTS finished_meters NUMERIC(10, 2) CHECK (finished_meters IS NULL OR finished_meters > 0),
  ADD COLUMN IF NOT EXISTS mill_name VARCHAR(150),
  ADD COLUMN IF NOT EXISTS weaver_name VARCHAR(150);

COMMENT ON COLUMN stock_movements.party IS 'Destination client. OUT movements only (older IN rows may hold the legacy supplier).';
COMMENT ON COLUMN stock_movements.meters IS 'Stock quantity for balances. IN: finished meters if known, else grey meters.';

-- Where a lot physically is. One row per move; the latest row is the current location.
CREATE TABLE IF NOT EXISTS lot_locations (
  id SERIAL PRIMARY KEY,
  lot_id VARCHAR(50) NOT NULL REFERENCES lots(lot_id) ON DELETE RESTRICT,
  location VARCHAR(100) NOT NULL CHECK (length(btrim(location)) > 0),
  stage VARCHAR(20) NOT NULL CHECK (stage IN ('arrival', 'job_card', 'returned', 'dispatch', 'moved')),
  note TEXT,
  job_card_id INTEGER REFERENCES job_cards(id) ON DELETE SET NULL,
  stock_movement_id INTEGER REFERENCES stock_movements(id) ON DELETE SET NULL,
  moved_by VARCHAR(50) REFERENCES users(id),
  ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lot_locations_lot_ts ON lot_locations (lot_id, ts DESC, id DESC);
