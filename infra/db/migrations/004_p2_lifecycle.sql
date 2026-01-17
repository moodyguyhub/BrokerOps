-- P2 Database Migration: Lifecycle Events & Idempotency
-- Run after P0/P1 migrations

-- ============================================
-- P2.1: Idempotency Store
-- ============================================

CREATE TABLE IF NOT EXISTS idempotency_store (
  id SERIAL PRIMARY KEY,
  source_system VARCHAR(64) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  event_id VARCHAR(256) NOT NULL,
  payload_hash VARCHAR(32) NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  processing_result VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  result_data JSONB,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  
  CONSTRAINT idempotency_unique_event 
    UNIQUE (source_system, event_type, event_id)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_first_seen 
  ON idempotency_store (first_seen_at);

CREATE INDEX IF NOT EXISTS idx_idempotency_source_type 
  ON idempotency_store (source_system, event_type, first_seen_at);

-- ============================================
-- P2.0: Lifecycle Events Storage
-- ============================================

CREATE TABLE IF NOT EXISTS lifecycle_events (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(32) NOT NULL,
  event_id UUID NOT NULL,
  idempotency_key VARCHAR(256) NOT NULL,
  decision_token TEXT NOT NULL,
  symbol VARCHAR(16),
  side VARCHAR(4),
  qty NUMERIC,
  price NUMERIC,
  realized_pnl NUMERIC,
  pnl_source VARCHAR(16),
  source VARCHAR(16),  -- Event source: PLATFORM, BACKOFFICE
  raw_payload JSONB NOT NULL,
  -- Clock skew protection: store both asserted (from event) and received (server)
  asserted_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  CONSTRAINT lifecycle_events_unique_id UNIQUE (event_id)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_decision_token 
  ON lifecycle_events (decision_token);

CREATE INDEX IF NOT EXISTS idx_lifecycle_type_created 
  ON lifecycle_events (event_type, created_at);

CREATE INDEX IF NOT EXISTS idx_lifecycle_symbol 
  ON lifecycle_events (symbol, created_at);

-- ============================================
-- P2.2: Exposure Events Extensions
-- ============================================

-- Add P2 columns to exposure_events if not exists
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'exposure_events' AND column_name = 'realized_pnl'
  ) THEN
    ALTER TABLE exposure_events ADD COLUMN realized_pnl NUMERIC;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'exposure_events' AND column_name = 'pnl_status'
  ) THEN
    ALTER TABLE exposure_events ADD COLUMN pnl_status VARCHAR(16);
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'exposure_events' AND column_name = 'pnl_discrepancy'
  ) THEN
    ALTER TABLE exposure_events ADD COLUMN pnl_discrepancy NUMERIC;
  END IF;
END $$;

-- ============================================
-- P2.3/P2.4: Realized Economics Storage
-- ============================================

CREATE TABLE IF NOT EXISTS realized_economics (
  id SERIAL PRIMARY KEY,
  decision_token TEXT NOT NULL,
  trace_id VARCHAR(64) NOT NULL,
  
  -- Execution details
  fill_price NUMERIC,
  fill_qty INTEGER,
  fill_timestamp TIMESTAMPTZ,
  
  -- P&L tracking
  realized_pnl NUMERIC,
  pnl_status VARCHAR(16) NOT NULL DEFAULT 'PROVISIONAL',
  pnl_source VARCHAR(16),
  
  -- Finalization (T+1)
  final_pnl NUMERIC,
  finalized_at TIMESTAMPTZ,
  
  -- Accuracy metrics
  platform_pnl NUMERIC,
  discrepancy NUMERIC,
  discrepancy_percent NUMERIC,
  
  -- Metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  CONSTRAINT realized_economics_unique_token UNIQUE (decision_token)
);

CREATE INDEX IF NOT EXISTS idx_realized_economics_trace 
  ON realized_economics (trace_id);

CREATE INDEX IF NOT EXISTS idx_realized_economics_status 
  ON realized_economics (pnl_status, created_at);

-- ============================================
-- P2.5: Evidence Pack Economics Extensions
-- ============================================

-- View for extended economics (projected + realized)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'audit_events'
  ) THEN
    CREATE OR REPLACE VIEW v_extended_economics AS
    SELECT 
      ae.trace_id,
      ae.payload_json->>'snapshotEconomics' as projected_economics,
      re.realized_pnl,
      re.pnl_status,
      re.final_pnl,
      re.discrepancy,
      re.discrepancy_percent,
      CASE 
        WHEN re.realized_pnl IS NOT NULL AND 
             (ae.payload_json->>'snapshotEconomics')::jsonb->>'projected_exposure_delta' IS NOT NULL
        THEN 1 - ABS(
          re.realized_pnl - ((ae.payload_json->>'snapshotEconomics')::jsonb->>'projected_exposure_delta')::numeric
        ) / NULLIF(((ae.payload_json->>'snapshotEconomics')::jsonb->>'projected_exposure_delta')::numeric, 0)
        ELSE NULL
      END as projection_accuracy
    FROM audit_events ae
    LEFT JOIN realized_economics re ON ae.trace_id = re.trace_id
    WHERE ae.event_type IN ('risk.decision', 'order.authorized', 'order.blocked');
  END IF;
END $$;

-- ============================================
-- Cleanup function for old idempotency records
-- ============================================

CREATE OR REPLACE FUNCTION cleanup_idempotency_store(retention_days INTEGER DEFAULT 7)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM idempotency_store
  WHERE first_seen_at < NOW() - (retention_days || ' days')::INTERVAL;
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- P2 Stats view for monitoring
-- ============================================

CREATE OR REPLACE VIEW v_p2_stats AS
SELECT
  (SELECT COUNT(*) FROM idempotency_store WHERE first_seen_at > NOW() - INTERVAL '24 hours') as events_24h,
  (SELECT COUNT(*) FROM idempotency_store WHERE processing_result = 'SUCCESS' AND first_seen_at > NOW() - INTERVAL '24 hours') as successful_24h,
  (SELECT COUNT(*) FROM idempotency_store WHERE processing_result = 'FAILED' AND first_seen_at > NOW() - INTERVAL '24 hours') as failed_24h,
  (SELECT SUM(attempt_count - 1) FROM idempotency_store WHERE first_seen_at > NOW() - INTERVAL '24 hours') as duplicates_blocked_24h,
  (SELECT COUNT(*) FROM lifecycle_events WHERE event_type = 'execution.reported' AND created_at > NOW() - INTERVAL '24 hours') as executions_24h,
  (SELECT COUNT(*) FROM lifecycle_events WHERE event_type = 'position.closed' AND created_at > NOW() - INTERVAL '24 hours') as closures_24h,
  (SELECT COUNT(*) FROM realized_economics WHERE pnl_status = 'FINAL' AND finalized_at > NOW() - INTERVAL '24 hours') as finalized_24h;

COMMENT ON VIEW v_p2_stats IS 'P2 lifecycle events and idempotency statistics';
