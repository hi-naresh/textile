-- 004 — Phase 1 of "Textile Brain — Discussed Changes To Implement".
-- Additive and idempotent: new nullable columns, new tables. Safe on a live database and to re-run.

-- App accounts can be linked to a worker record (worker logins only see their own work).
ALTER TABLE users ADD COLUMN IF NOT EXISTS worker_id VARCHAR(50) REFERENCES workers(id) ON DELETE SET NULL;

-- Photo reads: which engine produced the read (ocr / llm_text / llm_vision / mock), how long it took
-- the person, and where the compressed audit copy is. photo_url is filled in by the background job.
ALTER TABLE capture_events ALTER COLUMN photo_url DROP NOT NULL;
ALTER TABLE capture_events
  ADD COLUMN IF NOT EXISTS read_engine VARCHAR(20),
  ADD COLUMN IF NOT EXISTS read_meta JSONB,
  ADD COLUMN IF NOT EXISTS captured_by VARCHAR(50) REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS capture_seconds NUMERIC(8, 1) CHECK (capture_seconds IS NULL OR capture_seconds >= 0),
  ADD COLUMN IF NOT EXISTS review_seconds NUMERIC(8, 1) CHECK (review_seconds IS NULL OR review_seconds >= 0),
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP;

-- Developer-facing log of every paid AI call (OCR and LLM): feature, model tier, tokens, latency, cost.
CREATE TABLE IF NOT EXISTS llm_usage (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  feature VARCHAR(40) NOT NULL,           -- e.g. capture.ocr, capture.llm_text, chat.intent, chat.rag
  provider VARCHAR(20) NOT NULL,          -- google_vision | gemini
  model VARCHAR(80) NOT NULL,
  tier VARCHAR(10) NOT NULL CHECK (tier IN ('ocr', 'low', 'high')),
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  units INTEGER NOT NULL DEFAULT 0,       -- billable units that aren't tokens (OCR images)
  latency_ms INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  success BOOLEAN NOT NULL,
  error TEXT,
  ref VARCHAR(60)                         -- e.g. capture:123, chat:45
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_ts ON llm_usage (ts DESC);

-- Firm knowledge for chat answers (policies, party terms, how-tos). Searched with Postgres full-text search.
CREATE TABLE IF NOT EXISTS knowledge_docs (
  id SERIAL PRIMARY KEY,
  title VARCHAR(150) NOT NULL CHECK (length(btrim(title)) > 0),
  body TEXT NOT NULL CHECK (length(btrim(body)) > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(body, '')), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS idx_knowledge_docs_search ON knowledge_docs USING GIN (search);

-- Time-saved baseline: how long the same work takes by hand (owner can change in Settings → Rules).
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS manual_challan_min NUMERIC(6, 2) NOT NULL DEFAULT 6.00 CHECK (manual_challan_min > 0 AND manual_challan_min <= 120),
  ADD COLUMN IF NOT EXISTS manual_job_card_min NUMERIC(6, 2) NOT NULL DEFAULT 4.00 CHECK (manual_job_card_min > 0 AND manual_job_card_min <= 120);
