-- 002 — Per-firm settings, so the product can be set up for any firm without code changes.
-- Generic: neutral defaults only. Firm-specific values go in a separate setup migration (see 003).

-- One row of firm-wide settings.
CREATE TABLE IF NOT EXISTS app_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  firm_name VARCHAR(100) NOT NULL DEFAULT 'Your firm' CHECK (length(btrim(firm_name)) > 0),
  firm_city VARCHAR(100) NOT NULL DEFAULT '',
  shortage_limit_pct NUMERIC(5, 2) NOT NULL DEFAULT 3.00 CHECK (shortage_limit_pct > 0 AND shortage_limit_pct <= 50),
  efficiency_target_pct NUMERIC(5, 2) NOT NULL DEFAULT 85.00 CHECK (efficiency_target_pct > 0 AND efficiency_target_pct <= 100),
  ai_auto_confirm_pct NUMERIC(5, 2) NOT NULL DEFAULT 80.00 CHECK (ai_auto_confirm_pct >= 50 AND ai_auto_confirm_pct <= 100),
  location_presets TEXT[] NOT NULL DEFAULT ARRAY['Godown', 'Shop', 'Floor'],
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Sections / processes of the firm (Weaving, Dyeing, Folding, ...).
CREATE TABLE IF NOT EXISTS sections (
  id SERIAL PRIMARY KEY,
  name VARCHAR(60) NOT NULL CHECK (length(btrim(name)) > 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX IF NOT EXISTS sections_name_ci_unique ON sections (lower(name));

-- Which sections each supervisor is responsible for.
CREATE TABLE IF NOT EXISTS supervisor_sections (
  user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, section_id)
);
CREATE INDEX IF NOT EXISTS supervisor_sections_section_idx ON supervisor_sections (section_id);

-- Start the section list from data already in the database ("Folding Section" → "Folding").
INSERT INTO sections (name)
SELECT DISTINCT n FROM (
  SELECT btrim(regexp_replace(section, '\s*section\s*$', '', 'i')) AS n FROM workers
  UNION
  SELECT btrim(process) FROM job_cards
) src
WHERE n <> '' AND NOT EXISTS (SELECT 1 FROM sections s WHERE lower(s.name) = lower(src.n));
