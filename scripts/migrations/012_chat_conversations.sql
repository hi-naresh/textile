-- Conversations are private to the acting user and their current access scope.
-- Audit records remain separate; clearing a chat removes its messages and memory.
CREATE TABLE chat_conversations (
  id UUID PRIMARY KEY,
  user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  summarized_through BIGINT NOT NULL DEFAULT 0,
  language JSONB,
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope_key)
);

CREATE TABLE chat_turns (
  id BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  question TEXT NOT NULL,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, request_id)
);
CREATE INDEX chat_turns_history ON chat_turns (conversation_id, id DESC);
