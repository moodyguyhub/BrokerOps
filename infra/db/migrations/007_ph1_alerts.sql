-- Phase 1 Week 3: Alerts Engine Tables
-- Supports margin alerts, rejection spike alerts, acknowledgments, and settings
-- Run after 006_ph1_read_models.sql

-- ============================================================================
-- Alert Settings (thresholds and cooldowns)
-- ============================================================================

CREATE TABLE IF NOT EXISTS alert_settings (
  id VARCHAR(64) PRIMARY KEY,                    -- Setting key (e.g., "MARGIN_LOW", "REJECT_SPIKE")
  category VARCHAR(32) NOT NULL,                 -- MARGIN, REJECTION, SYSTEM
  
  -- Threshold configuration
  threshold_value DECIMAL(18,4) NOT NULL,        -- The trigger value
  threshold_unit VARCHAR(32) NOT NULL,           -- PERCENT, COUNT, RATE_PER_MIN
  comparison VARCHAR(8) NOT NULL,                -- LT, GT, LTE, GTE, EQ
  
  -- Cooldown configuration
  cooldown_seconds INT NOT NULL DEFAULT 300,     -- 5 min default
  
  -- Scope
  applies_to VARCHAR(64),                        -- LP ID, symbol, or NULL for global
  
  -- Status
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  
  -- Metadata
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default alert settings
INSERT INTO alert_settings (id, category, threshold_value, threshold_unit, comparison, cooldown_seconds, description)
VALUES 
  ('MARGIN_CRITICAL', 'MARGIN', 50.00, 'PERCENT', 'LT', 300, 'Margin level below 50% - critical'),
  ('MARGIN_WARNING', 'MARGIN', 100.00, 'PERCENT', 'LT', 600, 'Margin level below 100% - warning'),
  ('MARGIN_LOW', 'MARGIN', 150.00, 'PERCENT', 'LT', 900, 'Margin level below 150% - low'),
  ('REJECT_SPIKE_5MIN', 'REJECTION', 10, 'COUNT', 'GT', 300, 'More than 10 rejections in 5 minutes'),
  ('REJECT_SPIKE_1MIN', 'REJECTION', 5, 'COUNT', 'GT', 60, 'More than 5 rejections in 1 minute'),
  ('REJECT_RATE_HIGH', 'REJECTION', 20, 'RATE_PER_MIN', 'GT', 300, 'Rejection rate exceeds 20/min')
ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_alert_settings_category ON alert_settings(category);
CREATE INDEX IF NOT EXISTS idx_alert_settings_enabled ON alert_settings(enabled) WHERE enabled = TRUE;

-- ============================================================================
-- Alerts (fired alert instances)
-- ============================================================================

CREATE TABLE IF NOT EXISTS alerts (
  id BIGSERIAL PRIMARY KEY,
  alert_id VARCHAR(64) NOT NULL UNIQUE,          -- UUID for external reference
  setting_id VARCHAR(64) NOT NULL REFERENCES alert_settings(id),
  
  -- Alert classification
  severity VARCHAR(16) NOT NULL,                 -- CRITICAL, WARNING, INFO
  category VARCHAR(32) NOT NULL,                 -- MARGIN, REJECTION, SYSTEM
  
  -- Context
  lp_id VARCHAR(64),                             -- Affected LP (if applicable)
  symbol VARCHAR(32),                            -- Affected symbol (if applicable)
  server_id VARCHAR(64),                         -- Source server
  
  -- Alert details
  title VARCHAR(256) NOT NULL,
  message TEXT NOT NULL,
  
  -- Trigger data
  trigger_value DECIMAL(18,4) NOT NULL,          -- Actual value that triggered
  threshold_value DECIMAL(18,4) NOT NULL,        -- Threshold that was crossed
  
  -- State
  status VARCHAR(32) NOT NULL DEFAULT 'OPEN',    -- OPEN, ACKNOWLEDGED, RESOLVED, EXPIRED
  
  -- Timestamps
  triggered_at TIMESTAMPTZ NOT NULL,
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,                        -- Auto-resolve after this time
  
  -- Metadata
  metadata JSONB,                                -- Additional context (event_ids, etc.)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
CREATE INDEX IF NOT EXISTS idx_alerts_category ON alerts(category);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);
CREATE INDEX IF NOT EXISTS idx_alerts_lp ON alerts(lp_id) WHERE lp_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_triggered ON alerts(triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(status, triggered_at DESC) WHERE status = 'OPEN';

-- ============================================================================
-- Alert Acknowledgments (audit trail)
-- ============================================================================

CREATE TABLE IF NOT EXISTS alert_acks (
  id BIGSERIAL PRIMARY KEY,
  alert_id VARCHAR(64) NOT NULL,                 -- References alerts.alert_id
  
  -- Acknowledgment details
  action VARCHAR(32) NOT NULL,                   -- ACK, RESOLVE, SNOOZE, ESCALATE
  
  -- Actor
  actor_id VARCHAR(128),                         -- User ID or system identifier
  actor_name VARCHAR(256),                       -- Display name
  actor_type VARCHAR(32) NOT NULL DEFAULT 'USER', -- USER, SYSTEM, API
  
  -- Context
  comment TEXT,
  snooze_until TIMESTAMPTZ,                      -- If action=SNOOZE
  
  -- Metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_acks_alert ON alert_acks(alert_id);
CREATE INDEX IF NOT EXISTS idx_alert_acks_action ON alert_acks(action);
CREATE INDEX IF NOT EXISTS idx_alert_acks_created ON alert_acks(created_at DESC);

-- ============================================================================
-- Alert Cooldowns (prevent duplicate alerts)
-- ============================================================================

CREATE TABLE IF NOT EXISTS alert_cooldowns (
  id BIGSERIAL PRIMARY KEY,
  setting_id VARCHAR(64) NOT NULL REFERENCES alert_settings(id),
  
  -- Scope (unique per setting + scope)
  lp_id VARCHAR(64),
  symbol VARCHAR(32),
  
  -- Cooldown window
  last_fired_at TIMESTAMPTZ NOT NULL,
  cooldown_until TIMESTAMPTZ NOT NULL
);

-- Unique index using COALESCE to handle NULL values in composite key
CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_cooldowns_unique 
ON alert_cooldowns(setting_id, COALESCE(lp_id, ''), COALESCE(symbol, ''));

CREATE INDEX IF NOT EXISTS idx_alert_cooldowns_expires ON alert_cooldowns(cooldown_until);

-- ============================================================================
-- Dashboard Stats (materialized for fast queries)
-- ============================================================================

CREATE TABLE IF NOT EXISTS dashboard_stats (
  id VARCHAR(64) PRIMARY KEY,                    -- Stat key
  category VARCHAR(32) NOT NULL,                 -- ORDERS, REJECTIONS, LP, ALERTS
  
  -- Current period values
  value_current DECIMAL(18,4) NOT NULL DEFAULT 0,
  count_current INT NOT NULL DEFAULT 0,
  
  -- Previous period values (for comparison)
  value_previous DECIMAL(18,4) DEFAULT 0,
  count_previous INT DEFAULT 0,
  
  -- Period info
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  period_type VARCHAR(16),                       -- MINUTE, HOUR, DAY
  
  -- Metadata
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed dashboard stats rows
INSERT INTO dashboard_stats (id, category, period_type)
VALUES 
  ('orders_today', 'ORDERS', 'DAY'),
  ('orders_1h', 'ORDERS', 'HOUR'),
  ('fills_today', 'ORDERS', 'DAY'),
  ('fills_1h', 'ORDERS', 'HOUR'),
  ('rejections_today', 'REJECTIONS', 'DAY'),
  ('rejections_1h', 'REJECTIONS', 'HOUR'),
  ('rejection_rate_1h', 'REJECTIONS', 'HOUR'),
  ('active_lps', 'LP', 'HOUR'),
  ('avg_margin_level', 'LP', 'HOUR'),
  ('open_alerts', 'ALERTS', 'HOUR'),
  ('critical_alerts', 'ALERTS', 'HOUR')
ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_dashboard_stats_category ON dashboard_stats(category);

-- ============================================================================
-- Notification Log (for Slack/email audit)
-- ============================================================================

CREATE TABLE IF NOT EXISTS notification_log (
  id BIGSERIAL PRIMARY KEY,
  alert_id VARCHAR(64),                          -- References alerts.alert_id (optional)
  
  -- Channel
  channel_type VARCHAR(32) NOT NULL,             -- SLACK, EMAIL, WEBHOOK, SMS
  channel_target VARCHAR(256) NOT NULL,          -- Channel ID, email, URL
  
  -- Content
  subject VARCHAR(256),
  body TEXT,
  
  -- Result
  status VARCHAR(32) NOT NULL,                   -- PENDING, SENT, FAILED, SKIPPED
  error_message TEXT,
  
  -- Timing
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notification_log_alert ON notification_log(alert_id) WHERE alert_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notification_log_status ON notification_log(status);
CREATE INDEX IF NOT EXISTS idx_notification_log_created ON notification_log(created_at DESC);
