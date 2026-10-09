-- 012 — WhatsApp (Meta WhatsApp Cloud API, direct): owner switches + template names, and a log of every
-- message sent or received (payment reminders, dispatch messages, morning summary, tests, replies from parties).
-- Party numbers reuse parties.phone (10-digit Indian mobile). Idempotent.

-- 1. One settings row. Switches are the owner's (My firm → Policy → WhatsApp); template names and language
--    are the developer's (developer console → WhatsApp). Everything starts switched off.
CREATE TABLE IF NOT EXISTS whatsapp_settings (
  id                SMALLINT     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  auto_reminders    BOOLEAN      NOT NULL DEFAULT false,         -- daily job sends payment reminders by itself
  reminder_days     INTEGER      NOT NULL DEFAULT 7 CHECK (reminder_days BETWEEN 1 AND 365), -- bills overdue by at least N days
  dispatch_messages BOOLEAN      NOT NULL DEFAULT false,         -- message the party when a dispatch is recorded
  morning_summary   BOOLEAN      NOT NULL DEFAULT false,         -- daily summary to the owner
  summary_extra     TEXT[]       NOT NULL DEFAULT '{}',          -- extra numbers for the summary (10-digit)
  lang              VARCHAR(10)  NOT NULL DEFAULT 'en',          -- template language code as created in WhatsApp Manager
  tpl_reminder      VARCHAR(100) NOT NULL DEFAULT 'payment_reminder',
  tpl_dispatch      VARCHAR(100) NOT NULL DEFAULT 'dispatch_update',
  tpl_summary       VARCHAR(100) NOT NULL DEFAULT 'daily_summary',
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_by        VARCHAR(80)
);
INSERT INTO whatsapp_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 2. Message log. direction out = we sent it (always a template), in = a party / person wrote to us.
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id            BIGSERIAL    PRIMARY KEY,
  direction     VARCHAR(3)   NOT NULL CHECK (direction IN ('out', 'in')),
  purpose       VARCHAR(12)  NOT NULL CHECK (purpose IN ('reminder', 'dispatch', 'summary', 'test', 'incoming')),
  phone         VARCHAR(20)  NOT NULL,                     -- the other side, E.164 digits without + (91XXXXXXXXXX)
  template      VARCHAR(100),
  lang          VARCHAR(10),
  params        JSONB,                                     -- template variables (out) / {name, type} (in)
  body          TEXT,                                      -- text received (in)
  party_id      INTEGER      REFERENCES parties(id) ON DELETE SET NULL,
  invoice_ids   INTEGER[],
  dispatch_id   INTEGER      REFERENCES dispatches(id) ON DELETE SET NULL,
  status        VARCHAR(10)  NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed', 'received')),
  error         TEXT,
  error_code    INTEGER,
  wa_id         VARCHAR(200),                              -- WhatsApp message id (wamid.…)
  dedupe_key    VARCHAR(200),                              -- same key → sent once (failed ones may be retried)
  sent_by       VARCHAR(80),                               -- users.id, or 'auto' for the daily job / dispatch hook
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ,
  read_at       TIMESTAMPTZ,
  failed_at     TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_wa_id ON whatsapp_messages (wa_id) WHERE wa_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_dedupe ON whatsapp_messages (dedupe_key) WHERE dedupe_key IS NOT NULL AND status <> 'failed';
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_created ON whatsapp_messages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_party ON whatsapp_messages (party_id, purpose, created_at DESC) WHERE party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_dispatch ON whatsapp_messages (dispatch_id, created_at DESC) WHERE dispatch_id IS NOT NULL;
