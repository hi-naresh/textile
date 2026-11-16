-- Latest explicit status takes precedence over inferred job-card status.
CREATE INDEX IF NOT EXISTS stock_movements_latest_status ON stock_movements (lot_id, ts DESC, id DESC) WHERE kind = 'normal' AND entry_status IS NOT NULL;
