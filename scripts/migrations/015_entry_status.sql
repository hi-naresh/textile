-- 015 — Status of an outgoing entry (issue #3). Idempotent. Runs inside one transaction (scripts/migrate.js).
--
-- stock_movements.entry_status  OUT only: 'packed' (packed for the party, not sent yet), 'running' (sent, more left in
--                               the lot) or 'end' (the last sale from the lot; closing the lot is issue #4).
--                               NULL on incoming rows (enforced) and on outgoing rows saved before this migration.
-- Packed meters count as out of stock like any other outgoing entry (the balance drops when the entry is made).
-- lot_status_code (migration 013) stays as the sales register's raw "LOT S" text.

ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS entry_status VARCHAR(10);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_entry_status_check') THEN
    ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_entry_status_check
      CHECK (entry_status IS NULL OR (entry_status IN ('packed', 'running', 'end') AND direction = 'OUT'));
  END IF;
END $$;

-- Ledger filter "status = …" on outgoing rows, newest first.
CREATE INDEX IF NOT EXISTS stock_movements_entry_status_idx ON stock_movements (entry_status, ts DESC, id DESC) WHERE entry_status IS NOT NULL;
