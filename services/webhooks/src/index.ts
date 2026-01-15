import express from "express";
import crypto from "crypto";
import pg from "pg";
import { z } from "zod";

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
