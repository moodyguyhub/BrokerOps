import express from "express";
import { execSync } from "child_process";
import pg from "pg";
import { z } from "zod";
import { 
  newTraceId, 
  OrderRequestSchema, 
  type RiskDecision, 
  emitWebhook,
  issueDecisionToken,
  getCompactSignature,
  computeSnapshotEconomics,
  type SnapshotEconomics,
  hashComponent,
  calculatePackHash
} from "@broker/common";
import { createHash } from "crypto";

const { Pool } = pg;

// Build identity for demo/incident triage
const BUILD_INFO = {
  commit: (() => {
    try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); }
    catch { return "unknown"; }
  })(),
  built_at: new Date().toISOString(),
  service: "order-api"
};

const app = express();
app.use(express.json());

// Database connection for read models
const pool = new Pool({
  host: process.env.PGHOST ?? "localhost",
  port: Number(process.env.PGPORT ?? 5434),
  user: process.env.PGUSER ?? "broker",
  password: process.env.PGPASSWORD ?? "broker",
  database: process.env.PGDATABASE ?? "broker"
});

const RISK_GATE_URL = process.env.RISK_GATE_URL ?? "http://localhost:7002";
const AUDIT_URL = process.env.AUDIT_URL ?? "http://localhost:7003";
const RECONSTRUCTION_URL = process.env.RECONSTRUCTION_URL ?? "http://localhost:7004";
const ECONOMICS_URL = process.env.ECONOMICS_URL ?? "http://localhost:7005";

async function audit(traceId: string, eventType: string, payload: any) {
  const r = await fetch(`${AUDIT_URL}/append`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ traceId, eventType, eventVersion: "v1", payload })
  });
  if (!r.ok) throw new Error(`audit append failed: ${r.status}`);
  return r.json();
}

async function getTraceEvents(traceId: string): Promise<any[]> {
  const r = await fetch(`${RECONSTRUCTION_URL}/trace/${traceId}`);
  if (!r.ok) return [];
  const data = await r.json() as { events?: any[] };
  return data.events ?? [];
}

async function decideRisk(order: any): Promise<RiskDecision> {
  const r = await fetch(`${RISK_GATE_URL}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(order)
  });
  if (!r.ok) throw new Error(`risk-gate failed: ${r.status}`);
  return r.json() as Promise<RiskDecision>;
}

// Record snapshot economics to economics service
async function recordSnapshotEconomics(
  traceId: string, 
  decision: 'ALLOW' | 'BLOCK', 
  economics: SnapshotEconomics,
  policyId?: string
) {
  try {
    const eventType = decision === 'BLOCK' ? 'TRADE_BLOCKED' : 'TRADE_EXECUTED';
    await fetch(`${ECONOMICS_URL}/economics/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        traceId,
        type: eventType,
        grossRevenue: decision === 'ALLOW' ? 0 : 0,
        estimatedLostRevenue: economics.saved_exposure ?? 0,
        currency: 'USD',
        source: 'order-api',
        policyId
      })
    });
  } catch (err) {
    console.error(`Economics recording failed for ${traceId}:`, err);
    // Non-blocking - economics recording failure shouldn't block order flow
  }
}

app.post("/orders", async (req, res) => {
  const traceId = req.header("x-trace-id") ?? newTraceId();
  const clientId = req.header("x-client-id") ?? "default-client";
  const audience = req.header("x-audience") ?? "trading-platform";
  const decisionTime = new Date().toISOString();

  const parsed = OrderRequestSchema.safeParse(req.body);
  await audit(traceId, "order.requested", { raw: req.body, valid: parsed.success });

  if (!parsed.success) {
    await audit(traceId, "order.blocked", { reason: "INVALID_ORDER_SCHEMA", details: parsed.error.flatten() });
    return res.status(400).json({ traceId, status: "BLOCKED", reason: "INVALID_ORDER_SCHEMA" });
  }

  const order = parsed.data;
  const decision = await decideRisk(order);
  await audit(traceId, "risk.decision", decision);

  // P1 Hardening: Extract price assertion metadata from request headers
  const priceAssertedBy = req.header("x-price-asserted-by") ?? "platform-default";
  const priceAssertedAt = req.header("x-price-asserted-at") ?? decisionTime;
  const priceSignature = req.header("x-price-signature");
  const orderCurrency = (order as any).currency ?? "USD";

  // P1: Compute snapshot economics at decision time with price assertion
  const snapshotResult = computeSnapshotEconomics({
    qty: order.qty ?? 0,
    price: order.price,
    referencePrice: (order as any).referencePrice, // Platform may provide for market orders
    decision: decision.decision === "BLOCK" ? "BLOCK" : "ALLOW",
    decision_time: decisionTime,
    exposure_pre: null, // TODO: Get from shadow ledger when integrated
    policy_context: (decision as any).ruleId ? {
      limit_type: (decision as any).reasonCode,
      limit_value: undefined
    } : undefined,
    // P1-R1: Price trust boundary
    price_asserted_by: priceAssertedBy,
    price_asserted_at: priceAssertedAt,
    price_signature: priceSignature,
    // P1-R3: Currency validation
    currency: orderCurrency
  });

  const snapshotEconomics = snapshotResult.economics;

  // Calculate projected exposure for shadow ledger (legacy field)
  const projectedExposure = snapshotEconomics.notional ?? 0;

  if (decision.decision === "BLOCK") {
    // Issue BLOCKED Decision Token
    const token = issueDecisionToken({
      traceId,
      decision: "BLOCK",
      reasonCode: (decision as any).reasonCode,
      ruleId: (decision as any).ruleId,
      policyVersion: decision.policyVersion,
      order: {
        symbol: order.symbol,
        side: order.side,
        qty: order.qty,
        price: order.price,
        clientOrderId: order.clientOrderId
      },
      subject: clientId,
      audience,
      projectedExposure
    });

    // Audit with snapshot economics
    await audit(traceId, "order.blocked", { 
      ...decision, 
      order,
      decisionToken: token.payload,
      decision_signature: getCompactSignature(token),
      snapshot_economics: snapshotEconomics
    });

    // Record economics (non-blocking)
    recordSnapshotEconomics(traceId, 'BLOCK', snapshotEconomics, (decision as any).ruleId);

    await emitWebhook("trace.completed", traceId, { 
      status: "BLOCKED", 
      ...decision, 
      order,
      decision_signature: getCompactSignature(token),
      snapshot_economics: snapshotEconomics
    });

    return res.status(403).json({ 
      traceId, 
      status: "BLOCKED", 
      ...decision,
      decision_signature: getCompactSignature(token),
      decision_token: token,
      snapshot_economics: snapshotEconomics
    });
  }

  // Issue AUTHORIZED Decision Token (renamed from ACCEPTED)
  const token = issueDecisionToken({
    traceId,
    decision: "ALLOW",
    reasonCode: (decision as any).reasonCode ?? "OK",
    ruleId: (decision as any).ruleId,
    policyVersion: decision.policyVersion,
    order: {
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      price: order.price,
      clientOrderId: order.clientOrderId
    },
    subject: clientId,
    audience,
    projectedExposure
  });

  // Audit with snapshot economics
  await audit(traceId, "order.authorized", { 
    ...decision, 
    order,
    decisionToken: token.payload,
    decision_signature: getCompactSignature(token),
    snapshot_economics: snapshotEconomics
  });

  // Record economics (non-blocking)
  recordSnapshotEconomics(traceId, 'ALLOW', snapshotEconomics, (decision as any).ruleId);

  await emitWebhook("trace.completed", traceId, { 
    status: "AUTHORIZED", 
    ...decision, 
    order,
    decision_signature: getCompactSignature(token),
    snapshot_economics: snapshotEconomics
  });

  // Gate issues Decision Token - trading platform is execution master
  return res.json({ 
    traceId, 
    status: "AUTHORIZED",
    ...decision,
    decision_signature: getCompactSignature(token),
    decision_token: token,
    snapshot_economics: snapshotEconomics,
    gate_note: "Decision Token issued. Trading platform remains execution master."
  });
});

// ============================================================================
// DUAL-CONTROL OVERRIDE FLOW
// Step 1: Request override (first operator)
// Step 2: Approve override (second operator, different from requester)
// ============================================================================

// Step 1: Request an override (creates pending state)
app.post("/override/:traceId/request", async (req, res) => {
  const { traceId } = req.params;
  const { operatorId, reason, newDecision } = req.body ?? {};

  if (!operatorId || !reason) {
    return res.status(400).json({ error: "operatorId and reason required" });
  }

  if (!newDecision || !["ALLOW", "BLOCK"].includes(newDecision)) {
    return res.status(400).json({ error: "newDecision must be ALLOW or BLOCK" });
  }

  // Check if there's already a pending request
  const events = await getTraceEvents(traceId);
  const pendingRequest = events.find(e => 
    e.event_type === "override.requested" && 
    !events.some(a => a.event_type === "override.approved" || a.event_type === "override.rejected")
  );

  if (pendingRequest) {
    return res.status(409).json({ 
      error: "OVERRIDE_ALREADY_PENDING",
      existingRequest: pendingRequest.payload_json,
      message: "An override request is already pending approval"
    });
  }

  const requestEvent = {
    requestedBy: operatorId,
    reason,
    newDecision,
    requestedAt: new Date().toISOString(),
    pendingStatus: "PENDING_APPROVAL"
  };

  await audit(traceId, "override.requested", requestEvent);
  await emitWebhook("override.requested", traceId, requestEvent);

  return res.json({ 
    traceId, 
    status: "OVERRIDE_REQUESTED",
    requestedBy: operatorId,
    reason,
    newDecision,
    requestedAt: requestEvent.requestedAt,
    nextStep: `POST /override/${traceId}/approve with different operatorId`
  });
});

// Step 2: Approve an override (second operator, must be different)
app.post("/override/:traceId/approve", async (req, res) => {
  const { traceId } = req.params;
  const { operatorId, comment } = req.body ?? {};

  if (!operatorId) {
    return res.status(400).json({ error: "operatorId required" });
  }

  // Find the pending request
  const events = await getTraceEvents(traceId);
  const pendingRequest = events.find(e => e.event_type === "override.requested");
  const alreadyApproved = events.find(e => e.event_type === "override.approved");
  const alreadyRejected = events.find(e => e.event_type === "override.rejected");

  if (!pendingRequest) {
    return res.status(404).json({ 
      error: "NO_PENDING_OVERRIDE",
      message: "No override request found for this trace"
    });
  }

  if (alreadyApproved || alreadyRejected) {
    return res.status(409).json({ 
      error: "OVERRIDE_ALREADY_RESOLVED",
      resolution: alreadyApproved ? "approved" : "rejected"
    });
  }

  // DUAL CONTROL: Approver must be different from requester
  const requestedBy = pendingRequest.payload_json?.requestedBy;
  if (operatorId === requestedBy) {
    return res.status(403).json({ 
      error: "DUAL_CONTROL_VIOLATION",
      message: "Approver must be different from requester",
      requestedBy,
      attemptedApprover: operatorId
    });
  }

  const approvalEvent = {
    approvedBy: operatorId,
    requestedBy,
    originalRequest: pendingRequest.payload_json,
    newDecision: pendingRequest.payload_json?.newDecision,
    comment: comment ?? null,
    approvedAt: new Date().toISOString(),
    dualControlVerified: true
  };

  await audit(traceId, "override.approved", approvalEvent);
  await emitWebhook("override.approved", traceId, approvalEvent);

  return res.json({ 
    traceId, 
    status: "OVERRIDE_APPROVED",
    ...approvalEvent
  });
});

// Step 2 (alt): Reject an override
app.post("/override/:traceId/reject", async (req, res) => {
  const { traceId } = req.params;
  const { operatorId, reason } = req.body ?? {};

  if (!operatorId || !reason) {
    return res.status(400).json({ error: "operatorId and reason required" });
  }

  const events = await getTraceEvents(traceId);
  const pendingRequest = events.find(e => e.event_type === "override.requested");
  const alreadyResolved = events.find(e => 
    e.event_type === "override.approved" || e.event_type === "override.rejected"
  );

  if (!pendingRequest) {
    return res.status(404).json({ error: "NO_PENDING_OVERRIDE" });
  }

  if (alreadyResolved) {
    return res.status(409).json({ error: "OVERRIDE_ALREADY_RESOLVED" });
  }

  const rejectionEvent = {
    rejectedBy: operatorId,
    requestedBy: pendingRequest.payload_json?.requestedBy,
    reason,
    rejectedAt: new Date().toISOString()
  };

  await audit(traceId, "override.rejected", rejectionEvent);
  await emitWebhook("override.rejected", traceId, rejectionEvent);

  return res.json({ 
    traceId, 
    status: "OVERRIDE_REJECTED",
    ...rejectionEvent
  });
});

// Legacy single-operator override (deprecated, kept for backward compat)
app.post("/override/:traceId", async (req, res) => {
  const { traceId } = req.params;
  const { operatorId, reason, newDecision } = req.body ?? {};

  if (!operatorId || !reason) {
    return res.status(400).json({ error: "operatorId and reason required" });
  }

  if (!newDecision || !["ALLOW", "BLOCK"].includes(newDecision)) {
    return res.status(400).json({ error: "newDecision must be ALLOW or BLOCK" });
  }

  // Log as legacy override (single-operator, not dual-control)
  const overrideEvent = {
    operatorId,
    reason,
    newDecision,
    timestamp: new Date().toISOString(),
    overrideType: "legacy_single_operator",
    dualControlWarning: "DUAL_CONTROL_NOT_ENFORCED"
  };

  await audit(traceId, "operator.override", overrideEvent);

  return res.json({ 
    traceId, 
    status: "OVERRIDE_RECORDED",
    deprecationWarning: "Use /override/:traceId/request + /approve for dual-control.",
    operatorId,
    reason,
    newDecision,
    timestamp: overrideEvent.timestamp,
    overrideType: overrideEvent.overrideType
  });
});

// ============================================================================
// P3 GATE CONTRACT: /v1/authorize - Primary Authorization Endpoint
// 
// Authority boundary:
//   - BrokerOps = decision authority (AUTHORIZED/BLOCKED)
//   - Trading platform = execution authority
//   - Decision Token = proof of authorization, not execution instruction
// 
// Latency SLO (topology-dependent):
//   - Same-host/LAN: p99 < 50ms (revised from 10ms per P0-PERF evidence)
//   - Cross-region: Consult deployment-specific SLO
//
// Failure Mode (DEC-P3 PD-5):
//   - FAIL-CLOSED: If audit unavailable, return BLOCKED with AUDIT_UNAVAILABLE
//   - Process does NOT crash; returns stable error shape
// ============================================================================
app.post("/v1/authorize", async (req, res) => {
  const startTime = process.hrtime.bigint();
  const timing: Record<string, number> = {};
  
  const traceId = req.header("x-trace-id") ?? newTraceId();
  const clientId = req.header("x-client-id") ?? req.body?.context?.client_id ?? "default-client";
  const audience = req.header("x-audience") ?? "trading-platform";
  const decisionTime = new Date().toISOString();

  // Segment timing helper
  const markTime = (segment: string) => {
    timing[segment] = Number(process.hrtime.bigint() - startTime) / 1e6;
  };

  // Extract order from v1 schema
  const orderPayload = req.body?.order ?? req.body;
  
  // Map v1 field names to internal schema
  const normalizedOrder = {
    clientOrderId: orderPayload.client_order_id ?? orderPayload.clientOrderId,
    symbol: orderPayload.symbol,
    side: orderPayload.side,
    qty: orderPayload.qty,
    price: orderPayload.price,
    currency: orderPayload.currency,
  };

  const parsed = OrderRequestSchema.safeParse(normalizedOrder);
  markTime("parse_validate");

  // FAIL-CLOSED audit: catch errors, don't crash
  const safeAudit = async (traceId: string, eventType: string, payload: any): Promise<boolean> => {
    try {
      await audit(traceId, eventType, payload);
      return true;
    } catch (err) {
      console.error(`[FAIL-CLOSED] Audit unavailable for ${eventType}:`, (err as Error).message);
      return false;
    }
  };

  const auditOk = await safeAudit(traceId, "authorize.requested", { 
    raw: req.body, 
    valid: parsed.success,
    api_version: "v1"
  });
  markTime("audit_request");

  // FAIL-CLOSED: If audit is unavailable, return BLOCKED (not crash)
  if (!auditOk) {
    const latencyMs = Number(process.hrtime.bigint() - startTime) / 1e6;
    res.set("X-Decision-Latency-Ms", latencyMs.toFixed(3));
    // HTTP 200 per contract; status field indicates BLOCKED
    return res.status(200).json({ 
      trace_id: traceId, 
      status: "BLOCKED", 
      reason_code: "AUDIT_UNAVAILABLE",
      gate_note: "FAIL-CLOSED: Audit service unavailable. Decision blocked for integrity.",
      timing_ms: timing
    });
  }

  if (!parsed.success) {
    const latencyMs = Number(process.hrtime.bigint() - startTime) / 1e6;
    await safeAudit(traceId, "authorize.blocked", { 
      reason: "INVALID_ORDER_SCHEMA", 
      details: parsed.error.flatten() 
    });
    res.set("X-Decision-Latency-Ms", latencyMs.toFixed(3));
    return res.status(400).json({ 
      trace_id: traceId, 
      status: "BLOCKED", 
      reason_code: "INVALID_ORDER_SCHEMA",
      gate_note: "Schema validation failed. See error details.",
      timing_ms: timing
    });
  }

  const order = parsed.data;
  const decision = await decideRisk(order);
  markTime("policy_decision");

  await safeAudit(traceId, "authorize.risk_evaluated", decision);
  markTime("audit_risk");

  // P1: Compute snapshot economics
  const snapshotResult = computeSnapshotEconomics({
    qty: order.qty ?? 0,
    price: order.price,
    decision: decision.decision === "BLOCK" ? "BLOCK" : "ALLOW",
    decision_time: decisionTime,
    exposure_pre: null,
  });
  const projectedExposure = snapshotResult.economics.notional ?? 0;
  markTime("economics");

  // Issue Decision Token
  const tokenDecision = decision.decision === "BLOCK" ? "BLOCK" : "ALLOW";
  const token = issueDecisionToken({
    traceId,
    decision: tokenDecision,
    reasonCode: (decision as any).reasonCode ?? (tokenDecision === "ALLOW" ? "OK" : "POLICY_BLOCKED"),
    ruleId: (decision as any).ruleId,
    policyVersion: decision.policyVersion,
    order: {
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      price: order.price,
      clientOrderId: order.clientOrderId
    },
    subject: clientId,
    audience,
    projectedExposure
  });
  markTime("token_sign");

  const responseStatus = decision.decision === "BLOCK" ? "BLOCKED" : "AUTHORIZED";
  
  await safeAudit(traceId, `authorize.${responseStatus.toLowerCase()}`, { 
    decision: responseStatus,
    decisionToken: token.payload,
    decision_signature: getCompactSignature(token)
  });
  markTime("audit_decision");

  // Record economics (non-blocking)
  recordSnapshotEconomics(
    traceId, 
    tokenDecision === "BLOCK" ? "BLOCK" : "ALLOW", 
    snapshotResult.economics, 
    (decision as any).ruleId
  );

  await emitWebhook("trace.completed", traceId, { 
    status: responseStatus,
    api_version: "v1",
    decision_signature: getCompactSignature(token)
  });
  markTime("webhook");

  const latencyMs = Number(process.hrtime.bigint() - startTime) / 1e6;
  timing["total"] = latencyMs;
  res.set("X-Decision-Latency-Ms", latencyMs.toFixed(3));

  // HTTP 200 for all decisions per contract; status field indicates outcome
  return res.status(200).json({ 
    trace_id: traceId, 
    status: responseStatus,
    decision_token: token,
    decision_signature: getCompactSignature(token),
    reason_code: (decision as any).reasonCode,
    rule_ids: (decision as any).ruleId ? [(decision as any).ruleId] : [],
    policy_version: decision.policyVersion,
    advisory_routing_class: null, // P3: Deferred per PD-2
    gate_note: "Decision Token issued. Trading platform remains execution master.",
    timing_ms: timing
  });
});

// Alias: /v1/orders -> /v1/authorize (backward compat)
app.post("/v1/orders", async (req, res, next) => {
  // Rewrite to /v1/authorize
  req.url = "/v1/authorize";
  return app._router.handle(req, res, next);
});

// ============================================================================
// DRY-RUN: Policy evaluation without persistence (Policy Playground)
// ============================================================================
app.post("/dry-run", async (req, res) => {
  // Validate schema first
  const parsed = OrderRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      dryRun: true,
      decision: "BLOCK",
      reasonCode: "INVALID_ORDER_SCHEMA",
      policyVersion: "validation",
      validationErrors: parsed.error.flatten(),
      previewEconomics: null
    });
  }

  const order = parsed.data;
  
  // Query risk-gate's evaluate endpoint (no audit writes)
  try {
    const evalRes = await fetch(`${RISK_GATE_URL}/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(order)
    });
    
    if (!evalRes.ok) {
      return res.status(500).json({
        dryRun: true,
        decision: "BLOCK",
        reasonCode: "POLICY_ENGINE_UNAVAILABLE",
        policyVersion: "error"
      });
    }
    
    const evaluation = await evalRes.json() as any;
    
    // Calculate preview economics (no persistence)
    const attemptNotional = (order.qty ?? 0) * (order.price ?? 0);
    const previewEconomics = {
      attemptNotional,
      savedExposure: evaluation.decision === "BLOCK" ? attemptNotional : 0,
      simulationCost: 0,
      note: "Preview only — no ledger write"
    };
    
    return res.json({
      dryRun: true,
      decision: evaluation.decision,
      allow: evaluation.decision === "ALLOW",
      reasonCode: evaluation.reasonCode,
      ruleId: evaluation.ruleId ?? null,
      policyVersion: evaluation.policyVersion,
      order: {
        symbol: order.symbol,
        side: order.side,
        qty: order.qty,
        price: order.price
      },
      previewEconomics,
      evaluatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error("Dry-run evaluation error:", err);
    return res.status(500).json({
      dryRun: true,
      decision: "BLOCK",
      reasonCode: "EVALUATION_ERROR",
      policyVersion: "error"
    });
  }
});

// ============================================================================
// READ MODEL ENDPOINTS (PH1-W1-002)
// ============================================================================

// Query params validation schemas
const OrdersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.string().optional(),
  symbol: z.string().optional(),
  lp_id: z.string().optional()
}).partial();

const LpHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional()
}).partial();

// Response envelope helper
type ApiError = string | { code: string; message: string; details?: unknown };

function apiResponse<T>(success: boolean, data?: T, meta?: Record<string, any>, error?: ApiError) {
  if (success) {
    return { success: true, data, meta };
  }
  // Normalize error format
  if (typeof error === 'string') {
    return { success: false, error: { code: 'ERROR', message: error } };
  }
  return { success: false, error };
}

// GET /api/orders - List orders with optional filters
app.get("/api/orders", async (req, res) => {
  try {
    const parsed = OrdersQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json(apiResponse(false, undefined, undefined, "Invalid query parameters"));
    }
    
    const { limit = 50, offset = 0, status, symbol, lp_id } = parsed.data;
    
    let query = `
      SELECT id, client_order_id, lp_order_id, symbol, side, order_type, qty, price,
             fill_qty, avg_fill_price, remaining_qty, status, lp_id, server_id, server_name,
             rejection_reason_code, rejection_reason_class, decision_token_id,
             submitted_at, accepted_at, filled_at, rejected_at, canceled_at, created_at, updated_at
      FROM orders
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;
    
    if (status) {
      query += ` AND status = $${paramIndex++}`;
      params.push(status);
    }
    if (symbol) {
      query += ` AND symbol = $${paramIndex++}`;
      params.push(symbol);
    }
    if (lp_id) {
      query += ` AND lp_id = $${paramIndex++}`;
      params.push(lp_id);
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(limit, offset);
    
    const result = await pool.query(query, params);
    
    // Get total count for pagination
    let countQuery = `SELECT COUNT(*) FROM orders WHERE 1=1`;
    const countParams: any[] = [];
    let countParamIndex = 1;
    if (status) {
      countQuery += ` AND status = $${countParamIndex++}`;
      countParams.push(status);
    }
    if (symbol) {
      countQuery += ` AND symbol = $${countParamIndex++}`;
      countParams.push(symbol);
    }
    if (lp_id) {
      countQuery += ` AND lp_id = $${countParamIndex++}`;
      countParams.push(lp_id);
    }
    const countResult = await pool.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].count);
    
    return res.json(apiResponse(true, result.rows, {
      total,
      limit,
      offset,
      has_more: offset + result.rows.length < total
    }));
  } catch (err) {
    console.error("GET /api/orders error:", err);
    return res.status(500).json(apiResponse(false, undefined, undefined, "Internal server error"));
  }
});

// GET /api/orders/:id - Get single order by ID (trace_id)
app.get("/api/orders/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(`
      SELECT id, client_order_id, lp_order_id, symbol, side, order_type, qty, price,
             fill_qty, avg_fill_price, remaining_qty, status, lp_id, server_id, server_name,
             rejection_reason_code, rejection_reason_class, rejection_raw_message, decision_token_id,
             submitted_at, accepted_at, filled_at, rejected_at, canceled_at, created_at, updated_at
      FROM orders WHERE id = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json(apiResponse(false, undefined, undefined, "Order not found"));
    }
    
    return res.json(apiResponse(true, result.rows[0]));
  } catch (err) {
    console.error("GET /api/orders/:id error:", err);
    return res.status(500).json(apiResponse(false, undefined, undefined, "Internal server error"));
  }
});

// GET /api/orders/:id/lifecycle - Get lifecycle events for an order
app.get("/api/orders/:id/lifecycle", async (req, res) => {
  try {
    const { id } = req.params;
    
    // First check if order exists
    const orderCheck = await pool.query("SELECT id FROM orders WHERE id = $1", [id]);
    if (orderCheck.rows.length === 0) {
      return res.status(404).json(apiResponse(false, undefined, undefined, "Order not found"));
    }
    
    const result = await pool.query(`
      SELECT id, order_id, event_id, event_type, status, qty, price, fill_qty, fill_price,
             remaining_qty, reason_code, reason_class, reason_message, payload_hash,
             prev_event_hash, occurred_at, ingested_at
      FROM order_lifecycle_events
      WHERE order_id = $1
      ORDER BY occurred_at ASC
    `, [id]);
    
    return res.json(apiResponse(true, result.rows, {
      order_id: id,
      event_count: result.rows.length
    }));
  } catch (err) {
    console.error("GET /api/orders/:id/lifecycle error:", err);
    return res.status(500).json(apiResponse(false, undefined, undefined, "Internal server error"));
  }
});

// GET /api/lp-accounts - List all LP accounts
app.get("/api/lp-accounts", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, server_id, server_name, balance, equity, margin, free_margin,
             margin_level, status, last_heartbeat_at, currency, created_at, updated_at
      FROM lp_accounts
      ORDER BY name ASC
    `);
    
    return res.json(apiResponse(true, result.rows, {
      count: result.rows.length
    }));
  } catch (err) {
    console.error("GET /api/lp-accounts error:", err);
    return res.status(500).json(apiResponse(false, undefined, undefined, "Internal server error"));
  }
});

// GET /api/lp-accounts/:id - Get single LP account
app.get("/api/lp-accounts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(`
      SELECT id, name, server_id, server_name, balance, equity, margin, free_margin,
             margin_level, status, last_heartbeat_at, currency, created_at, updated_at
      FROM lp_accounts WHERE id = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json(apiResponse(false, undefined, undefined, "LP account not found"));
    }
    
    return res.json(apiResponse(true, result.rows[0]));
  } catch (err) {
    console.error("GET /api/lp-accounts/:id error:", err);
    return res.status(500).json(apiResponse(false, undefined, undefined, "Internal server error"));
  }
});

// GET /api/lp-accounts/:id/history - Get LP account history (snapshots)
app.get("/api/lp-accounts/:id/history", async (req, res) => {
  try {
    const { id } = req.params;
    
    const parsed = LpHistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json(apiResponse(false, undefined, undefined, "Invalid query parameters"));
    }
    
    const { limit = 100, from, to } = parsed.data;
    
    // Check if LP exists
    const lpCheck = await pool.query("SELECT id FROM lp_accounts WHERE id = $1", [id]);
    if (lpCheck.rows.length === 0) {
      return res.status(404).json(apiResponse(false, undefined, undefined, "LP account not found"));
    }
    
    let query = `
      SELECT id, lp_id, balance, equity, margin, free_margin, margin_level,
             source_event_id, source_trace_id, snapshot_at, created_at
      FROM lp_snapshots
      WHERE lp_id = $1
    `;
    const params: any[] = [id];
    let paramIndex = 2;
    
    if (from) {
      query += ` AND snapshot_at >= $${paramIndex++}`;
      params.push(from);
    }
    if (to) {
      query += ` AND snapshot_at <= $${paramIndex++}`;
      params.push(to);
    }
    
    query += ` ORDER BY snapshot_at DESC LIMIT $${paramIndex++}`;
    params.push(limit);
    
    const result = await pool.query(query, params);
    
    return res.json(apiResponse(true, result.rows, {
      lp_id: id,
      count: result.rows.length,
      limit
    }));
  } catch (err) {
    console.error("GET /api/lp-accounts/:id/history error:", err);
    return res.status(500).json(apiResponse(false, undefined, undefined, "Internal server error"));
  }
});

// GET /api/rejections - List rejections with optional rollups and time window
app.get("/api/rejections", async (req, res) => {
  try {
    const rollupBy = req.query.rollup as string | undefined;
    const windowStr = req.query.window as string | undefined;
    
    // Parse time window (e.g., "1h", "30m", "24h", "7d")
    let windowClause = '';
    let windowParams: any[] = [];
    if (windowStr) {
      const match = windowStr.match(/^(\d+)(s|m|h|d)$/);
      if (match) {
        const value = parseInt(match[1], 10);
        const unit = match[2];
        const intervalMap: Record<string, string> = {
          's': 'seconds',
          'm': 'minutes',
          'h': 'hours',
          'd': 'days'
        };
        const interval = `${value} ${intervalMap[unit]}`;
        windowClause = `WHERE rejected_at >= NOW() - INTERVAL '${interval}'`;
      }
    }
    
    if (rollupBy === 'reason') {
      const result = await pool.query(`
        SELECT reason_code, reason_class, COUNT(*) as count
        FROM rejections
        ${windowClause}
        GROUP BY reason_code, reason_class
        ORDER BY count DESC
      `);
      return res.json(apiResponse(true, result.rows, { rollup: 'reason', window: windowStr || 'all' }));
    }
    
    if (rollupBy === 'lp') {
      const result = await pool.query(`
        SELECT lp_id, server_id, COUNT(*) as count
        FROM rejections
        ${windowClause}
        GROUP BY lp_id, server_id
        ORDER BY count DESC
      `);
      return res.json(apiResponse(true, result.rows, { rollup: 'lp', window: windowStr || 'all' }));
    }
    
    if (rollupBy === 'symbol') {
      const result = await pool.query(`
        SELECT symbol, COUNT(*) as count
        FROM rejections
        ${windowClause}
        GROUP BY symbol
        ORDER BY count DESC
      `);
      return res.json(apiResponse(true, result.rows, { rollup: 'symbol', window: windowStr || 'all' }));
    }
    
    // Default: list recent rejections
    const result = await pool.query(`
      SELECT id, order_id, event_id, lp_id, server_id, server_name, symbol,
             raw_code, raw_message, reason_code, reason_class, reason_message,
             normalization_confidence, rejected_at, created_at
      FROM rejections
      ${windowClause ? windowClause : ''}
      ORDER BY rejected_at DESC
      LIMIT 100
    `);
    
    return res.json(apiResponse(true, result.rows, { count: result.rows.length, window: windowStr || 'all' }));
  } catch (err) {
    console.error("GET /api/rejections error:", err);
    return res.status(500).json(apiResponse(false, undefined, undefined, "Internal server error"));
  }
});

// ============================================================================
// Alert APIs
// ============================================================================

// GET /api/alerts - List alerts with filters
app.get("/api/alerts", async (req, res) => {
  try {
    const status = req.query.status as string | undefined;
    const category = req.query.category as string | undefined;
    const severity = req.query.severity as string | undefined;
    const lpId = req.query.lp_id as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string || '50', 10), 100);
    
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;
    
    if (status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(status.toUpperCase());
    }
    if (category) {
      conditions.push(`category = $${paramIdx++}`);
      params.push(category.toUpperCase());
    }
    if (severity) {
      conditions.push(`severity = $${paramIdx++}`);
      params.push(severity.toUpperCase());
    }
    if (lpId) {
      conditions.push(`lp_id = $${paramIdx++}`);
      params.push(lpId);
    }
    
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    
    const result = await pool.query(`
      SELECT id, alert_id, setting_id, severity, category, lp_id, symbol, server_id,
             title, message, trigger_value, threshold_value, status,
             triggered_at, acknowledged_at, resolved_at, expires_at, metadata, created_at
      FROM alerts
      ${whereClause}
      ORDER BY triggered_at DESC
      LIMIT $${paramIdx}
    `, [...params, limit]);
    
    // Get counts by status
    const countResult = await pool.query(`
      SELECT status, COUNT(*) as count FROM alerts GROUP BY status
    `);
    const statusCounts = Object.fromEntries(
      countResult.rows.map(r => [r.status, parseInt(r.count, 10)])
    );
    
    return res.json(apiResponse(true, result.rows, { 
      count: result.rows.length,
      status_counts: statusCounts
    }));
  } catch (err) {
    console.error("GET /api/alerts error:", err);
    return res.status(500).json(apiResponse(false, undefined, undefined, "Internal server error"));
  }
});

// GET /api/alerts/:alertId - Get single alert
app.get("/api/alerts/:alertId", async (req, res) => {
  try {
    const alertId = req.params.alertId;
    
    const result = await pool.query(`
      SELECT id, alert_id, setting_id, severity, category, lp_id, symbol, server_id,
             title, message, trigger_value, threshold_value, status,
             triggered_at, acknowledged_at, resolved_at, expires_at, metadata, created_at
      FROM alerts WHERE alert_id = $1
    `, [alertId]);
    
    if (result.rowCount === 0) {
      return res.status(404).json(apiResponse(false, undefined, undefined, "Alert not found"));
    }
    
    // Get acknowledgment history
    const acks = await pool.query(`
      SELECT id, action, actor_id, actor_name, actor_type, comment, snooze_until, created_at
      FROM alert_acks WHERE alert_id = $1 ORDER BY created_at DESC
    `, [alertId]);
    
    return res.json(apiResponse(true, { ...result.rows[0], acknowledgments: acks.rows }));
  } catch (err) {
    console.error("GET /api/alerts/:alertId error:", err);
    return res.status(500).json(apiResponse(false, undefined, undefined, "Internal server error"));
  }
});

// POST /api/alerts/:alertId/ack - Acknowledge alert
app.post("/api/alerts/:alertId/ack", async (req, res) => {
  try {
    const alertId = req.params.alertId;
    const { action, actor_id, actor_name, comment, snooze_until } = req.body || {};
    
    const validActions = ['ACK', 'RESOLVE', 'SNOOZE', 'ESCALATE'];
    const ackAction = (action || 'ACK').toUpperCase();
    
    if (!validActions.includes(ackAction)) {
      return res.status(400).json(apiResponse(false, undefined, undefined, `Invalid action. Must be one of: ${validActions.join(', ')}`));
    }
    
    // Check alert exists
    const alertCheck = await pool.query('SELECT status FROM alerts WHERE alert_id = $1', [alertId]);
    if (alertCheck.rowCount === 0) {
      return res.status(404).json(apiResponse(false, undefined, undefined, "Alert not found"));
    }
    
    // Insert acknowledgment record
    await pool.query(`
      INSERT INTO alert_acks (alert_id, action, actor_id, actor_name, actor_type, comment, snooze_until)
      VALUES ($1, $2, $3, $4, 'USER', $5, $6)
    `, [alertId, ackAction, actor_id || 'system', actor_name || 'System', comment || null, snooze_until || null]);
    
    // Update alert status
    let newStatus = 'OPEN';
    if (ackAction === 'ACK') newStatus = 'ACKNOWLEDGED';
    else if (ackAction === 'RESOLVE') newStatus = 'RESOLVED';
    
    const updateFields: string[] = ['status = $2'];
    const updateParams: any[] = [alertId, newStatus];
    let paramIdx = 3;
    
    if (ackAction === 'ACK') {
      updateFields.push(`acknowledged_at = NOW()`);
    } else if (ackAction === 'RESOLVE') {
      updateFields.push(`resolved_at = NOW()`);
    }
    
    await pool.query(`UPDATE alerts SET ${updateFields.join(', ')} WHERE alert_id = $1`, updateParams);
    
    return res.json(apiResponse(true, { alert_id: alertId, action: ackAction, new_status: newStatus }));
  } catch (err) {
    console.error("POST /api/alerts/:alertId/ack error:", err);
    return res.status(500).json(apiResponse(false, undefined, undefined, "Internal server error"));
  }
});

// GET /api/alert-settings - List alert settings
app.get("/api/alert-settings", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, category, threshold_value, threshold_unit, comparison, 
             cooldown_seconds, applies_to, enabled, description, created_at, updated_at
      FROM alert_settings ORDER BY category, id
    `);
    
    return res.json(apiResponse(true, result.rows));
  } catch (err) {
    console.error("GET /api/alert-settings error:", err);
    return res.status(500).json(apiResponse(false, undefined, undefined, "Internal server error"));
  }
});

// PUT /api/alert-settings/:id - Update alert setting
app.put("/api/alert-settings/:id", async (req, res) => {
  try {
    const settingId = req.params.id;
    const { threshold_value, cooldown_seconds, enabled } = req.body || {};
    
    const updates: string[] = [];
    const params: any[] = [settingId];
    let paramIdx = 2;
    
    if (threshold_value !== undefined) {
      updates.push(`threshold_value = $${paramIdx++}`);
      params.push(threshold_value);
    }
    if (cooldown_seconds !== undefined) {
      updates.push(`cooldown_seconds = $${paramIdx++}`);
      params.push(cooldown_seconds);
    }
    if (enabled !== undefined) {
      updates.push(`enabled = $${paramIdx++}`);
      params.push(enabled);
    }
    
    if (updates.length === 0) {
      return res.status(400).json(apiResponse(false, undefined, undefined, "No valid fields to update"));
    }
    
    updates.push('updated_at = NOW()');
    
    const result = await pool.query(`
      UPDATE alert_settings SET ${updates.join(', ')} WHERE id = $1 RETURNING *
    `, params);
    
    if (result.rowCount === 0) {
      return res.status(404).json(apiResponse(false, undefined, undefined, "Alert setting not found"));
    }
    
    return res.json(apiResponse(true, result.rows[0]));
  } catch (err) {
    console.error("PUT /api/alert-settings/:id error:", err);
    return res.status(500).json(apiResponse(false, undefined, undefined, "Internal server error"));
  }
});

// ============================================================================
// Dashboard KPI Endpoints
// ============================================================================

// GET /api/dashboard/kpis - Get dashboard KPIs
app.get("/api/dashboard/kpis", async (req, res) => {
  try {
    const window = req.query.window as string || '1h';
    
    // Parse window
    let intervalStr = '1 hour';
    const match = window.match(/^(\d+)(m|h|d)$/);
    if (match) {
      const value = parseInt(match[1], 10);
      const unit = match[2] === 'm' ? 'minutes' : match[2] === 'h' ? 'hours' : 'days';
      intervalStr = `${value} ${unit}`;
    }
    
    // Orders KPIs
    const ordersResult = await pool.query(`
      SELECT 
        COUNT(*) as total_orders,
        COUNT(*) FILTER (WHERE status = 'FILLED') as filled_orders,
        COUNT(*) FILTER (WHERE status = 'REJECTED') as rejected_orders,
        COUNT(*) FILTER (WHERE status = 'SUBMITTED') as pending_orders,
        COUNT(*) FILTER (WHERE status = 'PARTIALLY_FILLED') as partial_orders
      FROM orders
      WHERE created_at >= NOW() - INTERVAL '${intervalStr}'
    `);
    
    // Rejections KPIs
    const rejectionsResult = await pool.query(`
      SELECT 
        COUNT(*) as total_rejections,
        COUNT(DISTINCT reason_code) as unique_reason_codes,
        COUNT(DISTINCT symbol) as affected_symbols
      FROM rejections
      WHERE rejected_at >= NOW() - INTERVAL '${intervalStr}'
    `);
    
    // Top rejection reasons
    const topReasonsResult = await pool.query(`
      SELECT reason_code, reason_class, COUNT(*) as count
      FROM rejections
      WHERE rejected_at >= NOW() - INTERVAL '${intervalStr}'
      GROUP BY reason_code, reason_class
      ORDER BY count DESC
      LIMIT 5
    `);
    
    // LP Health KPIs
    const lpResult = await pool.query(`
      SELECT 
        COUNT(*) as total_lps,
        COUNT(*) FILTER (WHERE status = 'CONNECTED') as connected_lps,
        AVG(margin_level) as avg_margin_level,
        MIN(margin_level) as min_margin_level,
        SUM(balance) as total_balance,
        SUM(equity) as total_equity
      FROM lp_accounts
    `);
    
    // Alert KPIs
    const alertsResult = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'OPEN') as open_alerts,
        COUNT(*) FILTER (WHERE status = 'OPEN' AND severity = 'CRITICAL') as critical_alerts,
        COUNT(*) FILTER (WHERE status = 'OPEN' AND severity = 'WARNING') as warning_alerts,
        COUNT(*) FILTER (WHERE status = 'ACKNOWLEDGED') as acknowledged_alerts,
        COUNT(*) FILTER (WHERE triggered_at >= NOW() - INTERVAL '${intervalStr}') as alerts_in_window
      FROM alerts
    `);
    
    const orders = ordersResult.rows[0];
    const rejections = rejectionsResult.rows[0];
    const lp = lpResult.rows[0];
    const alerts = alertsResult.rows[0];
    
    // Calculate rejection rate
    const totalOrders = parseInt(orders.total_orders, 10) || 0;
    const rejectedOrders = parseInt(orders.rejected_orders, 10) || 0;
    const rejectionRate = totalOrders > 0 ? (rejectedOrders / totalOrders * 100).toFixed(2) : '0.00';
    
    const kpis = {
      orders: {
        total: parseInt(orders.total_orders, 10),
        filled: parseInt(orders.filled_orders, 10),
        rejected: parseInt(orders.rejected_orders, 10),
        pending: parseInt(orders.pending_orders, 10),
        partial: parseInt(orders.partial_orders, 10),
        rejection_rate_pct: parseFloat(rejectionRate)
      },
      rejections: {
        total: parseInt(rejections.total_rejections, 10),
        unique_reasons: parseInt(rejections.unique_reason_codes, 10),
        affected_symbols: parseInt(rejections.affected_symbols, 10),
        top_reasons: topReasonsResult.rows.map(r => ({
          reason_code: r.reason_code,
          reason_class: r.reason_class,
          count: parseInt(r.count, 10)
        }))
      },
      lp_health: {
        total_lps: parseInt(lp.total_lps, 10),
        connected_lps: parseInt(lp.connected_lps, 10),
        avg_margin_level: lp.avg_margin_level ? parseFloat(lp.avg_margin_level).toFixed(2) : null,
        min_margin_level: lp.min_margin_level ? parseFloat(lp.min_margin_level).toFixed(2) : null,
        total_balance: lp.total_balance ? parseFloat(lp.total_balance).toFixed(2) : '0.00',
        total_equity: lp.total_equity ? parseFloat(lp.total_equity).toFixed(2) : '0.00'
      },
      alerts: {
        open: parseInt(alerts.open_alerts, 10),
        critical: parseInt(alerts.critical_alerts, 10),
        warning: parseInt(alerts.warning_alerts, 10),
        acknowledged: parseInt(alerts.acknowledged_alerts, 10),
        in_window: parseInt(alerts.alerts_in_window, 10)
      }
    };
    
    return res.json(apiResponse(true, kpis, { window, interval: intervalStr }));
  } catch (err) {
    console.error("GET /api/dashboard/kpis error:", err);
    return res.status(500).json(apiResponse(false, undefined, undefined, "Internal server error"));
  }
});

// GET /api/dashboard/timeline - Get order/rejection timeline
app.get("/api/dashboard/timeline", async (req, res) => {
  try {
    const window = req.query.window as string || '1h';
    const bucketMinutes = parseInt(req.query.bucket as string || '5', 10);
    
    let intervalStr = '1 hour';
    const match = window.match(/^(\d+)(m|h|d)$/);
    if (match) {
      const value = parseInt(match[1], 10);
      const unit = match[2] === 'm' ? 'minutes' : match[2] === 'h' ? 'hours' : 'days';
      intervalStr = `${value} ${unit}`;
    }
    
    // Orders timeline
    const ordersTimeline = await pool.query(`
      SELECT 
        date_trunc('minute', created_at) - (EXTRACT(MINUTE FROM created_at)::int % $1) * INTERVAL '1 minute' as bucket,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'FILLED') as filled,
        COUNT(*) FILTER (WHERE status = 'REJECTED') as rejected
      FROM orders
      WHERE created_at >= NOW() - INTERVAL '${intervalStr}'
      GROUP BY bucket
      ORDER BY bucket
    `, [bucketMinutes]);
    
    return res.json(apiResponse(true, ordersTimeline.rows, { window, bucket_minutes: bucketMinutes }));
  } catch (err) {
    console.error("GET /api/dashboard/timeline error:", err);
    return res.status(500).json(apiResponse(false, undefined, undefined, "Internal server error"));
  }
});

// ============================================================================
// Demo Trigger Proxy (Week 4)
// UI calls order-api, which proxies to lp-simulator internally
// ============================================================================

const LP_SIMULATOR_URL = process.env.LP_SIMULATOR_URL ?? "http://lp-simulator:7010";

// Map scenario IDs to simulator endpoints and default payloads
const DEMO_SCENARIOS: Record<string, { endpoint: string; defaultPayload?: Record<string, unknown> }> = {
  "margin-warning": {
    endpoint: "/simulate/margin-warning",
    defaultPayload: { lp_id: "LP-A", margin_level: 45 }
  },
  "rejection-spike": {
    endpoint: "/simulate/rejection-spike",
    defaultPayload: { count: 5, symbol: "EURUSD" }
  },
  "recovery": {
    endpoint: "/simulate/recovery",
    defaultPayload: {}
  },
  "full-fill": {
    endpoint: "/simulate/full-fill",
    defaultPayload: { 
      trace_id: `demo-${Date.now()}`,
      order: { symbol: "EURUSD", side: "BUY", qty: 100000, price: 1.085 }
    }
  },
  "rejection": {
    endpoint: "/simulate/rejection",
    defaultPayload: {
      trace_id: `demo-${Date.now()}`,
      order: { symbol: "EURUSD", side: "BUY", qty: 100000, price: 1.085 },
      reason: { code: "MARGIN_001", message: "Insufficient margin" }
    }
  }
};

// GET /api/demo/scenarios - List available demo scenarios
app.get("/api/demo/scenarios", (_, res) => {
  const scenarios = Object.entries(DEMO_SCENARIOS).map(([id, config]) => ({
    id,
    endpoint: `POST /api/demo/trigger/${id}`,
    description: getScenarioDescription(id),
    default_payload: config.defaultPayload
  }));
  
  return res.json(apiResponse(true, scenarios));
});

function getScenarioDescription(id: string): string {
  switch (id) {
    case "margin-warning": return "Emit low margin snapshot to trigger MARGIN_* alert";
    case "rejection-spike": return "Emit multiple rejections to trigger REJECT_SPIKE alert";
    case "recovery": return "Restore all LP accounts to healthy margin levels";
    case "full-fill": return "Submit → Accept → Fill (happy path)";
    case "rejection": return "Submit → Reject with custom reason";
    default: return "Unknown scenario";
  }
}

// POST /api/demo/trigger/:scenario_id - Trigger a demo scenario
app.post("/api/demo/trigger/:scenario_id", async (req, res) => {
  const { scenario_id } = req.params;
  
  const scenario = DEMO_SCENARIOS[scenario_id];
  if (!scenario) {
    return res.status(404).json(apiResponse(false, undefined, undefined, {
      code: "SCENARIO_NOT_FOUND",
      message: `Unknown scenario: ${scenario_id}`,
      details: { available: Object.keys(DEMO_SCENARIOS) }
    }));
  }
  
  // Merge default payload with request body
  const payload = { ...scenario.defaultPayload, ...req.body };
  
  // For scenarios that need a unique trace_id
  if (payload.trace_id && payload.trace_id.startsWith("demo-")) {
    payload.trace_id = `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  
  try {
    const simulatorUrl = `${LP_SIMULATOR_URL}${scenario.endpoint}`;
    console.log(`[Demo] Triggering ${scenario_id} via ${simulatorUrl}`);
    
    const response = await fetch(simulatorUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Demo] Simulator error: ${response.status} - ${errorText}`);
      return res.status(502).json(apiResponse(false, undefined, undefined, {
        code: "SIMULATOR_ERROR",
        message: `LP Simulator returned ${response.status}`,
        details: { body: errorText }
      }));
    }
    
    const result = await response.json();
    
    return res.json(apiResponse(true, result, { 
      scenario_id, 
      triggered_at: new Date().toISOString() 
    }));
  } catch (err) {
    console.error(`[Demo] Trigger error for ${scenario_id}:`, err);
    return res.status(500).json(apiResponse(false, undefined, undefined, {
      code: "TRIGGER_FAILED",
      message: err instanceof Error ? err.message : String(err),
      details: { scenario_id }
    }));
  }
});

// =============================================================================
// Export Endpoints (Week 5 - Evidence Pack / Dispute Pack)
// =============================================================================

/**
 * Helper: Compute SHA-256 hash of JSON data
 */
function sha256(data: any): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

/**
 * GET /api/export/evidence-pack - System-wide evidence bundle
 * Returns current system state snapshot for demo/audit purposes
 */
app.get("/api/export/evidence-pack", async (req, res) => {
  try {
    const timestamp = new Date().toISOString();
    
    // Gather system state
    const [
      ordersResult,
      alertsResult,
      lpAccountsResult,
      lpSnapshotsResult,
      auditEventsResult,
      alertSettingsResult
    ] = await Promise.all([
      pool.query(`
        SELECT id, symbol, side, qty, status, lp_id, rejection_reason_code, created_at
        FROM orders ORDER BY created_at DESC LIMIT 50
      `),
      pool.query(`
        SELECT alert_id, category, severity, status, lp_id, trigger_value, threshold_value, created_at
        FROM alerts ORDER BY created_at DESC LIMIT 50
      `),
      pool.query(`
        SELECT id, name, status, margin_level, equity, balance
        FROM lp_accounts ORDER BY name
      `),
      pool.query(`
        SELECT lp_id, margin_level, equity, balance, snapshot_at
        FROM lp_snapshots ORDER BY snapshot_at DESC LIMIT 20
      `),
      pool.query("SELECT COUNT(*) as count FROM audit_events"),
      pool.query("SELECT id, category, threshold_value, enabled FROM alert_settings")
    ]);
    
    // Build evidence bundle
    const bundle = {
      orders: ordersResult.rows,
      alerts: alertsResult.rows,
      lp_accounts: lpAccountsResult.rows,
      lp_snapshots: lpSnapshotsResult.rows,
      alert_settings: alertSettingsResult.rows,
      audit_event_count: parseInt(auditEventsResult.rows[0]?.count ?? "0", 10)
    };
    
    // Compute checksums for each component
    const checksums = {
      orders: sha256(bundle.orders),
      alerts: sha256(bundle.alerts),
      lp_accounts: sha256(bundle.lp_accounts),
      lp_snapshots: sha256(bundle.lp_snapshots),
      alert_settings: sha256(bundle.alert_settings),
      bundle: ""  // Computed below
    };
    checksums.bundle = sha256(checksums);
    
    const pack = {
      type: "evidence-pack",
      version: "1.0.0",
      generated_at: timestamp,
      generator: BUILD_INFO,
      summary: {
        orders_count: bundle.orders.length,
        alerts_count: bundle.alerts.length,
        lp_accounts_count: bundle.lp_accounts.length,
        lp_snapshots_count: bundle.lp_snapshots.length,
        audit_events_count: bundle.audit_event_count
      },
      bundle,
      checksums
    };
    
    return res.json(apiResponse(true, pack, {
      checksum: checksums.bundle.substring(0, 16)
    }));
  } catch (err) {
    console.error("GET /api/export/evidence-pack error:", err);
    return res.status(500).json(apiResponse(false, undefined, undefined, "Internal server error"));
  }
});

/**
 * GET /api/export/bundle - Alias for evidence-pack (for script compatibility)
 */
app.get("/api/export/bundle", async (req, res) => {
  // Redirect internally to evidence-pack
  req.url = "/api/export/evidence-pack";
  return app._router.handle(req, res, () => {});
});

/**
 * GET /api/orders/:id/evidence-pack - Order-specific evidence pack
 * Returns complete audit trail for a specific order
 */
app.get("/api/orders/:id/evidence-pack", async (req, res) => {
  try {
    const { id } = req.params;
    const timestamp = new Date().toISOString();
    
    // Get order
    const orderResult = await pool.query(`
      SELECT id, client_order_id, lp_order_id, symbol, side, order_type, qty, price,
             fill_qty, avg_fill_price, remaining_qty, status, lp_id, server_id, server_name,
             rejection_reason_code, rejection_reason_class, rejection_raw_message, decision_token_id,
             submitted_at, accepted_at, filled_at, rejected_at, canceled_at, created_at, updated_at
      FROM orders WHERE id = $1
    `, [id]);
    
    if (orderResult.rows.length === 0) {
      return res.status(404).json(apiResponse(false, undefined, undefined, {
        code: "ORDER_NOT_FOUND",
        message: `Order ${id} not found`
      }));
    }
    
    const order = orderResult.rows[0];
    
    // Get lifecycle events
    const lifecycleResult = await pool.query(`
      SELECT id, order_id, event_id, event_type, status, qty, price, fill_qty, fill_price,
             remaining_qty, reason_code, reason_class, reason_message, payload_hash,
             prev_event_hash, occurred_at, ingested_at
      FROM order_lifecycle_events
      WHERE order_id = $1
      ORDER BY occurred_at ASC
    `, [id]);
    
    // Get related audit events (if trace_id matches order id pattern)
    const auditResult = await pool.query(`
      SELECT seq, event_type, event_version, payload, prev_hash, hash, written_at
      FROM audit_events
      WHERE payload::text LIKE $1
      ORDER BY seq ASC
      LIMIT 100
    `, [`%${id}%`]);
    
    // Get related alerts
    const alertsResult = await pool.query(`
      SELECT alert_id, category, severity, status, trigger_value, threshold_value, 
             message, created_at, acknowledged_at
      FROM alerts
      WHERE lp_id = $1 OR message LIKE $2
      ORDER BY created_at DESC
      LIMIT 10
    `, [order.lp_id, `%${id}%`]);
    
    // Build evidence pack
    const components = {
      order,
      lifecycle_events: lifecycleResult.rows,
      audit_events: auditResult.rows,
      related_alerts: alertsResult.rows
    };
    
    const checksums = {
      order: sha256(components.order),
      lifecycle_events: sha256(components.lifecycle_events),
      audit_events: sha256(components.audit_events),
      related_alerts: sha256(components.related_alerts),
      pack: ""
    };
    checksums.pack = sha256(checksums);
    
    const pack = {
      type: "order-evidence-pack",
      version: "1.0.0",
      order_id: id,
      generated_at: timestamp,
      generator: BUILD_INFO,
      summary: {
        order_status: order.status,
        lifecycle_event_count: lifecycleResult.rows.length,
        audit_event_count: auditResult.rows.length,
        related_alert_count: alertsResult.rows.length
      },
      components,
      checksums
    };
    
    return res.json(apiResponse(true, pack, {
      checksum: checksums.pack.substring(0, 16)
    }));
  } catch (err) {
    console.error("GET /api/orders/:id/evidence-pack error:", err);
    return res.status(500).json(apiResponse(false, undefined, undefined, "Internal server error"));
  }
});

/**
 * GET /api/orders/:id/dispute-pack - Dispute bundle for an order
 * Returns order + lifecycle + rejection details + related alerts
 * Optimized for dispute resolution and regulatory inquiries
 */
app.get("/api/orders/:id/dispute-pack", async (req, res) => {
  try {
    const { id } = req.params;
    const timestamp = new Date().toISOString();
    
    // Get order with full details
    const orderResult = await pool.query(`
      SELECT id, client_order_id, lp_order_id, symbol, side, order_type, qty, price,
             fill_qty, avg_fill_price, remaining_qty, status, lp_id, server_id, server_name,
             rejection_reason_code, rejection_reason_class, rejection_raw_message, decision_token_id,
             submitted_at, accepted_at, filled_at, rejected_at, canceled_at, created_at, updated_at
      FROM orders WHERE id = $1
    `, [id]);
    
    if (orderResult.rows.length === 0) {
      return res.status(404).json(apiResponse(false, undefined, undefined, {
        code: "ORDER_NOT_FOUND",
        message: `Order ${id} not found`
      }));
    }
    
    const order = orderResult.rows[0];
    
    // Get lifecycle events
    const lifecycleResult = await pool.query(`
      SELECT event_type, status, qty, price, fill_qty, fill_price, remaining_qty,
             reason_code, reason_class, reason_message, occurred_at
      FROM order_lifecycle_events
      WHERE order_id = $1
      ORDER BY occurred_at ASC
    `, [id]);
    
    // Build rejection details if applicable
    let rejection = null;
    if (order.status === 'REJECTED' || order.rejection_reason_code) {
      rejection = {
        reason_code: order.rejection_reason_code,
        reason_class: order.rejection_reason_class,
        raw_message: order.rejection_raw_message,
        rejected_at: order.rejected_at,
        rejection_event: lifecycleResult.rows.find((e: any) => e.event_type === 'REJECTED')
      };
    }
    
    // Get related alerts for this LP around the order time
    const alertsResult = await pool.query(`
      SELECT alert_id, category, severity, status, trigger_value, threshold_value,
             message, created_at, acknowledged_at, acknowledged_by
      FROM alerts
      WHERE lp_id = $1 
        AND created_at BETWEEN $2::timestamp - interval '1 hour' AND $2::timestamp + interval '1 hour'
      ORDER BY created_at DESC
      LIMIT 10
    `, [order.lp_id, order.created_at]);
    
    // Get LP snapshot at time of order (if available)
    const lpSnapshotResult = await pool.query(`
      SELECT margin_level, equity, balance, snapshot_at
      FROM lp_snapshots
      WHERE lp_id = $1 AND snapshot_at <= $2
      ORDER BY snapshot_at DESC
      LIMIT 1
    `, [order.lp_id, order.created_at]);
    
    // Build dispute pack
    const disputePack = {
      order: {
        id: order.id,
        client_order_id: order.client_order_id,
        symbol: order.symbol,
        side: order.side,
        order_type: order.order_type,
        qty: order.qty,
        price: order.price,
        status: order.status,
        lp_id: order.lp_id,
        server_name: order.server_name,
        decision_token_id: order.decision_token_id,
        submitted_at: order.submitted_at,
        created_at: order.created_at
      },
      lifecycle: lifecycleResult.rows,
      rejection,
      alerts: alertsResult.rows,
      lp_context: lpSnapshotResult.rows[0] || null
    };
    
    const checksums = {
      order: sha256(disputePack.order),
      lifecycle: sha256(disputePack.lifecycle),
      rejection: sha256(disputePack.rejection),
      alerts: sha256(disputePack.alerts),
      lp_context: sha256(disputePack.lp_context),
      pack: ""
    };
    checksums.pack = sha256(checksums);
    
    const pack = {
      type: "dispute-pack",
      version: "1.0.0",
      order_id: id,
      generated_at: timestamp,
      generator: BUILD_INFO,
      summary: {
        order_status: order.status,
        has_rejection: rejection !== null,
        lifecycle_event_count: disputePack.lifecycle.length,
        related_alert_count: disputePack.alerts.length,
        has_lp_context: disputePack.lp_context !== null
      },
      data: disputePack,
      checksums
    };
    
    return res.json(apiResponse(true, pack, {
      checksum: checksums.pack.substring(0, 16)
    }));
  } catch (err) {
    console.error("GET /api/orders/:id/dispute-pack error:", err);
    return res.status(500).json(apiResponse(false, undefined, undefined, "Internal server error"));
  }
});

app.get("/health", (_, res) => res.json({ ok: true, build: BUILD_INFO }));

const port = process.env.PORT ? Number(process.env.PORT) : 7001;
app.listen(port, () => console.log(`order-api listening on :${port}`));
