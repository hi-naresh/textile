-- 007 — Stock ledger fields the firm uses on paper, markets for lot locations, faster filtering.
-- Additive and idempotent.

-- Register serial number (SR no.) typed on each entry — suggested as last + 1, editable. Unique per direction.
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS sr_no INTEGER CHECK (sr_no IS NULL OR sr_no > 0);
CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_sr_unique ON stock_movements (direction, sr_no) WHERE sr_no IS NOT NULL;

-- Pieces ("taka") in the movement.
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS pieces INTEGER CHECK (pieces IS NULL OR pieces >= 0);

-- Excel import: "<batch>:<row>" so a re-sent chunk never adds the same row twice.
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS import_ref VARCHAR(60);
CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_import_ref_unique ON stock_movements (import_ref) WHERE import_ref IS NOT NULL;

-- Markets for "market + shop no. + pipe no." lot locations (e.g. RRTM 245 · Pipe 3).
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS markets TEXT[] NOT NULL DEFAULT ARRAY['RRTM']::text[];

-- Ledger filtering over thousands of rows.
CREATE INDEX IF NOT EXISTS idx_stock_movements_ts ON stock_movements (ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_lot ON stock_movements (lot_id);
CREATE INDEX IF NOT EXISTS idx_lots_quality_ci ON lots (lower(quality));
CREATE INDEX IF NOT EXISTS idx_lots_design_ci ON lots (lower(design));
