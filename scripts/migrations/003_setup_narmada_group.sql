-- 003 — Initial setup for THIS install: Narmada Group, Surat.
-- For another firm's copy, delete this file before first run (or change the values);
-- everything here can also be changed later in the app under Settings.

UPDATE app_settings SET firm_name = 'Narmada Group', firm_city = 'Surat', updated_at = CURRENT_TIMESTAMP
WHERE id = 1 AND firm_name = 'Your firm';

UPDATE users SET name = 'Mukesh' WHERE id = 'usr-owner' AND name IN ('Naresh Kumar', 'Owner');

-- Section order as used on the floor
UPDATE sections SET sort_order = CASE lower(name) WHEN 'weaving' THEN 1 WHEN 'dyeing' THEN 2 WHEN 'printing' THEN 3 WHEN 'folding' THEN 4 ELSE sort_order END;

-- Supervisor responsibilities
INSERT INTO supervisor_sections (user_id, section_id)
SELECT u.id, s.id
FROM (VALUES ('usr-sup1', 'folding'), ('usr-sup1', 'dyeing'), ('usr-sup2', 'weaving'), ('usr-sup2', 'printing')) AS m(user_id, section)
JOIN users u ON u.id = m.user_id
JOIN sections s ON lower(s.name) = m.section
ON CONFLICT DO NOTHING;
