-- 013 — The firm's real paper/Excel registers (INCOMING lot register, OUTGOING sales register).
-- Idempotent. Runs inside one transaction (scripts/migrate.js).
--
-- stock_movements
--   kind            'normal' (default) | 'adjustment'. An adjustment is an OUT written by the Incoming-register
--                   import so the lot's balance equals the register's STOCK column (MTR − what S-1…S-10 took out
--                   before the import). Not a sale: no party, no order. It counts as OUT in every balance
--                   (migration 010's triggers sum by direction, so nothing changes there).
--   register_pct    IN:  the register's "%" column (meaning not confirmed — docs/AMBIGUOUS.md)
--   takes           IN:  S-1 … S-10 as given (meters taken out of the lot before the import; NULL = empty cell)
--   loc_code        IN:  the register's LOCATION code as written ("212", "142+143", "56+57+l")
--   bill_pct        OUT: the sales register's "L" column (NQTY = QTY × L / 100)
--   billed_meters   OUT: NQTY as given
--   lot_status_code OUT: "LOT S" code as given (R / E / S / A …) — data only, never changes a balance
--   linked_sr       OUT: the sales register's SR.NO text = the incoming SR of the lot sold ("102", "146+204");
--                   adjustments carry their lot's incoming SR here too. Imported OUT rows have sr_no NULL.
-- lots
--   reg_lot_no      the register's LOT NO as written. lot_id is the same unless that number was already taken
--                   by another lot (lot numbers repeat across mills) → lot_id = "<LOT NO>-SR<SRNO>".
--   loc_code        the register LOCATION code of the lot's incoming entry.
-- search_doc (migration 010) now also holds loc_code, linked_sr and lot_status_code, so the ledger search finds a
-- bill no. (already there as source_doc_id), a location code or a linked SR.

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS kind            VARCHAR(12) NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS register_pct    NUMERIC(6, 2),
  ADD COLUMN IF NOT EXISTS takes           NUMERIC(12, 2)[],
  ADD COLUMN IF NOT EXISTS loc_code        VARCHAR(40),
  ADD COLUMN IF NOT EXISTS bill_pct        NUMERIC(7, 2),
  ADD COLUMN IF NOT EXISTS billed_meters   NUMERIC(14, 4),
  ADD COLUMN IF NOT EXISTS lot_status_code VARCHAR(5),
  ADD COLUMN IF NOT EXISTS linked_sr       VARCHAR(40);

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS reg_lot_no VARCHAR(30),
  ADD COLUMN IF NOT EXISTS loc_code   VARCHAR(40);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_kind_check') THEN
    ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check
      CHECK (kind IN ('normal', 'adjustment') AND (kind = 'normal' OR direction = 'OUT'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_register_pct_check') THEN
    ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_register_pct_check
      CHECK (register_pct IS NULL OR (register_pct >= 0 AND register_pct <= 100));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_bill_pct_check') THEN
    ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_bill_pct_check
      CHECK (bill_pct IS NULL OR (bill_pct > 0 AND bill_pct <= 1000));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_billed_meters_check') THEN
    ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_billed_meters_check
      CHECK (billed_meters IS NULL OR billed_meters >= 0);
  END IF;
END $$;

-- Search text: same as 010 plus the register fields (concat_ws skips NULLs, so existing rows keep the same text).
CREATE OR REPLACE FUNCTION sm_search_doc_trg() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  q TEXT; d TEXT; loc TEXT;
BEGIN
  SELECT quality, design INTO q, d FROM lots WHERE lot_id = NEW.lot_id;
  IF TG_OP = 'UPDATE' THEN
    SELECT location INTO loc FROM lot_locations
     WHERE lot_id = NEW.lot_id AND stock_movement_id = NEW.id ORDER BY id DESC LIMIT 1;
  END IF;
  NEW.search_doc := lower(concat_ws(' ', NEW.lot_id, q, d, NEW.party, NEW.mill_name, NEW.weaver_name, NEW.source_doc_id, loc,
                                    NEW.loc_code, NEW.linked_sr, NEW.lot_status_code));
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS sm_search_doc_trg ON stock_movements;
CREATE TRIGGER sm_search_doc_trg BEFORE INSERT OR UPDATE OF lot_id, party, mill_name, weaver_name, source_doc_id, search_doc,
  loc_code, linked_sr, lot_status_code
  ON stock_movements FOR EACH ROW EXECUTE FUNCTION sm_search_doc_trg();

-- Rows that already have register fields (only on a re-run): rebuild their text.
UPDATE stock_movements SET search_doc = NULL
 WHERE (loc_code IS NOT NULL OR linked_sr IS NOT NULL OR lot_status_code IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_sm_linked_sr ON stock_movements (linked_sr) WHERE linked_sr IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lots_reg_lot_no ON lots (reg_lot_no) WHERE reg_lot_no IS NOT NULL;
