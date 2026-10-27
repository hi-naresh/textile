-- 017 — Quality catalog, several pipes per lot location, final meters when a lot ends. Idempotent.
--
-- The owner (Surat): "Build a quality catalog. Whatever lot comes, it always picks from those qualities only."
-- "A single lot can exist in multiple pipes … pipe number can be ABCD256 or A25250, a combination of both."
-- "When that particular lot is ended, we should ask also the final meters … so we update the shortage again."
--
-- qualities              the catalog. New lots typed by hand (manual entry, ledger edit) must use an active entry.
--                        Seeded once from the qualities the lots already have (never "Unknown Quality").
-- lot_locations.pipe_no  now text: one or more pipes, upper case, comma separated ("A25, B3"). Was SMALLINT 1–999;
--                        old numbers are kept as text ("3").
-- lots.final_meters      meters the lot really gave when it ended (after folding / packing). Shortage at the end =
--                        grey received − final meters. NULL = not ended / not recorded.
-- lot_closures.final_meters  history copy for each close.

CREATE TABLE IF NOT EXISTS qualities (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(100) NOT NULL CHECK (length(btrim(name)) > 0),
  active     BOOLEAN      NOT NULL DEFAULT true,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by VARCHAR(50)  REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS qualities_name_ci ON qualities (lower(btrim(name)));

INSERT INTO qualities (name)
SELECT DISTINCT ON (lower(btrim(quality))) btrim(quality)
  FROM lots
 WHERE quality IS NOT NULL AND btrim(quality) <> '' AND lower(btrim(quality)) <> 'unknown quality'
 ORDER BY lower(btrim(quality)), quality
ON CONFLICT DO NOTHING;

ALTER TABLE lot_locations DROP CONSTRAINT IF EXISTS lot_locations_pipe_no_range;
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns WHERE table_name = 'lot_locations' AND column_name = 'pipe_no') <> 'character varying' THEN
    ALTER TABLE lot_locations ALTER COLUMN pipe_no TYPE VARCHAR(140) USING pipe_no::text;
  END IF;
END $$;

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS final_meters NUMERIC(14, 2) CHECK (final_meters IS NULL OR final_meters >= 0);
ALTER TABLE lot_closures
  ADD COLUMN IF NOT EXISTS final_meters NUMERIC(14, 2);

-- Location filter on current stock ("LM 245 …"): prefix search on the lot's current place.
CREATE INDEX IF NOT EXISTS idx_lots_cur_location_prefix ON lots (cur_location text_pattern_ops) WHERE cur_location IS NOT NULL;
