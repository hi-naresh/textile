-- Review metadata only: stock is unchanged until a confirmed chunk commits.
CREATE TABLE stock_import_reviews (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  rows JSONB NOT NULL,
  confirmed_rows JSONB,
  committed_count INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 day'
);
CREATE INDEX stock_import_reviews_expiry_idx ON stock_import_reviews (expires_at);
