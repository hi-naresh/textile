-- 010 — Fast stock screens at any size (millions of movements).
-- Idempotent. Runs inside one transaction (scripts/migrate.js).
--
-- 1. Per-lot running state kept ON the lot row (no more summing every movement on each screen load):
--      lots.in_total_m / out_total_m / bal_m / last_move_at        ← stock_movements (insert / update / delete)
--      lots.cur_location / cur_location_stage / cur_location_ts     ← lot_locations   (insert / update / delete)
--    Maintained by triggers, so every writer (manual entry, photo reads, Excel import, dispatches,
--    job cards, ledger edit mode, deletes) keeps them right without code changes.
--    Names are prefixed (bal_m, cur_location …) so they never clash with the `balance` / `location`
--    aliases older queries compute.
-- 2. stock_movements.search_doc: lower-case text of lot no., quality, design, party, mill, weaver,
--    challan and the location the movement put the lot in → one trigram index serves the ledger search.
-- 3. Small side tables instead of DISTINCT over every movement / lot:
--      lot_facets  (quality, design, n)   — ledger filter dropdowns, order qualities
--      known_names (kind, name, n)        — mill / weaver / party suggestions
-- 4. stock_rev sequence: bumped by every stock change, so the app can skip reloads when nothing changed.
-- 5. Indexes (pg_trgm when the server has it — Postgres 16 and Supabase both ship it; without it
--    search still works, just unindexed).

-- ---------- 0. pg_trgm (optional) ----------
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm is not available (%); text search will work without trigram indexes.', SQLERRM;
END $$;

-- ---------- 1. columns + side tables ----------
ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS in_total_m         NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS out_total_m        NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bal_m              NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_move_at       TIMESTAMP,
  ADD COLUMN IF NOT EXISTS cur_location       VARCHAR(100),
  ADD COLUMN IF NOT EXISTS cur_location_stage VARCHAR(20),
  ADD COLUMN IF NOT EXISTS cur_location_ts    TIMESTAMP;

ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS search_doc TEXT;

CREATE TABLE IF NOT EXISTS lot_facets (
  quality VARCHAR(100) NOT NULL,
  design  VARCHAR(100) NOT NULL,
  n       INTEGER      NOT NULL,
  PRIMARY KEY (quality, design)
);

CREATE TABLE IF NOT EXISTS known_names (
  kind VARCHAR(10)  NOT NULL CHECK (kind IN ('mill', 'weaver', 'party')),
  name VARCHAR(150) NOT NULL,
  n    INTEGER      NOT NULL,
  PRIMARY KEY (kind, name)
);

CREATE SEQUENCE IF NOT EXISTS stock_rev;

-- Old triggers off while backfilling (re-runs recompute everything set-based below).
DROP TRIGGER IF EXISTS sm_search_doc_trg ON stock_movements;
DROP TRIGGER IF EXISTS sm_ins_stmt_trg ON stock_movements;
DROP TRIGGER IF EXISTS sm_upd_stmt_trg ON stock_movements;
DROP TRIGGER IF EXISTS sm_del_stmt_trg ON stock_movements;
DROP TRIGGER IF EXISTS ll_ins_stmt_trg ON lot_locations;
DROP TRIGGER IF EXISTS ll_upd_stmt_trg ON lot_locations;
DROP TRIGGER IF EXISTS ll_del_stmt_trg ON lot_locations;
DROP TRIGGER IF EXISTS lots_attr_trg ON lots;
DROP TRIGGER IF EXISTS lots_facet_trg ON lots;
DROP TRIGGER IF EXISTS lots_rev_trg ON lots;

-- ---------- 2. functions ----------

-- Recompute totals of these lots from their movements. Locks the lot rows first (fixed order), so the
-- sums below run on a fresh snapshot that includes any concurrent writer that committed first.
CREATE OR REPLACE FUNCTION lot_totals_refresh(ids TEXT[]) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF ids IS NULL OR cardinality(ids) = 0 THEN RETURN; END IF;
  PERFORM 1 FROM lots WHERE lot_id = ANY(ids) ORDER BY lot_id FOR NO KEY UPDATE;
  UPDATE lots l
     SET in_total_m = s.i, out_total_m = s.o, bal_m = s.i - s.o, last_move_at = s.t
    FROM (
      SELECT x.id AS lot_id,
             COALESCE(SUM(sm.meters) FILTER (WHERE sm.direction = 'IN'), 0)  AS i,
             COALESCE(SUM(sm.meters) FILTER (WHERE sm.direction = 'OUT'), 0) AS o,
             MAX(sm.ts) AS t
        FROM unnest(ids) AS x(id)
        LEFT JOIN stock_movements sm ON sm.lot_id = x.id
       GROUP BY x.id
    ) s
   WHERE l.lot_id = s.lot_id
     AND (l.in_total_m, l.out_total_m, l.bal_m, l.last_move_at) IS DISTINCT FROM (s.i, s.o, s.i - s.o, s.t);
END $$;

-- Current location of these lots = their latest lot_locations row (ts, then id).
CREATE OR REPLACE FUNCTION lot_location_refresh(ids TEXT[]) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF ids IS NULL OR cardinality(ids) = 0 THEN RETURN; END IF;
  PERFORM 1 FROM lots WHERE lot_id = ANY(ids) ORDER BY lot_id FOR NO KEY UPDATE;
  UPDATE lots l
     SET cur_location = x.location, cur_location_stage = x.stage, cur_location_ts = x.ts
    FROM (
      SELECT i.id AS lot_id, ll.location, ll.stage, ll.ts
        FROM unnest(ids) AS i(id)
        LEFT JOIN LATERAL (
          SELECT location, stage, ts FROM lot_locations
           WHERE lot_id = i.id ORDER BY ts DESC, id DESC LIMIT 1
        ) ll ON true
    ) x
   WHERE l.lot_id = x.lot_id
     AND (l.cur_location, l.cur_location_stage, l.cur_location_ts) IS DISTINCT FROM (x.location, x.stage, x.ts);
END $$;

-- Add (sign +1) or remove (sign -1) name uses. Rows with n ≤ 0 go away.
CREATE OR REPLACE FUNCTION known_names_apply(kinds TEXT[], names TEXT[], deltas INT[]) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO known_names (kind, name, n)
  SELECT k, nm, SUM(d)::int FROM unnest(kinds, names, deltas) AS x(k, nm, d)
   WHERE nm IS NOT NULL AND btrim(nm) <> '' GROUP BY k, nm HAVING SUM(d) <> 0
   ORDER BY k, nm
  ON CONFLICT (kind, name) DO UPDATE SET n = known_names.n + EXCLUDED.n;
  DELETE FROM known_names kn USING unnest(kinds, names) AS u(k, nm)
   WHERE kn.kind = u.k AND kn.name = u.nm AND kn.n <= 0;
END $$;

-- Search text of one movement (lower case).
CREATE OR REPLACE FUNCTION sm_search_doc_trg() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  q TEXT; d TEXT; loc TEXT;
BEGIN
  SELECT quality, design INTO q, d FROM lots WHERE lot_id = NEW.lot_id;
  IF TG_OP = 'UPDATE' THEN
    SELECT location INTO loc FROM lot_locations
     WHERE lot_id = NEW.lot_id AND stock_movement_id = NEW.id ORDER BY id DESC LIMIT 1;
  END IF;
  NEW.search_doc := lower(concat_ws(' ', NEW.lot_id, q, d, NEW.party, NEW.mill_name, NEW.weaver_name, NEW.source_doc_id, loc));
  RETURN NEW;
END $$;

-- Statement-level: totals, names, rev. Inserts add deltas; updates / deletes recompute the touched lots.
CREATE OR REPLACE FUNCTION sm_stmt_trg() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  ids TEXT[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT lot_id ORDER BY lot_id) INTO ids FROM new_rows WHERE lot_id IS NOT NULL;
    IF ids IS NOT NULL THEN
      PERFORM 1 FROM lots WHERE lot_id = ANY(ids) ORDER BY lot_id FOR NO KEY UPDATE;
      UPDATE lots l
         SET in_total_m = l.in_total_m + d.i, out_total_m = l.out_total_m + d.o,
             bal_m = l.bal_m + d.i - d.o, last_move_at = GREATEST(l.last_move_at, d.t)
        FROM (
          SELECT lot_id,
                 COALESCE(SUM(meters) FILTER (WHERE direction = 'IN'), 0)  AS i,
                 COALESCE(SUM(meters) FILTER (WHERE direction = 'OUT'), 0) AS o,
                 MAX(ts) AS t
            FROM new_rows WHERE lot_id IS NOT NULL GROUP BY lot_id
        ) d
       WHERE l.lot_id = d.lot_id;
    END IF;
    PERFORM known_names_apply(array_agg(k), array_agg(nm), array_agg(1))
      FROM (SELECT 'mill' AS k, mill_name AS nm FROM new_rows
            UNION ALL SELECT 'weaver', weaver_name FROM new_rows
            UNION ALL SELECT 'party', party FROM new_rows WHERE direction = 'OUT') x
     WHERE nm IS NOT NULL
    HAVING count(*) > 0;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT array_agg(DISTINCT x ORDER BY x) INTO ids FROM (
      SELECT o.lot_id AS a, n.lot_id AS b FROM old_rows o JOIN new_rows n ON n.id = o.id
       WHERE (o.lot_id, o.direction, o.meters, o.ts) IS DISTINCT FROM (n.lot_id, n.direction, n.meters, n.ts)
    ) c, LATERAL (VALUES (c.a), (c.b)) v(x) WHERE x IS NOT NULL;
    PERFORM lot_totals_refresh(ids);
    PERFORM known_names_apply(array_agg(k), array_agg(nm), array_agg(dl))
      FROM (SELECT 'mill' AS k, mill_name AS nm, -1 AS dl FROM old_rows
            UNION ALL SELECT 'weaver', weaver_name, -1 FROM old_rows
            UNION ALL SELECT 'party', party, -1 FROM old_rows WHERE direction = 'OUT'
            UNION ALL SELECT 'mill', mill_name, 1 FROM new_rows
            UNION ALL SELECT 'weaver', weaver_name, 1 FROM new_rows
            UNION ALL SELECT 'party', party, 1 FROM new_rows WHERE direction = 'OUT') x
     WHERE nm IS NOT NULL
    HAVING count(*) > 0;
  ELSE -- DELETE
    SELECT array_agg(DISTINCT lot_id ORDER BY lot_id) INTO ids FROM old_rows WHERE lot_id IS NOT NULL;
    PERFORM lot_totals_refresh(ids);
    PERFORM known_names_apply(array_agg(k), array_agg(nm), array_agg(-1))
      FROM (SELECT 'mill' AS k, mill_name AS nm FROM old_rows
            UNION ALL SELECT 'weaver', weaver_name FROM old_rows
            UNION ALL SELECT 'party', party FROM old_rows WHERE direction = 'OUT') x
     WHERE nm IS NOT NULL
    HAVING count(*) > 0;
  END IF;
  PERFORM nextval('stock_rev');
  RETURN NULL;
END $$;

-- Statement-level on lot_locations: current location of touched lots + search text of linked movements.
CREATE OR REPLACE FUNCTION ll_stmt_trg() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  ids TEXT[];
  mv INT[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT lot_id ORDER BY lot_id), array_agg(DISTINCT stock_movement_id) FILTER (WHERE stock_movement_id IS NOT NULL)
      INTO ids, mv FROM new_rows;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT array_agg(DISTINCT lot_id ORDER BY lot_id), array_agg(DISTINCT m) FILTER (WHERE m IS NOT NULL) INTO ids, mv FROM (
      SELECT lot_id, stock_movement_id AS m FROM old_rows UNION ALL SELECT lot_id, stock_movement_id FROM new_rows) x;
  ELSE
    SELECT array_agg(DISTINCT lot_id ORDER BY lot_id), array_agg(DISTINCT stock_movement_id) FILTER (WHERE stock_movement_id IS NOT NULL)
      INTO ids, mv FROM old_rows;
  END IF;
  PERFORM lot_location_refresh(ids);
  IF mv IS NOT NULL THEN
    UPDATE stock_movements SET search_doc = NULL WHERE id = ANY(mv); -- BEFORE trigger rebuilds it
  END IF;
  PERFORM nextval('stock_rev');
  RETURN NULL;
END $$;

-- A lot's quality / design changed: rebuild the search text of its movements.
CREATE OR REPLACE FUNCTION lots_attr_trg() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE stock_movements SET search_doc = NULL WHERE lot_id = NEW.lot_id;
  RETURN NULL;
END $$;

-- lot_facets counts (quality, design) pairs.
CREATE OR REPLACE FUNCTION lots_facet_trg() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE lot_facets SET n = n - 1 WHERE quality = OLD.quality AND design = OLD.design;
    DELETE FROM lot_facets WHERE quality = OLD.quality AND design = OLD.design AND n <= 0;
  END IF;
  IF TG_OP IN ('UPDATE', 'INSERT') THEN
    INSERT INTO lot_facets (quality, design, n) VALUES (NEW.quality, NEW.design, 1)
    ON CONFLICT (quality, design) DO UPDATE SET n = lot_facets.n + 1;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION stock_rev_trg() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM nextval('stock_rev');
  RETURN NULL;
END $$;

-- ---------- 3. backfill (set-based) ----------
UPDATE lots l
   SET in_total_m = COALESCE(s.i, 0), out_total_m = COALESCE(s.o, 0), bal_m = COALESCE(s.i, 0) - COALESCE(s.o, 0), last_move_at = s.t
  FROM lots l2
  LEFT JOIN (
    SELECT lot_id,
           SUM(meters) FILTER (WHERE direction = 'IN')  AS i,
           SUM(meters) FILTER (WHERE direction = 'OUT') AS o,
           MAX(ts) AS t
      FROM stock_movements GROUP BY lot_id
  ) s ON s.lot_id = l2.lot_id
 WHERE l.lot_id = l2.lot_id
   AND (l.in_total_m, l.out_total_m, l.bal_m, l.last_move_at)
       IS DISTINCT FROM (COALESCE(s.i, 0), COALESCE(s.o, 0), COALESCE(s.i, 0) - COALESCE(s.o, 0), s.t);

UPDATE lots l
   SET cur_location = x.location, cur_location_stage = x.stage, cur_location_ts = x.ts
  FROM lots l2
  LEFT JOIN (
    SELECT DISTINCT ON (lot_id) lot_id, location, stage, ts
      FROM lot_locations ORDER BY lot_id, ts DESC, id DESC
  ) x ON x.lot_id = l2.lot_id
 WHERE l.lot_id = l2.lot_id
   AND (l.cur_location, l.cur_location_stage, l.cur_location_ts) IS DISTINCT FROM (x.location, x.stage, x.ts);

UPDATE stock_movements sm
   SET search_doc = x.doc
  FROM (
    SELECT sm2.id, lower(concat_ws(' ', sm2.lot_id, l.quality, l.design, sm2.party, sm2.mill_name, sm2.weaver_name, sm2.source_doc_id, loc.location)) AS doc
      FROM stock_movements sm2
      LEFT JOIN lots l ON l.lot_id = sm2.lot_id
      LEFT JOIN (
        SELECT DISTINCT ON (stock_movement_id) stock_movement_id, location
          FROM lot_locations WHERE stock_movement_id IS NOT NULL
         ORDER BY stock_movement_id, id DESC
      ) loc ON loc.stock_movement_id = sm2.id
  ) x
 WHERE sm.id = x.id AND sm.search_doc IS DISTINCT FROM x.doc;

DELETE FROM lot_facets;
INSERT INTO lot_facets (quality, design, n) SELECT quality, design, count(*) FROM lots GROUP BY quality, design;

DELETE FROM known_names;
INSERT INTO known_names (kind, name, n)
SELECT k, nm, count(*) FROM (
  SELECT 'mill' AS k, mill_name AS nm FROM stock_movements WHERE mill_name IS NOT NULL
  UNION ALL SELECT 'weaver', weaver_name FROM stock_movements WHERE weaver_name IS NOT NULL
  UNION ALL SELECT 'party', party FROM stock_movements WHERE direction = 'OUT' AND party IS NOT NULL
) x WHERE btrim(nm) <> '' GROUP BY k, nm;

-- ---------- 4. triggers ----------
CREATE TRIGGER sm_search_doc_trg BEFORE INSERT OR UPDATE OF lot_id, party, mill_name, weaver_name, source_doc_id, search_doc
  ON stock_movements FOR EACH ROW EXECUTE FUNCTION sm_search_doc_trg();
CREATE TRIGGER sm_ins_stmt_trg AFTER INSERT ON stock_movements REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sm_stmt_trg();
CREATE TRIGGER sm_upd_stmt_trg AFTER UPDATE ON stock_movements REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sm_stmt_trg();
CREATE TRIGGER sm_del_stmt_trg AFTER DELETE ON stock_movements REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sm_stmt_trg();

CREATE TRIGGER ll_ins_stmt_trg AFTER INSERT ON lot_locations REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ll_stmt_trg();
CREATE TRIGGER ll_upd_stmt_trg AFTER UPDATE ON lot_locations REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ll_stmt_trg();
CREATE TRIGGER ll_del_stmt_trg AFTER DELETE ON lot_locations REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION ll_stmt_trg();

CREATE TRIGGER lots_attr_trg AFTER UPDATE OF quality, design ON lots FOR EACH ROW
  WHEN (OLD.quality IS DISTINCT FROM NEW.quality OR OLD.design IS DISTINCT FROM NEW.design)
  EXECUTE FUNCTION lots_attr_trg();
CREATE TRIGGER lots_facet_trg AFTER INSERT OR DELETE OR UPDATE OF quality, design ON lots FOR EACH ROW
  EXECUTE FUNCTION lots_facet_trg();
CREATE TRIGGER lots_rev_trg AFTER INSERT OR DELETE OR UPDATE OF quality, design, grade, status ON lots FOR EACH STATEMENT
  EXECUTE FUNCTION stock_rev_trg();

-- ---------- 5. indexes ----------
CREATE INDEX IF NOT EXISTS idx_lots_in_stock_bal ON lots (bal_m) WHERE bal_m > 0;           -- on-hand sum, low lots
CREATE INDEX IF NOT EXISTS idx_lots_in_stock_id  ON lots (lot_id) WHERE bal_m > 0;          -- lots page, in stock only
CREATE INDEX IF NOT EXISTS idx_lots_lot_c        ON lots ((lower(lot_id::text) COLLATE "C")); -- lot no. type-ahead (prefix + order)
CREATE INDEX IF NOT EXISTS idx_sm_sr_no          ON stock_movements (sr_no) WHERE sr_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sm_dir_ts         ON stock_movements (direction, ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sm_ts_cover      ON stock_movements (ts) INCLUDE (direction, meters); -- 7-day flow / today totals, index-only
CREATE INDEX IF NOT EXISTS idx_lot_locations_mv  ON lot_locations (stock_movement_id) WHERE stock_movement_id IS NOT NULL;

DO $$
DECLARE
  s TEXT;
BEGIN
  SELECT n.nspname INTO s FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm';
  IF s IS NULL THEN
    RAISE NOTICE 'pg_trgm missing: skipping trigram indexes.';
    RETURN;
  END IF;
  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_sm_search_trgm ON stock_movements USING gin (search_doc %I.gin_trgm_ops)', s);
  -- Must match the expression used by src/app/api/lots (LOT_DOC) exactly.
  EXECUTE format($f$CREATE INDEX IF NOT EXISTS idx_lots_search_trgm ON lots USING gin
    (lower(lot_id::text || ' ' || quality::text || ' ' || design::text || ' ' || COALESCE(cur_location, '')::text) %I.gin_trgm_ops)$f$, s);
END $$;

ANALYZE lots;
ANALYZE stock_movements;
ANALYZE lot_locations;
