-- Phase 1 Week 1: Read Model Tables
-- Materialize canonical tables from LP events for UI queries
-- Run after 005_ph1_lp_events.sql

-- ============================================================================
-- LP Accounts (current state per LP)
-- ============================================================================

CREATE TABLE IF NOT EXISTS lp_accounts (
  id VARCHAR(64) PRIMARY KEY,                    -- LP identifier (e.g., "LP-A", "LP-B")
  name VARCHAR(128) NOT NULL,                    -- Display name
  server_id VARCHAR(64) NOT NULL,                -- MT5 server ID
  server_name VARCHAR(128),                      -- MT5 server name
  
  -- Current balance/margin state
  balance DECIMAL(18,4) NOT NULL DEFAULT 0,
  equity DECIMAL(18,4) NOT NULL DEFAULT 0,
  margin DECIMAL(18,4) NOT NULL DEFAULT 0,
  free_margin DECIMAL(18,4) NOT NULL DEFAULT 0,
  margin_level DECIMAL(10,4),                    -- % (equity/margin * 100)
  
  -- Connection status
  status VARCHAR(32) NOT NULL DEFAULT 'UNKNOWN', -- CONNECTED, DISCONNECTED, UNKNOWN
  last_heartbeat_at TIMESTAMPTZ,
  
  -- Metadata
  currency VARCHAR(8) NOT NULL DEFAULT 'USD',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lp_accounts_status ON lp_accounts(status);
CREATE INDEX IF NOT EXISTS idx_lp_accounts_updated ON lp_accounts(updated_at DESC);

-- ============================================================================
-- LP Snapshots (time series for history charts)
-- ============================================================================

CREATE TABLE IF NOT EXISTS lp_snapshots (
  id BIGSERIAL PRIMARY KEY,
  lp_id VARCHAR(64) NOT NULL REFERENCES lp_accounts(id),
  
  -- Snapshot values
  balance DECIMAL(18,4) NOT NULL,
  equity DECIMAL(18,4) NOT NULL,
  margin DECIMAL(18,4) NOT NULL,
  free_margin DECIMAL(18,4) NOT NULL,
  margin_level DECIMAL(10,4),
  
  -- Source tracking
  source_event_id VARCHAR(64),                   -- Event that triggered this snapshot
  source_trace_id VARCHAR(64),
  
  -- Timestamp
  snapshot_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lp_snapshots_lp_time ON lp_snapshots(lp_id, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_lp_snapshots_time ON lp_snapshots(snapshot_at DESC);

-- ============================================================================
-- Orders (canonical order list for UI)
-- ============================================================================

CREATE TABLE IF NOT EXISTS orders (
  id VARCHAR(64) PRIMARY KEY,                    -- trace_id as order identifier
  client_order_id VARCHAR(128),                  -- Client-provided order ID
  lp_order_id VARCHAR(128),                      -- LP-assigned order ID
  
  -- Order details
  symbol VARCHAR(32) NOT NULL,
  side VARCHAR(8) NOT NULL,                      -- BUY, SELL
  order_type VARCHAR(32) NOT NULL DEFAULT 'LIMIT', -- LIMIT, MARKET, STOP, etc.
  qty DECIMAL(18,6) NOT NULL,
  price DECIMAL(18,6),
  
  -- Fill information
  fill_qty DECIMAL(18,6) DEFAULT 0,
  avg_fill_price DECIMAL(18,6),
  remaining_qty DECIMAL(18,6),
  
  -- Status
  status VARCHAR(32) NOT NULL,                   -- SUBMITTED, ACCEPTED, FILLED, REJECTED, CANCELED, etc.
  
  -- LP routing
  lp_id VARCHAR(64),                             -- Which LP handled this order
  server_id VARCHAR(64),
  server_name VARCHAR(128),
  
  -- Rejection info (if applicable)
  rejection_reason_code VARCHAR(64),
  rejection_reason_class VARCHAR(32),
  rejection_raw_message TEXT,
  
  -- Decision token linkage
  decision_token_id VARCHAR(128),
  
  -- Timestamps
  submitted_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  filled_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_symbol ON orders(symbol);
CREATE INDEX IF NOT EXISTS idx_orders_lp ON orders(lp_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_client_order ON orders(client_order_id);

-- ============================================================================
-- Order Lifecycle Events (append-only for timeline UI)
-- ============================================================================

CREATE TABLE IF NOT EXISTS order_lifecycle_events (
  id BIGSERIAL PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL REFERENCES orders(id),
  
  -- Event details
  event_id VARCHAR(64) NOT NULL UNIQUE,          -- From LP event
  event_type VARCHAR(64) NOT NULL,               -- lp.order.submitted, lp.order.filled, etc.
  status VARCHAR(32) NOT NULL,                   -- Normalized status at this point
  
  -- Event payload (denormalized for quick access)
  qty DECIMAL(18,6),
  price DECIMAL(18,6),
  fill_qty DECIMAL(18,6),
  fill_price DECIMAL(18,6),
  remaining_qty DECIMAL(18,6),
  
  -- Rejection reason (if applicable)
  reason_code VARCHAR(64),
  reason_class VARCHAR(32),
  reason_message TEXT,
  
  -- Integrity
  payload_hash VARCHAR(128),
  prev_event_hash VARCHAR(128),
  
  -- Timestamps
  occurred_at TIMESTAMPTZ NOT NULL,              -- When event occurred (from source)
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW() -- When we received it
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_order ON order_lifecycle_events(order_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_lifecycle_type ON order_lifecycle_events(event_type);
CREATE INDEX IF NOT EXISTS idx_lifecycle_occurred ON order_lifecycle_events(occurred_at DESC);

-- ============================================================================
-- Rejections (dedicated table for rejection analytics)
-- ============================================================================

CREATE TABLE IF NOT EXISTS rejections (
  id BIGSERIAL PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL REFERENCES orders(id),
  event_id VARCHAR(64) NOT NULL UNIQUE,
  
  -- LP context
  lp_id VARCHAR(64),
  server_id VARCHAR(64),
  server_name VARCHAR(128),
  symbol VARCHAR(32),
  
  -- Raw rejection from LP
  raw_code VARCHAR(128),
  raw_message TEXT,
  raw_fields JSONB,
  
  -- Normalized rejection
  reason_code VARCHAR(64) NOT NULL,              -- From taxonomy (e.g., INSUFFICIENT_MARGIN)
  reason_class VARCHAR(32) NOT NULL,             -- Category (e.g., MARGIN, SYMBOL, RISK_POLICY)
  reason_message TEXT,
  
  -- Normalization metadata
  normalization_confidence VARCHAR(16),          -- HIGH, MEDIUM, LOW
  normalization_source VARCHAR(32),              -- EXACT_MATCH, REGEX, HEURISTIC, FALLBACK
  
  -- Timestamps
  rejected_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rejections_lp ON rejections(lp_id);
CREATE INDEX IF NOT EXISTS idx_rejections_reason ON rejections(reason_code);
CREATE INDEX IF NOT EXISTS idx_rejections_class ON rejections(reason_class);
CREATE INDEX IF NOT EXISTS idx_rejections_symbol ON rejections(symbol);
CREATE INDEX IF NOT EXISTS idx_rejections_time ON rejections(rejected_at DESC);

-- ============================================================================
-- Comments for documentation
-- ============================================================================

COMMENT ON TABLE lp_accounts IS 'PH1-W1: Current state per LP for dashboard display';
COMMENT ON TABLE lp_snapshots IS 'PH1-W1: Time series of LP balance/margin for history charts';
COMMENT ON TABLE orders IS 'PH1-W1: Canonical order list materialized from LP events';
COMMENT ON TABLE order_lifecycle_events IS 'PH1-W1: Append-only lifecycle events for order timeline UI';
COMMENT ON TABLE rejections IS 'PH1-W1: Dedicated rejection table for analytics and rollups';
