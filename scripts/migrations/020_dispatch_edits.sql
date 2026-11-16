-- Owner corrections to dispatch headers. Movement corrections use ledger_edits.
CREATE TABLE IF NOT EXISTS dispatch_edits (
  id BIGSERIAL PRIMARY KEY,
  dispatch_id INTEGER NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  before_value JSONB NOT NULL,
  after_value JSONB NOT NULL,
  edited_by VARCHAR(50) REFERENCES users(id) ON DELETE SET NULL,
  edited_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS dispatch_edits_dispatch_idx ON dispatch_edits (dispatch_id, id DESC);
