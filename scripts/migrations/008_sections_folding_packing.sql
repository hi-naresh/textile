-- 008 — The firm only runs Folding and Packing for now (owner's request).
-- Make sure both sections exist and are on; switch every other section off.
-- Rows are kept (not deleted) so old job cards, workers and reports keep their history.
-- Idempotent: running it again changes nothing.

INSERT INTO sections (name, sort_order, active)
SELECT v.name, v.sort_order, TRUE
FROM (VALUES ('Folding', 1), ('Packing', 2)) AS v(name, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM sections s
  WHERE lower(btrim(regexp_replace(s.name, '\s*section\s*$', '', 'i'))) = lower(v.name)
);

UPDATE sections
SET active = (lower(btrim(regexp_replace(name, '\s*section\s*$', '', 'i'))) IN ('folding', 'packing')),
    sort_order = CASE lower(btrim(regexp_replace(name, '\s*section\s*$', '', 'i')))
                   WHEN 'folding' THEN 1 WHEN 'packing' THEN 2 ELSE sort_order END
WHERE active IS DISTINCT FROM (lower(btrim(regexp_replace(name, '\s*section\s*$', '', 'i'))) IN ('folding', 'packing'))
   OR (lower(btrim(regexp_replace(name, '\s*section\s*$', '', 'i'))) = 'folding' AND sort_order <> 1)
   OR (lower(btrim(regexp_replace(name, '\s*section\s*$', '', 'i'))) = 'packing' AND sort_order <> 2);
