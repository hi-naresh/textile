-- Lots & balance can search the actual incoming weaver alongside the lot's own fields.
CREATE INDEX IF NOT EXISTS idx_stock_incoming_weaver_trgm
  ON stock_movements USING gin (lower(weaver_name) gin_trgm_ops)
  WHERE direction = 'IN' AND kind = 'normal';
