-- Phase 1 Migration: LP Order Events Support
-- Adds optimized indexes for lp.order.* event queries

-- ============================================
-- LP Order Events Indexes
-- ============================================

-- Index for LP order event queries (filter by event type prefix)
CREATE INDEX IF NOT EXISTS idx_audit_lp_order_events 
  ON audit_events (trace_id, created_at) 
  WHERE event_type LIKE 'lp.order.%';

-- Index for recent LP timelines listing
CREATE INDEX IF NOT EXISTS idx_audit_lp_events_created
  ON audit_events (created_at DESC)
  WHERE event_type LIKE 'lp.order.%';

-- Index for rejection reason queries (JSONB path)
CREATE INDEX IF NOT EXISTS idx_audit_rejection_reason
  ON audit_events ((payload_json->'normalization'->>'status'))
  WHERE event_type = 'lp.order.rejected';

-- ============================================
-- LP Timeline Materialized View (Optional - for demo performance)
-- ============================================

-- Uncomment if timeline queries become slow
/*
CREATE MATERIALIZED VIEW IF NOT EXISTS lp_timeline_summary AS
SELECT 
  trace_id,
  MIN(created_at) as started_at,
  MAX(created_at) as last_event_at,
  COUNT(*) as event_count,
  MAX(payload_json->'normalization'->>'status') as current_status,
  MAX(payload_json->'payload'->>'symbol') as symbol,
  MAX(payload_json->'payload'->>'side') as side,
  MAX((payload_json->'payload'->>'qty')::numeric) as qty,
  MAX(payload_json->'normalization'->'reason'->>'reason_code') as rejection_reason,
  BOOL_OR(payload_json->'_validation'->>'warnings' IS NOT NULL 
          AND payload_json->'_validation'->>'warnings' != '[]') as has_violations
FROM audit_events
WHERE event_type LIKE 'lp.order.%'
GROUP BY trace_id;

CREATE UNIQUE INDEX ON lp_timeline_summary (trace_id);
CREATE INDEX ON lp_timeline_summary (started_at DESC);
*/

-- ============================================
-- Comments for documentation
-- ============================================

COMMENT ON INDEX idx_audit_lp_order_events IS 
  'Phase 1: Optimizes lp.order.* event retrieval for timeline reconstruction';

COMMENT ON INDEX idx_audit_lp_events_created IS 
  'Phase 1: Optimizes recent LP timelines listing';

COMMENT ON INDEX idx_audit_rejection_reason IS 
  'Phase 1: Optimizes rejection reason filtering for alerts/reports';
