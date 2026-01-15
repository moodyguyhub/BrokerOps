CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  trace_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_version TEXT NOT NULL DEFAULT 'v1',
  payload_json JSONB NOT NULL,
  prev_hash TEXT,
  hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_trace_id ON audit_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_events(created_at);

-- Economic events table (hash-chained)
CREATE TABLE IF NOT EXISTS economic_events (
  id SERIAL PRIMARY KEY,
  trace_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  gross_revenue DECIMAL(18,4),
  fees DECIMAL(18,4),
  costs DECIMAL(18,4),
  estimated_lost_revenue DECIMAL(18,4),
  currency VARCHAR(8) DEFAULT 'USD',
  source VARCHAR(32),
  policy_id VARCHAR(64),
  prev_hash VARCHAR(64),
  hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_econ_trace ON economic_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_econ_policy ON economic_events(policy_id);

-- Webhooks table
CREATE TABLE IF NOT EXISTS webhooks (
  id VARCHAR(64) PRIMARY KEY,
  url TEXT NOT NULL,
  events JSONB NOT NULL,
  secret_hash VARCHAR(128),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  active BOOLEAN DEFAULT true
);

-- Webhook delivery log
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id SERIAL PRIMARY KEY,
  webhook_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  trace_id VARCHAR(64),
  success BOOLEAN NOT NULL,
  status_code INTEGER,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_trace ON webhook_deliveries(trace_id);
