-- Separate register sequences by direction and owner-defined prefix. Preserve all existing numbers.
CREATE TABLE IF NOT EXISTS sr_series (
  prefix VARCHAR(10) PRIMARY KEY CHECK (prefix = '' OR prefix ~ '^[A-Z][A-Z0-9]{0,9}$'),
  name VARCHAR(100) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by VARCHAR(50) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO sr_series (prefix, name) VALUES ('', 'Main') ON CONFLICT DO NOTHING;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS sr_series VARCHAR(10) NOT NULL DEFAULT '' REFERENCES sr_series(prefix);
DROP INDEX IF EXISTS stock_movements_sr_unique;
CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_sr_unique ON stock_movements(direction, sr_series, sr_no) WHERE sr_no IS NOT NULL;
