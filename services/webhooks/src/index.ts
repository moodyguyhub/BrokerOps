import express from "express";
import crypto from "crypto";
import pg from "pg";
import { z } from "zod";
import {
  IdempotencyStore,
  ExecutionReportedSchema,
  PositionClosedSchema,
  EconomicsReconciledSchema,
  LifecycleEventSchema,
  generateIdempotencyKey,
  extractSourceSystem,
  type LifecycleEvent
} from "@broker/common";

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

// --- Schemas ---

const VALID_EVENTS = [
  "trace.completed",
  "override.requested", 
  "override.approved",
  "override.rejected",
  "economics.recorded"
] as const;

const WebhookRegistrationSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(VALID_EVENTS)).min(1),
  secret: z.string().optional()
});

const WebhookEventSchema = z.object({
  type: z.enum(VALID_EVENTS),
  traceId: z.string(),
  payload: z.record(z.unknown()),
  timestamp: z.string().optional()
});

type WebhookEvent = z.infer<typeof WebhookEventSchema>;

// --- In-memory webhook store (replace with DB for production) ---
interface Webhook {
  id: string;
  url: string;
  events: string[];
  secret?: string;
  createdAt: string;
  active: boolean;
}

const webhooks: Map<string, Webhook> = new Map();

// --- Helpers ---

function generateId(): string {
  return crypto.randomUUID();
}

function signPayload(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

async function deliverWebhook(webhook: Webhook, event: WebhookEvent): Promise<boolean> {
  const payload = JSON.stringify({
    id: generateId(),
    type: event.type,
    traceId: event.traceId,
    timestamp: event.timestamp ?? new Date().toISOString(),
    data: event.payload
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-BrokerOps-Event": event.type,
    "X-BrokerOps-Delivery": generateId()
  };

  if (webhook.secret) {
    headers["X-BrokerOps-Signature"] = `sha256=${signPayload(payload, webhook.secret)}`;
  }

  try {
    const response = await fetch(webhook.url, {
      method: "POST",
      headers,
      body: payload,
      signal: AbortSignal.timeout(10000) // 10s timeout
    });

    const success = response.ok;
    
    // Log delivery attempt
    await pool.query(
      `INSERT INTO webhook_deliveries(webhook_id, event_type, trace_id, success, status_code, created_at)
       VALUES($1, $2, $3, $4, $5, NOW())`,
      [webhook.id, event.type, event.traceId, success, response.status]
    ).catch(() => {}); // Best effort logging

    return success;
  } catch (err) {
    // Log failed delivery
    await pool.query(
      `INSERT INTO webhook_deliveries(webhook_id, event_type, trace_id, success, error_message, created_at)
       VALUES($1, $2, $3, false, $4, NOW())`,
      [webhook.id, event.type, event.traceId, String(err)]
    ).catch(() => {});

    return false;
  }
}

// --- Endpoints ---

// List webhooks
app.get("/webhooks", async (_, res) => {
  const result = Array.from(webhooks.values()).map(w => ({
    id: w.id,
    url: w.url,
    events: w.events,
    createdAt: w.createdAt,
    active: w.active
  }));
  res.json(result);
});

// Register webhook
app.post("/webhooks", async (req, res) => {
  const parsed = WebhookRegistrationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid webhook registration", details: parsed.error.format() });
  }

  const webhook: Webhook = {
    id: generateId(),
    url: parsed.data.url,
    events: parsed.data.events,
    secret: parsed.data.secret,
    createdAt: new Date().toISOString(),
    active: true
  };

  webhooks.set(webhook.id, webhook);

  // Persist to DB
  await pool.query(
    `INSERT INTO webhooks(id, url, events, secret_hash, created_at, active)
     VALUES($1, $2, $3, $4, NOW(), true)`,
    [webhook.id, webhook.url, JSON.stringify(webhook.events), webhook.secret ? signPayload(webhook.secret, "salt") : null]
  ).catch(() => {}); // Best effort

  res.status(201).json({
    id: webhook.id,
    url: webhook.url,
    events: webhook.events,
    createdAt: webhook.createdAt,
    active: webhook.active
  });
});

// Delete webhook
app.delete("/webhooks/:id", async (req, res) => {
  const { id } = req.params;
  
  if (!webhooks.has(id)) {
    return res.status(404).json({ error: "Webhook not found" });
  }

  webhooks.delete(id);
  
  await pool.query("UPDATE webhooks SET active = false WHERE id = $1", [id]).catch(() => {});

  res.status(204).send();
});

// Internal: Emit event (called by other services)
app.post("/emit", async (req, res) => {
  const parsed = WebhookEventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid event", details: parsed.error.format() });
  }

  const event = parsed.data;
  const matchingWebhooks = Array.from(webhooks.values())
    .filter(w => w.active && w.events.includes(event.type));

  const results = await Promise.all(
    matchingWebhooks.map(async w => ({
      webhookId: w.id,
      url: w.url,
      success: await deliverWebhook(w, event)
    }))
  );

  res.json({
    event: event.type,
    traceId: event.traceId,
    deliveries: results.length,
    successful: results.filter(r => r.success).length,
    results
  });
});

// Get recent webhook deliveries (for UI)
app.get("/webhooks/deliveries", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const webhookId = req.query.webhookId as string | undefined;
  
  let query = `
    SELECT id, webhook_id, event_type, trace_id, success, status_code, error_message, created_at
    FROM webhook_deliveries
  `;
  const params: any[] = [];
  
  if (webhookId) {
    query += " WHERE webhook_id = $1";
    params.push(webhookId);
  }
  
  query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);
  
  try {
    const result = await pool.query(query, params);
    res.json({
      count: result.rowCount,
      deliveries: result.rows.map(row => ({
        id: row.id,
        webhookId: row.webhook_id,
        eventType: row.event_type,
        traceId: row.trace_id,
        success: row.success,
        statusCode: row.status_code,
        errorMessage: row.error_message,
        createdAt: row.created_at
      }))
    });
  } catch {
    res.json({ count: 0, deliveries: [] });
  }
});

// Health check
app.get("/health", async (_, res) => {
  res.json({ ok: true, webhookCount: webhooks.size });
});

// --- P2: Lifecycle Event Ingestion (Event Gateway) ---
// DEC-P2-EVENT-GATEWAY: Webhooks service is the lifecycle event gateway

const idempotencyStore = new IdempotencyStore(pool);

// Risk mitigation: API key validation for event endpoints
// Production: use vault-rotated keys, HMAC signatures, mutual TLS
const EVENT_API_KEY_HEADER = 'x-broker-api-key';
const validateEventApiKey = (req: any): boolean => {
  const key = req.headers[EVENT_API_KEY_HEADER];
  const expected = process.env.EVENT_API_KEY;
  // Dev mode: allow if no key configured
  if (!expected) return true;
  return key === expected;
};

// Risk mitigation: Clock skew - always record both asserted and received timestamps
const captureTimestamps = (event: any) => ({
  asserted_at: event.event_timestamp ?? event.source_timestamp ?? null,
  received_at: new Date().toISOString()
});

/**
 * POST /events/execution - Ingest execution.reported events
 * Idempotency: exec:{exec_id}
 */
app.post("/events/execution", async (req, res) => {
  // Risk: AuthN check
  if (!validateEventApiKey(req)) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid or missing API key' });
  }

  const timestamps = captureTimestamps(req.body);
  res.setHeader('X-Broker-Received-At', timestamps.received_at);

  const parsed = ExecutionReportedSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ 
      error: "Validation failed", 
      event_type: "execution.reported",
      details: parsed.error.format() 
    });
  }

  const event = parsed.data;
  const idempotencyKey = {
    source_system: extractSourceSystem(event),
    event_type: event.event_type,
    event_id: event.exec_id
  };

  // Check idempotency
  const check = await idempotencyStore.checkAndReserve(idempotencyKey, event);
  
  if (!check.should_process) {
    // Duplicate - return previous result
    if (check.payload_mismatch) {
      console.warn(`Payload mismatch for ${event.exec_id} - same exec_id, different payload`);
    }
    return res.status(409).json({
      status: "duplicate",
      first_seen_at: check.first_seen_at,
      previous_result: check.previous_result,
      payload_mismatch: check.payload_mismatch
    });
  }

  try {
    // Store the execution event (with clock skew protection)
    await pool.query(`
      INSERT INTO lifecycle_events (
        event_type, event_id, idempotency_key, decision_token,
        symbol, side, qty, price, source, raw_payload, 
        asserted_at, received_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
    `, [
      event.event_type,
      event.event_id,
      event.idempotency_key,
      event.decision_token,
      event.symbol,
      event.side,
      event.fill_qty,
      event.fill_price,
      event.source,
      JSON.stringify(event),
      timestamps.asserted_at,
      timestamps.received_at
    ]);

    // Mark idempotency as success
    await idempotencyStore.complete(idempotencyKey, 'SUCCESS', {
      decision_token: event.decision_token,
      exec_id: event.exec_id
    });

    res.status(200).json({
      status: "accepted",
      event_id: event.event_id,
      decision_token: event.decision_token
    });

  } catch (err) {
    await idempotencyStore.complete(idempotencyKey, 'FAILED', {
      error: String(err)
    });
    console.error("Failed to process execution event:", err);
    res.status(500).json({ error: "Processing failed" });
  }
});

/**
 * POST /events/position-closed - Ingest position.closed events
 * Idempotency: close:{close_id}
 */
app.post("/events/position-closed", async (req, res) => {
  // Risk: AuthN check
  if (!validateEventApiKey(req)) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid or missing API key' });
  }

  const timestamps = captureTimestamps(req.body);
  res.setHeader('X-Broker-Received-At', timestamps.received_at);

  const parsed = PositionClosedSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ 
      error: "Validation failed", 
      event_type: "position.closed",
      details: parsed.error.format() 
    });
  }

  const event = parsed.data;
  const idempotencyKey = {
    source_system: extractSourceSystem(event),
    event_type: event.event_type,
    event_id: event.close_id
  };

  const check = await idempotencyStore.checkAndReserve(idempotencyKey, event);
  
  if (!check.should_process) {
    return res.status(409).json({
      status: "duplicate",
      first_seen_at: check.first_seen_at,
      previous_result: check.previous_result
    });
  }

  try {
    await pool.query(`
      INSERT INTO lifecycle_events (
        event_type, event_id, idempotency_key, decision_token,
        symbol, side, qty, price, realized_pnl, pnl_source, raw_payload,
        asserted_at, received_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
    `, [
      event.event_type,
      event.event_id,
      event.idempotency_key,
      event.decision_token,
      event.symbol,
      event.side,
      event.qty,
      event.exit_price,
      event.realized_pnl,
      event.pnl_source,
      JSON.stringify(event),
      timestamps.asserted_at,
      timestamps.received_at
    ]);

    await idempotencyStore.complete(idempotencyKey, 'SUCCESS', {
      decision_token: event.decision_token,
      close_id: event.close_id,
      realized_pnl: event.realized_pnl
    });

    res.status(200).json({
      status: "accepted",
      event_id: event.event_id,
      decision_token: event.decision_token,
      realized_pnl: event.realized_pnl
    });

  } catch (err) {
    await idempotencyStore.complete(idempotencyKey, 'FAILED', { error: String(err) });
    console.error("Failed to process position.closed event:", err);
    res.status(500).json({ error: "Processing failed" });
  }
});

/**
 * POST /events/reconciliation - Ingest economics.reconciled events (T+1)
 * Idempotency: recon:{trade_date}:{symbol}:{account_id}
 */
app.post("/events/reconciliation", async (req, res) => {
  // Risk: AuthN check
  if (!validateEventApiKey(req)) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid or missing API key' });
  }

  const timestamps = captureTimestamps(req.body);
  res.setHeader('X-Broker-Received-At', timestamps.received_at);

  const parsed = EconomicsReconciledSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ 
      error: "Validation failed", 
      event_type: "economics.reconciled",
      details: parsed.error.format() 
    });
  }

  const event = parsed.data;
  const idempotencyKey = {
    source_system: 'backoffice',
    event_type: event.event_type,
    event_id: `${event.trade_date}:${event.symbol}:${event.account_id}`
  };

  const check = await idempotencyStore.checkAndReserve(idempotencyKey, event);
  
  if (!check.should_process) {
    return res.status(409).json({
      status: "duplicate",
      first_seen_at: check.first_seen_at,
      previous_result: check.previous_result
    });
  }

  try {
    await pool.query(`
      INSERT INTO lifecycle_events (
        event_type, event_id, idempotency_key, decision_token,
        symbol, realized_pnl, pnl_source, raw_payload, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    `, [
      event.event_type,
      event.event_id,
      event.idempotency_key,
      event.decision_tokens.join(','),
      event.symbol,
      event.authoritative_pnl,
      'BACKOFFICE',
      JSON.stringify(event)
    ]);

    await idempotencyStore.complete(idempotencyKey, 'SUCCESS', {
      decision_tokens: event.decision_tokens,
      authoritative_pnl: event.authoritative_pnl,
      discrepancy: event.discrepancy
    });

    res.status(200).json({
      status: "accepted",
      event_id: event.event_id,
      decision_tokens: event.decision_tokens,
      authoritative_pnl: event.authoritative_pnl
    });

  } catch (err) {
    await idempotencyStore.complete(idempotencyKey, 'FAILED', { error: String(err) });
    console.error("Failed to process reconciliation event:", err);
    res.status(500).json({ error: "Processing failed" });
  }
});

/**
 * GET /events/idempotency/stats - Idempotency store statistics
 */
app.get("/events/idempotency/stats", async (req, res) => {
  const hours = parseInt(req.query.hours as string) || 24;
  const stats = await idempotencyStore.getStats(hours);
  res.json(stats);
});

/**
 * GET /events/lifecycle/:decisionToken - Get lifecycle events for a decision
 */
app.get("/events/lifecycle/:decisionToken", async (req, res) => {
  const { decisionToken } = req.params;
  
  try {
    const result = await pool.query(`
      SELECT 
        event_type, event_id, symbol, side, qty, price, 
        realized_pnl, pnl_source, created_at, raw_payload
      FROM lifecycle_events
      WHERE decision_token = $1 OR decision_token LIKE $2
      ORDER BY created_at ASC
    `, [decisionToken, `%${decisionToken}%`]);

    res.json({
      decision_token: decisionToken,
      events: result.rows.map(row => ({
        event_type: row.event_type,
        event_id: row.event_id,
        symbol: row.symbol,
        side: row.side,
        qty: row.qty,
        price: row.price ? parseFloat(row.price) : undefined,
        realized_pnl: row.realized_pnl ? parseFloat(row.realized_pnl) : undefined,
        pnl_source: row.pnl_source,
        created_at: row.created_at,
        details: row.raw_payload
      }))
    });
  } catch {
    res.json({ decision_token: decisionToken, events: [] });
  }
});

// Load webhooks from DB on startup
async function loadWebhooks() {
  try {
    const result = await pool.query(
      "SELECT id, url, events, created_at, active FROM webhooks WHERE active = true"
    );
    for (const row of result.rows) {
      webhooks.set(row.id, {
        id: row.id,
        url: row.url,
        events: typeof row.events === "string" ? JSON.parse(row.events) : row.events,
        createdAt: row.created_at,
        active: row.active
      });
    }
    console.log(`Loaded ${webhooks.size} webhooks from database`);
  } catch {
    console.log("No existing webhooks loaded (table may not exist)");
  }
}

const port = process.env.PORT ? Number(process.env.PORT) : 7006;

loadWebhooks().then(() => {
  app.listen(port, () => console.log(`webhooks service listening on :${port}`));
});

export { WebhookEvent, VALID_EVENTS };
