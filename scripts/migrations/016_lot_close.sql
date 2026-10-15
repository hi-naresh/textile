-- 016 — Closing a lot (issue #4). Idempotent. Runs inside one transaction (scripts/migrate.js).
--
-- An outgoing entry marked End closes its lot: the lot's balance is worked out from all its entries and any difference
-- is written off with a CLOSING ADJUSTMENT, so the balance is exactly 0 and never shows negative.
--
-- stock_movements.kind  + 'closing': the write-off. OUT for meters left over (a shortage), IN for meters that went out
--                       beyond what came in (e.g. mill fold excess). No party, no order, no dispatch. Counted in balances
--                       (migration 010's triggers sum by direction), never in received / dispatched / sales figures.
-- lots.closed_at …      when / who / why the lot was closed; NULL = open. close_reason: end_entry (an End entry),
--                       manual (owner's Close lot, issue #6) or register (End code in the sales register, issue #7).
-- lot_closures          history: every close and reopen with the meters written off and the movements involved.

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS closed_at    TIMESTAMP,
  ADD COLUMN IF NOT EXISTS closed_by    VARCHAR(50),
  ADD COLUMN IF NOT EXISTS close_reason VARCHAR(12),
  ADD COLUMN IF NOT EXISTS close_note   TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lots_close_reason_check') THEN
    ALTER TABLE lots ADD CONSTRAINT lots_close_reason_check
      CHECK ((closed_at IS NULL AND close_reason IS NULL) OR (closed_at IS NOT NULL AND close_reason IN ('end_entry', 'manual', 'register')));
  END IF;
  -- 013 allowed kind 'adjustment' on OUT rows only; a closing adjustment can be IN or OUT.
  ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_kind_check;
  ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check
    CHECK (kind IN ('normal', 'adjustment', 'closing') AND (kind <> 'adjustment' OR direction = 'OUT'));
END $$;

CREATE TABLE IF NOT EXISTS lot_closures (
  id              SERIAL PRIMARY KEY,
  lot_id          VARCHAR(50) NOT NULL REFERENCES lots (lot_id) ON UPDATE CASCADE ON DELETE CASCADE,
  action          VARCHAR(6)  NOT NULL CHECK (action IN ('close', 'reopen')),
  reason          VARCHAR(12) CHECK (reason IS NULL OR reason IN ('end_entry', 'manual', 'register')),
  adjustment_m    NUMERIC(14, 2) NOT NULL DEFAULT 0, -- + leftover written off (closing OUT), − excess written back (closing IN)
  movement_id     INTEGER,  -- the closing adjustment (NULL when the balance was already 0)
  end_movement_id INTEGER,  -- the End entry that closed it (reason end_entry / register)
  by_user         VARCHAR(50),
  note            TEXT,
  ts              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS lot_closures_lot_idx ON lot_closures (lot_id, id DESC);

-- Open lots are what every current-stock screen reads (issue #5); closed ones are listed newest first for the owner.
CREATE INDEX IF NOT EXISTS lots_closed_idx ON lots (closed_at DESC, lot_id) WHERE closed_at IS NOT NULL;
