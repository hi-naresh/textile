-- 000 — Base tables. Creates the core schema on an EMPTY database (e.g. a new Supabase project).
-- Safe on existing databases: every table uses IF NOT EXISTS, so nothing already there is touched.
-- No demo data here — demo data lives only in scripts/db-init.js (local development).
-- Users table (Admins/Supervisors/Owners)
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('owner', 'supervisor', 'worker', 'admin')),
    locale VARCHAR(10) DEFAULT 'en' CHECK (locale IN ('en', 'hi', 'gu')),
    active BOOLEAN DEFAULT TRUE
);

-- Workers table
CREATE TABLE IF NOT EXISTS workers (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    section VARCHAR(100) NOT NULL,
    role VARCHAR(50) DEFAULT 'operator',
    active BOOLEAN DEFAULT TRUE
);

-- Lots table
CREATE TABLE IF NOT EXISTS lots (
    lot_id VARCHAR(50) PRIMARY KEY,
    quality VARCHAR(100) NOT NULL,
    design VARCHAR(100) NOT NULL,
    grade VARCHAR(10) DEFAULT 'A',
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'completed', 'dispatched', 'hold'))
);

-- Capture Events table (Temporary staging for photo reads before ledger confirmation)
CREATE TABLE IF NOT EXISTS capture_events (
    id SERIAL PRIMARY KEY,
    photo_url VARCHAR(255) NOT NULL,
    type VARCHAR(30) NOT NULL CHECK (type IN ('incoming_stock', 'outgoing_stock', 'job_card_folding')),
    ai_json JSONB,
    confidence NUMERIC(3, 2), -- 0.00 to 1.00
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'corrected', 'rejected')),
    confirmed_by VARCHAR(50) REFERENCES users(id),
    ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Stock Movements table (IN/OUT Ledger)
CREATE TABLE IF NOT EXISTS stock_movements (
    id SERIAL PRIMARY KEY,
    lot_id VARCHAR(50) REFERENCES lots(lot_id) ON DELETE RESTRICT,
    direction VARCHAR(5) NOT NULL CHECK (direction IN ('IN', 'OUT')),
    meters NUMERIC(10, 2) NOT NULL CHECK (meters > 0),
    party VARCHAR(150), -- Source supplier for IN, Destination client for OUT
    source_doc_id VARCHAR(100), -- Challan number or invoice reference
    capture_event_id INTEGER REFERENCES capture_events(id) ON DELETE SET NULL,
    ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Job Cards table
CREATE TABLE IF NOT EXISTS job_cards (
    id SERIAL PRIMARY KEY,
    lot_id VARCHAR(50) REFERENCES lots(lot_id) ON DELETE RESTRICT,
    process VARCHAR(100) NOT NULL, -- e.g., 'weaving', 'dyeing', 'printing', 'folding'
    worker_id VARCHAR(50) REFERENCES workers(id) ON DELETE RESTRICT,
    meters_in NUMERIC(10, 2) NOT NULL CHECK (meters_in > 0),
    meters_out NUMERIC(10, 2) CHECK (meters_out >= 0),
    shortage NUMERIC(10, 2) GENERATED ALWAYS AS (meters_in - meters_out) STORED,
    status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'in-process', 'folded', 'closed')),
    ts_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ts_closed TIMESTAMP
);

-- Allotments table (Work assigned to worker)
CREATE TABLE IF NOT EXISTS allotments (
    id SERIAL PRIMARY KEY,
    worker_id VARCHAR(50) REFERENCES workers(id) ON DELETE CASCADE,
    job_card_id INTEGER REFERENCES job_cards(id) ON DELETE CASCADE,
    meters_allotted NUMERIC(10, 2) NOT NULL,
    shift VARCHAR(20) NOT NULL, -- 'Morning', 'Evening', 'Night'
    date DATE NOT NULL DEFAULT CURRENT_DATE
);

-- Daily Worker Efficiency table (rolled up daily)
CREATE TABLE IF NOT EXISTS efficiency_daily (
    id SERIAL PRIMARY KEY,
    worker_id VARCHAR(50) REFERENCES workers(id) ON DELETE CASCADE,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    allotted NUMERIC(10, 2) NOT NULL DEFAULT 0,
    done NUMERIC(10, 2) NOT NULL DEFAULT 0,
    efficiency_pct NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
    flagged BOOLEAN DEFAULT FALSE,
    CONSTRAINT unique_worker_date UNIQUE (worker_id, date)
);

-- CCTV Activity table (lightweight logging of active/idle time from cameras)
CREATE TABLE IF NOT EXISTS cctv_activity (
    id SERIAL PRIMARY KEY,
    worker_id VARCHAR(50) REFERENCES workers(id) ON DELETE CASCADE,
    station VARCHAR(50) NOT NULL,
    active_pct NUMERIC(5, 2) NOT NULL CHECK (active_pct >= 0 AND active_pct <= 100),
    idle_min NUMERIC(10, 2) NOT NULL DEFAULT 0,
    ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Chat Audit table (logging questions, SQL queries, and responses)
CREATE TABLE IF NOT EXISTS chat_audit (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) REFERENCES users(id),
    question TEXT NOT NULL,
    sql_run TEXT NOT NULL,
    answer TEXT NOT NULL,
    ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- The owner account must exist: photo auto-confirm and audit rows reference users(id).
-- The name is changed later in Settings (or by the firm's setup migration).
INSERT INTO users (id, name, role, locale, active) VALUES ('usr-owner', 'Owner', 'owner', 'en', true)
ON CONFLICT (id) DO NOTHING;
