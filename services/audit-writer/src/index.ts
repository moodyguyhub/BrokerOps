import express from "express";
import crypto from "crypto";
import pg from "pg";
import { v4 as uuidv4 } from "uuid";
import {
  LpOrderEventSchema,
  LP_ORDER_EVENT_TYPES,
  isValidTransition,
  isTerminalStatus,
  canonicalizeJson,
  type LpOrderEvent,
  type NormalizedStatus,
  type ReasonNormalization
} from "@broker/common";

// ============================================================================
// Read Model Materialization Types
// ============================================================================

interface OrderReadModel {
  id: string;
  client_order_id: string | null;
  lp_order_id: string | null;
  symbol: string;
  side: string;
  order_type: string;
  qty: number;
  price: number | null;
  fill_qty: number;
  avg_fill_price: number | null;
  remaining_qty: number | null;
  status: string;
  lp_id: string | null;
  server_id: string;
  server_name: string;
  rejection_reason_code: string | null;
  rejection_reason_class: string | null;
  rejection_raw_message: string | null;
  decision_token_id: string | null;
  submitted_at: string | null;
  accepted_at: string | null;
  filled_at: string | null;
  rejected_at: string | null;
  canceled_at: string | null;
}

const { Pool } = pg;

const app = express();
app.use(express.json({ limit: "1mb" }));

const pool = new Pool({
  host: process.env.PGHOST ?? "localhost",
  port: Number(process.env.PGPORT ?? 5434),
  user: process.env.PGUSER ?? "broker",
  password: process.env.PGPASSWORD ?? "broker",
  database: process.env.PGDATABASE ?? "broker"
});

// ============================================================================
// Read Model Materialization Functions
// ============================================================================

async function materializeOrder(event: LpOrderEvent): Promise<void> {
  const traceId = event.correlation.trace_id;
  const payload = event.payload;
  const status = event.normalization.status;
  const occurredAt = event.occurred_at;
  
  // Determine timestamp field based on event type
  const timestampField = getTimestampField(event.event_type);
  
  // Build the upsert query
  const upsertQuery = `
    INSERT INTO orders (
      id, client_order_id, lp_order_id, symbol, side, order_type, qty, price,
      fill_qty, avg_fill_price, remaining_qty, status, lp_id, server_id, server_name,
      rejection_reason_code, rejection_reason_class, rejection_raw_message, decision_token_id,
      submitted_at, accepted_at, filled_at, rejected_at, canceled_at, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
      $20, $21, $22, $23, $24, NOW(), NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      lp_order_id = COALESCE(EXCLUDED.lp_order_id, orders.lp_order_id),
      fill_qty = COALESCE(EXCLUDED.fill_qty, orders.fill_qty),
      avg_fill_price = COALESCE(EXCLUDED.avg_fill_price, orders.avg_fill_price),
      remaining_qty = COALESCE(EXCLUDED.remaining_qty, orders.remaining_qty),
      status = EXCLUDED.status,
      rejection_reason_code = COALESCE(EXCLUDED.rejection_reason_code, orders.rejection_reason_code),
      rejection_reason_class = COALESCE(EXCLUDED.rejection_reason_class, orders.rejection_reason_class),
      rejection_raw_message = COALESCE(EXCLUDED.rejection_raw_message, orders.rejection_raw_message),
      submitted_at = COALESCE(orders.submitted_at, EXCLUDED.submitted_at),
      accepted_at = COALESCE(orders.accepted_at, EXCLUDED.accepted_at),
      filled_at = COALESCE(orders.filled_at, EXCLUDED.filled_at),
      rejected_at = COALESCE(orders.rejected_at, EXCLUDED.rejected_at),
      canceled_at = COALESCE(orders.canceled_at, EXCLUDED.canceled_at),
      updated_at = NOW()
  `;
  
  const reason = event.normalization.reason;
  
  await pool.query(upsertQuery, [
    traceId,                                            // id
    event.correlation.client_order_id ?? null,          // client_order_id
    event.correlation.lp_order_id ?? null,              // lp_order_id
    payload.symbol,                                     // symbol
    payload.side,                                       // side
    payload.order_type ?? 'LIMIT',                      // order_type
    payload.qty,                                        // qty
    payload.price ?? null,                              // price
    payload.fill_qty ?? 0,                              // fill_qty
    payload.fill_price ?? null,                         // avg_fill_price
    payload.remaining_qty ?? null,                      // remaining_qty
    status,                                             // status
    null,                                               // lp_id (derived from server_id if needed)
    event.source.server_id,                             // server_id
    event.source.server_name,                           // server_name
    reason?.reason_code ?? null,                        // rejection_reason_code
    reason?.reason_class ?? null,                       // rejection_reason_class
    reason?.raw?.provider_message ?? null,              // rejection_raw_message
    event.correlation.decision_token_id ?? null,        // decision_token_id
    timestampField === 'submitted_at' ? occurredAt : null,
    timestampField === 'accepted_at' ? occurredAt : null,
    timestampField === 'filled_at' ? occurredAt : null,
    timestampField === 'rejected_at' ? occurredAt : null,
    timestampField === 'canceled_at' ? occurredAt : null
  ]);
}

function getTimestampField(eventType: string): string {
  switch (eventType) {
    case 'lp.order.submitted': return 'submitted_at';
    case 'lp.order.accepted': return 'accepted_at';
    case 'lp.order.filled':
    case 'lp.order.partially_filled': return 'filled_at';
    case 'lp.order.rejected': return 'rejected_at';
    case 'lp.order.canceled': return 'canceled_at';
    default: return 'submitted_at';
  }
}

async function materializeLifecycleEvent(event: LpOrderEvent): Promise<void> {
  const reason = event.normalization.reason;
  
  await pool.query(`
    INSERT INTO order_lifecycle_events (
      order_id, event_id, event_type, status, qty, price, fill_qty, fill_price,
      remaining_qty, reason_code, reason_class, reason_message, payload_hash,
      prev_event_hash, occurred_at, ingested_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
    ON CONFLICT (event_id) DO NOTHING
  `, [
    event.correlation.trace_id,
    event.event_id,
    event.event_type,
    event.normalization.status,
    event.payload.qty,
    event.payload.price ?? null,
    event.payload.fill_qty ?? null,
    event.payload.fill_price ?? null,
    event.payload.remaining_qty ?? null,
    reason?.reason_code ?? null,
    reason?.reason_class ?? null,
    reason?.raw?.provider_message ?? null,
    event.integrity?.payload_hash ?? null,
    event.integrity?.prev_event_hash ?? null,
    event.occurred_at
  ]);
}

async function materializeRejection(event: LpOrderEvent): Promise<void> {
  if (event.normalization.status !== 'REJECTED' || !event.normalization.reason) {
    return;
  }
  
  const reason = event.normalization.reason;
  
  await pool.query(`
    INSERT INTO rejections (
      order_id, event_id, lp_id, server_id, server_name, symbol,
      raw_code, raw_message, raw_fields, reason_code, reason_class, reason_message,
      normalization_confidence, normalization_source, rejected_at, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
    ON CONFLICT (event_id) DO NOTHING
  `, [
    event.correlation.trace_id,
    event.event_id,
    null, // lp_id
    event.source.server_id,
    event.source.server_name,
    event.payload.symbol,
    reason.raw?.provider_code ?? null,
    reason.raw?.provider_message ?? null,
    reason.raw?.provider_fields ? JSON.stringify(reason.raw.provider_fields) : null,
    reason.reason_code,
    reason.reason_class,
    reason.raw?.provider_message ?? null,
    'HIGH', // Simulator always provides exact mappings
    'EXACT_MATCH',
    event.occurred_at
  ]);
}

async function ensureLpAccountsExist(): Promise<void> {
  // Ensure default LP accounts exist for simulator
  const lpAccounts = [
    { id: 'LP-A', name: 'Primary LP (Simulator)', server_id: 'srv-1', server_name: 'Server 1' },
    { id: 'LP-B', name: 'Secondary LP (Simulator)', server_id: 'srv-2', server_name: 'Server 2' }
  ];
  
  for (const lp of lpAccounts) {
    await pool.query(`
      INSERT INTO lp_accounts (id, name, server_id, server_name, status, balance, equity, margin, free_margin)
      VALUES ($1, $2, $3, $4, 'CONNECTED', 100000, 100000, 0, 100000)
      ON CONFLICT (id) DO NOTHING
    `, [lp.id, lp.name, lp.server_id, lp.server_name]);
  }
}

// Call on startup to seed LP accounts
ensureLpAccountsExist().catch(err => console.error('Failed to seed LP accounts:', err));

// ============================================================================
// LP Account Snapshot Materialization
// ============================================================================

interface LpAccountSnapshotEvent {
  event_id: string;
  event_type: "lp.account.snapshot";
  event_version: number;
  source: {
    kind: string;
    name: string;
    adapter_version: string;
    server_id: string;
    server_name: string;
  };
  occurred_at: string;
  payload: {
    lp_id: string;
    lp_name: string;
    balance: number;
    equity: number;
    margin: number;
    free_margin: number;
    margin_level: number | null;
    currency: string;
    status: "CONNECTED" | "DISCONNECTED" | "UNKNOWN";
    open_positions?: number;
    open_orders?: number;
  };
}

async function materializeLpAccountSnapshot(event: LpAccountSnapshotEvent): Promise<void> {
  const payload = event.payload;
  
  // Upsert LP account (update current state)
  await pool.query(`
    INSERT INTO lp_accounts (
      id, name, server_id, server_name, balance, equity, margin, free_margin,
      margin_level, status, last_heartbeat_at, currency, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      server_id = EXCLUDED.server_id,
      server_name = EXCLUDED.server_name,
      balance = EXCLUDED.balance,
      equity = EXCLUDED.equity,
      margin = EXCLUDED.margin,
      free_margin = EXCLUDED.free_margin,
      margin_level = EXCLUDED.margin_level,
      status = EXCLUDED.status,
      last_heartbeat_at = EXCLUDED.last_heartbeat_at,
      updated_at = NOW()
  `, [
    payload.lp_id,
    payload.lp_name,
    event.source.server_id,
    event.source.server_name,
    payload.balance,
    payload.equity,
    payload.margin,
    payload.free_margin,
    payload.margin_level,
    payload.status,
    event.occurred_at,
    payload.currency
  ]);
  
  // Insert snapshot for time-series history
  await pool.query(`
    INSERT INTO lp_snapshots (
      lp_id, balance, equity, margin, free_margin, margin_level,
      source_event_id, snapshot_at, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
  `, [
    payload.lp_id,
    payload.balance,
    payload.equity,
    payload.margin,
    payload.free_margin,
    payload.margin_level,
    event.event_id,
    event.occurred_at
  ]);
}

// LP Account Snapshot Endpoint
app.post("/lp-account-snapshots", async (req, res) => {
  const event = req.body as LpAccountSnapshotEvent;
  
  // Basic validation
  if (!event.event_id || event.event_type !== "lp.account.snapshot") {
    return res.status(400).json({
      error: "Invalid LP account snapshot event",
      details: "event_id required and event_type must be 'lp.account.snapshot'"
    });
  }
  
  if (!event.payload?.lp_id || !event.payload?.lp_name) {
    return res.status(400).json({
      error: "Invalid LP account snapshot payload",
      details: "payload.lp_id and payload.lp_name required"
    });
  }
  
  try {
    await materializeLpAccountSnapshot(event);
    
    // Check margin alerts (non-blocking on errors)
    checkMarginAlerts(
      event.payload.lp_id, 
      event.payload.margin_level, 
      event.source.server_id
    ).catch(err => console.error('Margin alert check failed:', err));
    
    res.json({
      ok: true,
      event_id: event.event_id,
      lp_id: event.payload.lp_id,
      snapshot_at: event.occurred_at
    });
  } catch (err) {
    console.error('LP account snapshot materialization error:', err);
    res.status(500).json({
      error: "Failed to materialize LP account snapshot",
      details: err instanceof Error ? err.message : String(err)
    });
  }
});

function canonicalJson(x: unknown): string {
  // Minimal canonicalization for v0: stable key order via JSON stringify of sorted keys.
  // (Not perfect; good enough for demo; replace with proper canonical JSON later.)
  const sort = (v: any): any => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.keys(v).sort().reduce((acc: any, k) => {
        acc[k] = sort(v[k]);
        return acc;
      }, {});
    }
    return v;
  };
  return JSON.stringify(sort(x));
}

async function getLastHash(traceId: string): Promise<string | null> {
  const r = await pool.query(
    "SELECT hash FROM audit_events WHERE trace_id=$1 ORDER BY id DESC LIMIT 1",
    [traceId]
  );
  return r.rowCount ? (r.rows[0].hash as string) : null;
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

app.post("/append", async (req, res) => {
  const { traceId, eventType, eventVersion = "v1", payload } = req.body ?? {};
  if (!traceId || !eventType) return res.status(400).json({ error: "traceId and eventType required" });

  const prevHash = await getLastHash(traceId);
  const payloadJson = payload ?? {};
  const material = (prevHash ?? "") + "|" + eventType + "|" + eventVersion + "|" + canonicalJson(payloadJson);
  const hash = sha256(material);

  await pool.query(
    "INSERT INTO audit_events(trace_id,event_type,event_version,payload_json,prev_hash,hash) VALUES($1,$2,$3,$4,$5,$6)",
    [traceId, eventType, eventVersion, payloadJson, prevHash, hash]
  );

  res.json({ ok: true, traceId, prevHash, hash });
});

// ============================================================================
// LP Order Events Endpoint (Phase 1)
// ============================================================================

interface LpEventValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

async function getLastLpEventStatus(traceId: string): Promise<NormalizedStatus | null> {
  const r = await pool.query(
    `SELECT payload_json->'normalization'->>'status' as status 
     FROM audit_events 
     WHERE trace_id=$1 AND event_type LIKE 'lp.order.%'
     ORDER BY id DESC LIMIT 1`,
    [traceId]
  );
  return r.rowCount ? (r.rows[0].status as NormalizedStatus) : null;
}

async function validateLpEvent(event: LpOrderEvent): Promise<LpEventValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Schema validation (already done by Zod, but double-check critical fields)
  if (!event.correlation?.trace_id) {
    errors.push("Missing required field: correlation.trace_id");
  }

  if (!event.normalization?.status) {
    errors.push("Missing required field: normalization.status");
  }

  // 2. Server identity validation
  if (!event.source?.server_id || event.source.server_id.trim().length === 0) {
    errors.push("Missing required field: source.server_id");
  }
  if (!event.source?.server_name || event.source.server_name.trim().length === 0) {
    errors.push("Missing required field: source.server_name");
  }

  // 3. Rejection reason validation
  if (event.normalization?.status === "REJECTED" && !event.normalization?.reason) {
    errors.push("REJECTED status requires normalization.reason");
  }

  // 4. Transition validation
  if (event.correlation?.trace_id) {
    const prevStatus = await getLastLpEventStatus(event.correlation.trace_id);
    if (prevStatus) {
      const transition = isValidTransition(prevStatus, event.normalization.status);
      if (!transition.valid) {
        // Per spec: ingest + flag, don't reject
        warnings.push(`INVALID_TRANSITION: ${prevStatus} → ${event.normalization.status}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

app.post("/lp-events", async (req, res) => {
  // 1. Parse and validate schema
  const parseResult = LpOrderEventSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: "Invalid LP order event schema",
      details: parseResult.error.format()
    });
  }

  const event = parseResult.data;

  // 2. Business validation
  const validation = await validateLpEvent(event);
  if (!validation.valid) {
    return res.status(400).json({
      error: "LP event validation failed",
      errors: validation.errors
    });
  }

  // 3. Compute hash chain
  const traceId = event.correlation.trace_id;
  const prevHash = await getLastHash(traceId);
  
  // Use the event's payload_hash if provided, otherwise compute
  const payloadForHash = { ...event };
  delete (payloadForHash as any).integrity;
  const computedPayloadHash = `sha256:${sha256(canonicalizeJson(payloadForHash))}`;
  
  // 4. Store with validation metadata
  const storedPayload = {
    ...event,
    _validation: {
      warnings: validation.warnings,
      ingested_at: new Date().toISOString(),
      computed_payload_hash: computedPayloadHash
    }
  };

  // Chain hash links prev_hash to new event (must match reconstruction verifier)
  const material = (prevHash ?? "") + "|" + event.event_type + "|" + `v${event.event_version}` + "|" + canonicalizeJson(storedPayload);
  const hash = sha256(material);

  await pool.query(
    "INSERT INTO audit_events(trace_id,event_type,event_version,payload_json,prev_hash,hash) VALUES($1,$2,$3,$4,$5,$6)",
    [traceId, event.event_type, `v${event.event_version}`, storedPayload, prevHash, hash]
  );

  // 5. Materialize read models (non-blocking on errors)
  try {
    await materializeOrder(event);
    await materializeLifecycleEvent(event);
    await materializeRejection(event);
    
    // Check rejection alerts if this was a rejection
    if (event.normalization.status === 'REJECTED') {
      checkRejectionAlerts(event.payload.symbol, event.source.server_id)
        .catch(err => console.error('Rejection alert check failed:', err));
    }
  } catch (materializeErr) {
    console.error('Read model materialization error (non-fatal):', materializeErr);
    // Continue - audit event is the source of truth, read models are derived
  }

  res.json({
    ok: true,
    event_id: event.event_id,
    trace_id: traceId,
    hash,
    prev_hash: prevHash,
    warnings: validation.warnings,
    has_violations: validation.warnings.length > 0
  });
});

// Get LP events for a trace
app.get("/lp-events/:traceId", async (req, res) => {
  const traceId = req.params.traceId;
  
  const r = await pool.query(
    `SELECT id, trace_id, event_type, event_version, payload_json, prev_hash, hash, created_at 
     FROM audit_events 
     WHERE trace_id=$1 AND event_type LIKE 'lp.order.%'
     ORDER BY id ASC`,
    [traceId]
  );

  res.json({
    trace_id: traceId,
    count: r.rowCount,
    events: r.rows
  });
});

// ============================================================================
// Alert Engine
// ============================================================================

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? null;

interface AlertSetting {
  id: string;
  category: string;
  threshold_value: number;
  threshold_unit: string;
  comparison: string;
  cooldown_seconds: number;
  enabled: boolean;
}

interface AlertContext {
  lp_id?: string;
  symbol?: string;
  server_id?: string;
  trigger_value: number;
  metadata?: Record<string, unknown>;
}

async function getAlertSettings(category: string): Promise<AlertSetting[]> {
  const result = await pool.query(
    `SELECT id, category, threshold_value::numeric, threshold_unit, comparison, cooldown_seconds, enabled
     FROM alert_settings WHERE category = $1 AND enabled = TRUE`,
    [category]
  );
  return result.rows.map(r => ({
    ...r,
    threshold_value: parseFloat(r.threshold_value)
  }));
}

async function isInCooldown(settingId: string, lpId?: string, symbol?: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM alert_cooldowns 
     WHERE setting_id = $1 
       AND COALESCE(lp_id, '') = COALESCE($2, '')
       AND COALESCE(symbol, '') = COALESCE($3, '')
       AND cooldown_until > NOW()
     LIMIT 1`,
    [settingId, lpId ?? '', symbol ?? '']
  );
  return (result.rowCount ?? 0) > 0;
}

async function setCooldown(settingId: string, cooldownSeconds: number, lpId?: string, symbol?: string): Promise<void> {
  await pool.query(
    `INSERT INTO alert_cooldowns (setting_id, lp_id, symbol, last_fired_at, cooldown_until)
     VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '1 second' * $4)
     ON CONFLICT (setting_id, COALESCE(lp_id, ''), COALESCE(symbol, ''))
     DO UPDATE SET last_fired_at = NOW(), cooldown_until = NOW() + INTERVAL '1 second' * $4`,
    [settingId, lpId ?? null, symbol ?? null, cooldownSeconds]
  );
}

function getSeverity(settingId: string): string {
  if (settingId.includes('CRITICAL') || settingId === 'REJECT_SPIKE_1MIN') return 'CRITICAL';
  if (settingId.includes('WARNING') || settingId === 'REJECT_SPIKE_5MIN') return 'WARNING';
  return 'INFO';
}

function checkThreshold(value: number, threshold: number, comparison: string): boolean {
  switch (comparison) {
    case 'LT': return value < threshold;
    case 'LTE': return value <= threshold;
    case 'GT': return value > threshold;
    case 'GTE': return value >= threshold;
    case 'EQ': return value === threshold;
    default: return false;
  }
}

async function createAlert(
  setting: AlertSetting,
  context: AlertContext,
  title: string,
  message: string
): Promise<string | null> {
  // Check cooldown
  if (await isInCooldown(setting.id, context.lp_id, context.symbol)) {
    console.log(`Alert ${setting.id} in cooldown for ${context.lp_id ?? 'global'}`);
    return null;
  }
  
  const alertId = uuidv4();
  const severity = getSeverity(setting.id);
  
  await pool.query(
    `INSERT INTO alerts (
      alert_id, setting_id, severity, category, lp_id, symbol, server_id,
      title, message, trigger_value, threshold_value, status, triggered_at, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'OPEN', NOW(), $12)`,
    [
      alertId,
      setting.id,
      severity,
      setting.category,
      context.lp_id ?? null,
      context.symbol ?? null,
      context.server_id ?? null,
      title,
      message,
      context.trigger_value,
      setting.threshold_value,
      context.metadata ? JSON.stringify(context.metadata) : null
    ]
  );
  
  // Set cooldown
  await setCooldown(setting.id, setting.cooldown_seconds, context.lp_id, context.symbol);
  
  // Send Slack notification (non-blocking)
  sendSlackNotification(alertId, severity, title, message).catch(err => {
    console.error('Slack notification failed:', err);
  });
  
  console.log(`Alert created: ${alertId} [${severity}] ${title}`);
  return alertId;
}

async function sendSlackNotification(alertId: string, severity: string, title: string, message: string): Promise<void> {
  if (!SLACK_WEBHOOK_URL) return;
  
  const emoji = severity === 'CRITICAL' ? '🚨' : severity === 'WARNING' ? '⚠️' : 'ℹ️';
  const color = severity === 'CRITICAL' ? '#dc3545' : severity === 'WARNING' ? '#ffc107' : '#17a2b8';
  
  const payload = {
    attachments: [{
      color,
      title: `${emoji} ${title}`,
      text: message,
      footer: `Alert ID: ${alertId}`,
      ts: Math.floor(Date.now() / 1000)
    }]
  };
  
  try {
    const response = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000)
    });
    
    // Log notification
    await pool.query(
      `INSERT INTO notification_log (alert_id, channel_type, channel_target, subject, body, status, sent_at)
       VALUES ($1, 'SLACK', $2, $3, $4, $5, NOW())`,
      [alertId, SLACK_WEBHOOK_URL, title, message, response.ok ? 'SENT' : 'FAILED']
    );
  } catch (err) {
    await pool.query(
      `INSERT INTO notification_log (alert_id, channel_type, channel_target, subject, body, status, error_message)
       VALUES ($1, 'SLACK', $2, $3, $4, 'FAILED', $5)`,
      [alertId, SLACK_WEBHOOK_URL, title, message, err instanceof Error ? err.message : String(err)]
    );
  }
}

// Check margin alerts after LP snapshot
async function checkMarginAlerts(lpId: string, marginLevel: number | null, serverId: string): Promise<void> {
  if (marginLevel === null) return;
  
  const settings = await getAlertSettings('MARGIN');
  
  for (const setting of settings) {
    if (checkThreshold(marginLevel, setting.threshold_value, setting.comparison)) {
      await createAlert(
        setting,
        { lp_id: lpId, server_id: serverId, trigger_value: marginLevel },
        `${setting.id.replace(/_/g, ' ')}: ${lpId}`,
        `LP ${lpId} margin level dropped to ${marginLevel.toFixed(2)}% (threshold: ${setting.threshold_value}%)`
      );
    }
  }
}

// Check rejection spike alerts
async function checkRejectionAlerts(symbol: string, serverId: string): Promise<void> {
  const settings = await getAlertSettings('REJECTION');
  
  for (const setting of settings) {
    let windowMinutes = 5;
    if (setting.id === 'REJECT_SPIKE_1MIN') windowMinutes = 1;
    
    // Count rejections in window
    const countResult = await pool.query(
      `SELECT COUNT(*) as cnt FROM rejections 
       WHERE rejected_at >= NOW() - INTERVAL '1 minute' * $1`,
      [windowMinutes]
    );
    const count = parseInt(countResult.rows[0].cnt, 10);
    
    if (setting.threshold_unit === 'COUNT' && checkThreshold(count, setting.threshold_value, setting.comparison)) {
      await createAlert(
        setting,
        { symbol, server_id: serverId, trigger_value: count },
        `Rejection Spike Detected`,
        `${count} rejections in the last ${windowMinutes} minute(s) (threshold: ${setting.threshold_value})`
      );
    }
  }
}

app.get("/health", async (_, res) => {
  const r = await pool.query("SELECT 1 as ok");
  res.json({ ok: r.rows?.[0]?.ok === 1 });
});

const port = process.env.PORT ? Number(process.env.PORT) : 7003;
app.listen(port, () => console.log(`audit-writer listening on :${port}`));
