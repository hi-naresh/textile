-- 005 — Phase 2: agents (inquiries, orders, allocation, dispatch, documents, GST invoices,
-- credit & payments, costing & margin, inventory alerts, reports).
-- Additive and idempotent: new tables + nullable columns only. Safe on a live database and to re-run.

-- ---------- master data ----------
-- Clients (parties). name_key makes "Shree Balaji Sarees" and "SHREE BALAJI SAREES." the same party.
CREATE TABLE IF NOT EXISTS parties (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL CHECK (length(btrim(name)) > 0),
  name_key VARCHAR(150) GENERATED ALWAYS AS (regexp_replace(lower(name), '[^a-z0-9]', '', 'g')) STORED,
  phone VARCHAR(20),
  gstin VARCHAR(15) CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  address TEXT,
  city VARCHAR(100),
  state_code VARCHAR(2) CHECK (state_code IS NULL OR state_code ~ '^[0-9]{2}$'),
  credit_limit NUMERIC(14, 2) CHECK (credit_limit IS NULL OR credit_limit >= 0), -- ₹; NULL = no limit
  credit_days INTEGER NOT NULL DEFAULT 30 CHECK (credit_days BETWEEN 0 AND 365),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS parties_name_key_unique ON parties (name_key);
-- Start the list from parties already used on dispatches.
INSERT INTO parties (name)
SELECT DISTINCT ON (regexp_replace(lower(party), '[^a-z0-9]', '', 'g')) btrim(party)
FROM stock_movements WHERE direction = 'OUT' AND party IS NOT NULL AND btrim(party) <> ''
ON CONFLICT (name_key) DO NOTHING;

-- Selling rate ₹/m by quality, optionally for one party. Latest valid_from ≤ date wins; party rate beats general.
CREATE TABLE IF NOT EXISTS rates (
  id SERIAL PRIMARY KEY,
  quality VARCHAR(100) NOT NULL CHECK (length(btrim(quality)) > 0),
  party_id INTEGER REFERENCES parties(id) ON DELETE CASCADE,
  rate_per_m NUMERIC(10, 2) NOT NULL CHECK (rate_per_m > 0),
  valid_from DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by VARCHAR(50) REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rates_lookup ON rates (lower(quality), party_id, valid_from DESC);

-- Process cost ₹/m by section (weaving, dyeing, folding …).
CREATE TABLE IF NOT EXISTS process_costs (
  id SERIAL PRIMARY KEY,
  section VARCHAR(60) NOT NULL CHECK (length(btrim(section)) > 0),
  cost_per_m NUMERIC(10, 2) NOT NULL CHECK (cost_per_m >= 0),
  valid_from DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by VARCHAR(50) REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_process_costs_lookup ON process_costs (lower(section), valid_from DESC);

-- Firm billing details (GST invoices) + agent thresholds.
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS legal_name VARCHAR(150),
  ADD COLUMN IF NOT EXISTS gstin VARCHAR(15) CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS state_code VARCHAR(2) DEFAULT '24' CHECK (state_code IS NULL OR state_code ~ '^[0-9]{2}$'), -- 24 = Gujarat
  ADD COLUMN IF NOT EXISTS phone VARCHAR(20),
  ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS bank_account VARCHAR(40),
  ADD COLUMN IF NOT EXISTS bank_ifsc VARCHAR(11),
  ADD COLUMN IF NOT EXISTS invoice_prefix VARCHAR(12) NOT NULL DEFAULT 'INV',
  ADD COLUMN IF NOT EXISTS next_invoice_no INTEGER NOT NULL DEFAULT 1 CHECK (next_invoice_no > 0),
  ADD COLUMN IF NOT EXISTS hsn_code VARCHAR(8) NOT NULL DEFAULT '5407',
  ADD COLUMN IF NOT EXISTS gst_rate_pct NUMERIC(5, 2) NOT NULL DEFAULT 5.00 CHECK (gst_rate_pct >= 0 AND gst_rate_pct <= 28),
  ADD COLUMN IF NOT EXISTS low_stock_m NUMERIC(10, 2) NOT NULL DEFAULT 200 CHECK (low_stock_m >= 0),
  ADD COLUMN IF NOT EXISTS ageing_days INTEGER NOT NULL DEFAULT 60 CHECK (ageing_days BETWEEN 1 AND 730);

-- Purchase (grey) rate from the challan / cutting report (Pu.Rate), for costing.
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS purchase_rate NUMERIC(10, 2) CHECK (purchase_rate IS NULL OR purchase_rate >= 0);

-- ---------- sales ----------
CREATE TABLE IF NOT EXISTS inquiries (
  id SERIAL PRIMARY KEY,
  party_id INTEGER REFERENCES parties(id) ON DELETE SET NULL,
  party_name VARCHAR(150),
  source VARCHAR(20) NOT NULL DEFAULT 'other' CHECK (source IN ('whatsapp', 'phone', 'visit', 'other')),
  raw_text TEXT NOT NULL CHECK (length(btrim(raw_text)) > 0),
  parsed JSONB,
  quality VARCHAR(100),
  meters NUMERIC(12, 2) CHECK (meters IS NULL OR meters > 0),
  target_rate NUMERIC(10, 2) CHECK (target_rate IS NULL OR target_rate > 0),
  needed_by DATE,
  quoted_rate NUMERIC(10, 2) CHECK (quoted_rate IS NULL OR quoted_rate > 0),
  reply_draft TEXT,
  status VARCHAR(10) NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'quoted', 'won', 'lost')),
  order_id INTEGER,
  created_by VARCHAR(50) REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries (status, created_at DESC);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  quality VARCHAR(100) NOT NULL CHECK (length(btrim(quality)) > 0),
  design VARCHAR(100),
  meters NUMERIC(12, 2) NOT NULL CHECK (meters > 0),
  rate_per_m NUMERIC(10, 2) CHECK (rate_per_m IS NULL OR rate_per_m >= 0),
  promise_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partly_dispatched', 'dispatched', 'cancelled')),
  inquiry_id INTEGER REFERENCES inquiries(id) ON DELETE SET NULL,
  notes TEXT,
  created_by VARCHAR(50) REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status, promise_date);
CREATE INDEX IF NOT EXISTS idx_orders_party ON orders (party_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inquiries_order_fk') THEN
    ALTER TABLE inquiries ADD CONSTRAINT inquiries_order_fk FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Order ↔ lot reservation. Free stock of a lot = balance − active (reserved) allocations.
CREATE TABLE IF NOT EXISTS allocations (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  lot_id VARCHAR(50) NOT NULL REFERENCES lots(lot_id) ON DELETE RESTRICT,
  meters NUMERIC(12, 2) NOT NULL CHECK (meters > 0),
  dispatched_m NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (dispatched_m >= 0),
  status VARCHAR(12) NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'released', 'dispatched')),
  created_by VARCHAR(50) REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_allocations_lot_active ON allocations (lot_id) WHERE status = 'reserved';
CREATE INDEX IF NOT EXISTS idx_allocations_order ON allocations (order_id);

-- ---------- dispatch ----------
-- One dispatch (truck / parcel) groups one or more OUT movements.
CREATE TABLE IF NOT EXISTS dispatches (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  party_id INTEGER REFERENCES parties(id) ON DELETE SET NULL,
  challan_no VARCHAR(40),
  transporter VARCHAR(100),
  lr_no VARCHAR(40),
  vehicle_no VARCHAR(20),
  packages INTEGER CHECK (packages IS NULL OR packages >= 0),
  dispatched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by VARCHAR(50) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_dispatches_party ON dispatches (party_id, dispatched_at DESC);
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dispatch_id INTEGER REFERENCES dispatches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_stock_movements_order ON stock_movements (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_movements_dispatch ON stock_movements (dispatch_id) WHERE dispatch_id IS NOT NULL;

-- ---------- money (owner only) ----------
CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  invoice_no VARCHAR(30) NOT NULL UNIQUE,
  party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  dispatch_id INTEGER REFERENCES dispatches(id) ON DELETE SET NULL,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE NOT NULL,
  taxable_amount NUMERIC(14, 2) NOT NULL CHECK (taxable_amount >= 0),
  cgst NUMERIC(14, 2) NOT NULL DEFAULT 0,
  sgst NUMERIC(14, 2) NOT NULL DEFAULT 0,
  igst NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total NUMERIC(14, 2) NOT NULL CHECK (total >= 0),
  lines JSONB NOT NULL, -- [{lot_id, quality, hsn, meters, rate, amount}]
  status VARCHAR(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cancelled')),
  source VARCHAR(10) NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'tally')), -- 'tally' = amount entered from Tally, no PDF from us
  exported_at TIMESTAMP,
  created_by VARCHAR(50) REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_invoices_party ON invoices (party_id, status, due_date);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  paid_on DATE NOT NULL DEFAULT CURRENT_DATE,
  mode VARCHAR(10) NOT NULL DEFAULT 'bank' CHECK (mode IN ('cash', 'bank', 'upi', 'cheque', 'other')),
  reference VARCHAR(60),
  created_by VARCHAR(50) REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payments_party ON payments (party_id, paid_on DESC);

-- ---------- agents ----------
-- Alerts + suggested actions shown in "Needs your attention". dedupe_key stops the same alert twice.
CREATE TABLE IF NOT EXISTS agent_suggestions (
  id BIGSERIAL PRIMARY KEY,
  agent VARCHAR(30) NOT NULL,
  kind VARCHAR(40) NOT NULL,
  severity VARCHAR(8) NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warn', 'bad')),
  title TEXT NOT NULL,
  detail TEXT,
  payload JSONB,
  target_type VARCHAR(20),
  target_id VARCHAR(60),
  action_label VARCHAR(40), -- set when the suggestion can be accepted with one tap
  owner_only BOOLEAN NOT NULL DEFAULT FALSE, -- money-related
  dedupe_key VARCHAR(160) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'resolved')),
  decided_by VARCHAR(50) REFERENCES users(id),
  decided_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_suggestions_open_dedupe ON agent_suggestions (dedupe_key) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_agent_suggestions_open ON agent_suggestions (status, created_at DESC);

CREATE TABLE IF NOT EXISTS generated_docs (
  id SERIAL PRIMARY KEY,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('challan', 'packing_list', 'invoice', 'statement', 'tally_export')),
  ref VARCHAR(60),
  created_by VARCHAR(50) REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Last run of the background agent scan (throttling).
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS agents_ran_at TIMESTAMP;
