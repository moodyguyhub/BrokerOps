-- Shadow Ledger: Real-time exposure tracking (P0.2)
-- Tracks projected exposure per client for pre-trade risk checks

-- Active exposures per client (materialized state)
CREATE TABLE IF NOT EXISTS shadow_ledger (
  id SERIAL PRIMARY KEY,
  client_id VARCHAR(64) NOT NULL,
  symbol VARCHAR(32) NOT NULL,
  
  -- Current position state
  net_quantity INTEGER NOT NULL DEFAULT 0,
  avg_cost_basis DECIMAL(18,6),
  
  -- Exposure metrics
  gross_exposure DECIMAL(18,4) NOT NULL DEFAULT 0,     -- Sum of |position_value| across all positions
  net_exposure DECIMAL(18,4) NOT NULL DEFAULT 0,       -- Long exposure - Short exposure
  pending_exposure DECIMAL(18,4) NOT NULL DEFAULT 0,   -- Orders authorized but not settled
  
  -- Limits (per-client configuration)
  max_gross_exposure DECIMAL(18,4),
  max_net_exposure DECIMAL(18,4),
  max_single_order_exposure DECIMAL(18,4),
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(client_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_shadow_ledger_client ON shadow_ledger(client_id);
CREATE INDEX IF NOT EXISTS idx_shadow_ledger_symbol ON shadow_ledger(symbol);

-- Exposure events log (append-only for audit trail)
CREATE TABLE IF NOT EXISTS exposure_events (
  id BIGSERIAL PRIMARY KEY,
  trace_id VARCHAR(64) NOT NULL,
  client_id VARCHAR(64) NOT NULL,
  symbol VARCHAR(32) NOT NULL,
  
  -- Event details
  event_type VARCHAR(32) NOT NULL,  -- AUTHORIZED, BLOCKED, FILLED, CANCELLED, POSITION_CLOSED
  side VARCHAR(8),                   -- BUY, SELL
  quantity INTEGER,
  price DECIMAL(18,6),
  
  -- Exposure change
  exposure_delta DECIMAL(18,4) NOT NULL,
  exposure_before DECIMAL(18,4),
  exposure_after DECIMAL(18,4),
  
  -- Decision context
  decision_signature VARCHAR(128),
  policy_version VARCHAR(32),
  
  -- Hash chain for integrity
  prev_hash VARCHAR(64),
  hash VARCHAR(64) NOT NULL,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exposure_events_trace ON exposure_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_exposure_events_client ON exposure_events(client_id);
CREATE INDEX IF NOT EXISTS idx_exposure_events_created ON exposure_events(created_at);

-- Client exposure limits configuration
CREATE TABLE IF NOT EXISTS client_exposure_limits (
  client_id VARCHAR(64) PRIMARY KEY,
  
  -- Global limits
  max_gross_exposure DECIMAL(18,4) NOT NULL DEFAULT 1000000,
  max_net_exposure DECIMAL(18,4) NOT NULL DEFAULT 500000,
  max_single_order_exposure DECIMAL(18,4) NOT NULL DEFAULT 100000,
  
  -- Symbol-specific overrides (JSONB for flexibility)
  symbol_limits JSONB DEFAULT '{}',
  
  -- Status
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- View: Current client exposure summary
CREATE OR REPLACE VIEW client_exposure_summary AS
SELECT 
  sl.client_id,
  SUM(sl.gross_exposure) as total_gross_exposure,
  SUM(sl.net_exposure) as total_net_exposure,
  SUM(sl.pending_exposure) as total_pending_exposure,
  COALESCE(cel.max_gross_exposure, 1000000) as max_gross_exposure,
  COALESCE(cel.max_net_exposure, 500000) as max_net_exposure,
  CASE 
    WHEN SUM(sl.gross_exposure) > COALESCE(cel.max_gross_exposure, 1000000) THEN TRUE
    ELSE FALSE
  END as is_gross_breach,
  CASE 
    WHEN ABS(SUM(sl.net_exposure)) > COALESCE(cel.max_net_exposure, 500000) THEN TRUE
    ELSE FALSE
  END as is_net_breach
FROM shadow_ledger sl
LEFT JOIN client_exposure_limits cel ON sl.client_id = cel.client_id
GROUP BY sl.client_id, cel.max_gross_exposure, cel.max_net_exposure;

-- Function: Update shadow ledger on order authorization
CREATE OR REPLACE FUNCTION update_shadow_ledger_on_authorized(
  p_client_id VARCHAR(64),
  p_symbol VARCHAR(32),
  p_side VARCHAR(8),
  p_quantity INTEGER,
  p_price DECIMAL(18,6),
  p_trace_id VARCHAR(64),
  p_decision_signature VARCHAR(128),
  p_policy_version VARCHAR(32)
) RETURNS VOID AS $$
DECLARE
  v_exposure_delta DECIMAL(18,4);
  v_exposure_before DECIMAL(18,4);
  v_exposure_after DECIMAL(18,4);
  v_prev_hash VARCHAR(64);
  v_new_hash VARCHAR(64);
BEGIN
  -- Calculate exposure delta (BUY adds, SELL reduces net exposure)
  v_exposure_delta := p_quantity * COALESCE(p_price, 0);
  IF p_side = 'SELL' THEN
    v_exposure_delta := -v_exposure_delta;
  END IF;
  
  -- Get current exposure
  SELECT pending_exposure INTO v_exposure_before
  FROM shadow_ledger
  WHERE client_id = p_client_id AND symbol = p_symbol;
  
  IF NOT FOUND THEN
    v_exposure_before := 0;
  END IF;
  
  v_exposure_after := v_exposure_before + ABS(v_exposure_delta);
  
  -- Upsert shadow ledger
  INSERT INTO shadow_ledger (client_id, symbol, pending_exposure, updated_at)
  VALUES (p_client_id, p_symbol, ABS(v_exposure_delta), NOW())
  ON CONFLICT (client_id, symbol) DO UPDATE
  SET pending_exposure = shadow_ledger.pending_exposure + ABS(v_exposure_delta),
      updated_at = NOW();
  
  -- Get prev hash for chain
  SELECT hash INTO v_prev_hash
  FROM exposure_events
  WHERE client_id = p_client_id
  ORDER BY id DESC LIMIT 1;
  
  -- Calculate new hash
  v_new_hash := encode(sha256(
    (COALESCE(v_prev_hash, 'genesis') || p_trace_id || p_client_id || p_symbol || v_exposure_delta::TEXT)::bytea
  ), 'hex');
  
  -- Log exposure event
  INSERT INTO exposure_events (
    trace_id, client_id, symbol, event_type, side, quantity, price,
    exposure_delta, exposure_before, exposure_after,
    decision_signature, policy_version, prev_hash, hash
  ) VALUES (
    p_trace_id, p_client_id, p_symbol, 'AUTHORIZED', p_side, p_quantity, p_price,
    v_exposure_delta, v_exposure_before, v_exposure_after,
    p_decision_signature, p_policy_version, v_prev_hash, v_new_hash
  );
END;
$$ LANGUAGE plpgsql;

-- Function: Update shadow ledger on position close/fill
CREATE OR REPLACE FUNCTION update_shadow_ledger_on_filled(
  p_client_id VARCHAR(64),
  p_symbol VARCHAR(32),
  p_side VARCHAR(8),
  p_quantity INTEGER,
  p_fill_price DECIMAL(18,6),
  p_trace_id VARCHAR(64)
) RETURNS VOID AS $$
DECLARE
  v_exposure_delta DECIMAL(18,4);
  v_prev_hash VARCHAR(64);
  v_new_hash VARCHAR(64);
BEGIN
  v_exposure_delta := p_quantity * COALESCE(p_fill_price, 0);
  
  -- Move from pending to realized
  UPDATE shadow_ledger
  SET 
    pending_exposure = GREATEST(0, pending_exposure - v_exposure_delta),
    gross_exposure = gross_exposure + v_exposure_delta,
    net_exposure = CASE 
      WHEN p_side = 'BUY' THEN net_exposure + v_exposure_delta
      ELSE net_exposure - v_exposure_delta
    END,
    net_quantity = CASE 
      WHEN p_side = 'BUY' THEN net_quantity + p_quantity
      ELSE net_quantity - p_quantity
    END,
    updated_at = NOW()
  WHERE client_id = p_client_id AND symbol = p_symbol;
  
  -- Get prev hash
  SELECT hash INTO v_prev_hash
  FROM exposure_events
  WHERE client_id = p_client_id
  ORDER BY id DESC LIMIT 1;
  
  v_new_hash := encode(sha256(
    (COALESCE(v_prev_hash, 'genesis') || p_trace_id || p_client_id || p_symbol || v_exposure_delta::TEXT)::bytea
  ), 'hex');
  
  -- Log event
  INSERT INTO exposure_events (
    trace_id, client_id, symbol, event_type, side, quantity, price,
    exposure_delta, prev_hash, hash
  ) VALUES (
    p_trace_id, p_client_id, p_symbol, 'FILLED', p_side, p_quantity, p_fill_price,
    v_exposure_delta, v_prev_hash, v_new_hash
  );
END;
$$ LANGUAGE plpgsql;
