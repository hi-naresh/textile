-- 011 — Agents: per-agent on/off switch + settings (developer console → Agents), and a run log
-- so the console can show when each agent last ran, how long it took and whether it failed.
-- Idempotent.

-- 1. One row per agent the developer has touched. No row = the agent's default (see src/lib/agents/catalog.ts).
CREATE TABLE IF NOT EXISTS agent_settings (
  agent       VARCHAR(30)  PRIMARY KEY,
  enabled     BOOLEAN      NOT NULL,
  settings    JSONB        NOT NULL DEFAULT '{}'::jsonb,   -- e.g. {"max_open": 8}
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_by  VARCHAR(80)                                 -- developer email / id (not a users.id)
);

-- 2. Every scan of every agent (cron, background refresh after a change, or "Run now").
CREATE TABLE IF NOT EXISTS agent_runs (
  id           BIGSERIAL    PRIMARY KEY,
  agent        VARCHAR(30)  NOT NULL,
  trigger      VARCHAR(20)  NOT NULL DEFAULT 'auto',       -- auto | cron | manual
  started_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  duration_ms  INTEGER      NOT NULL DEFAULT 0,
  ok           BOOLEAN      NOT NULL DEFAULT true,
  error        TEXT,
  open_after   INTEGER                                     -- the agent's open suggestions after the run
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs (agent, started_at DESC);

-- 3. Stats per agent (raised / accepted / dismissed in 7 and 30 days) and quiet-period lookups.
CREATE INDEX IF NOT EXISTS idx_agent_suggestions_agent ON agent_suggestions (agent, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_suggestions_decided ON agent_suggestions (dedupe_key, decided_at DESC) WHERE status IN ('accepted', 'rejected');

-- 4. The Costing agent needs selling rates and process costs, which the owner turned off: start it switched off.
INSERT INTO agent_settings (agent, enabled, updated_by) VALUES ('costing', false, 'migration 011')
ON CONFLICT (agent) DO NOTHING;

-- 5. Report cards are owner only now (supervisors have no Reports screen).
UPDATE agent_suggestions SET owner_only = true WHERE agent = 'reports' AND status = 'open' AND NOT owner_only;
