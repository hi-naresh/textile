CREATE TABLE api_rate_limits (
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (user_id, scope)
);

CREATE INDEX api_rate_limits_window_started_at_idx ON api_rate_limits (window_started_at);
