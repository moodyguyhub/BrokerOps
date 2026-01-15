import express from "express";
import { newTraceId, OrderRequestSchema, type RiskDecision } from "@broker/common";

const app = express();
app.use(express.json());

const RISK_GATE_URL = process.env.RISK_GATE_URL ?? "http://localhost:7002";
const AUDIT_URL = process.env.AUDIT_URL ?? "http://localhost:7003";
const RECONSTRUCTION_URL = process.env.RECONSTRUCTION_URL ?? "http://localhost:7004";

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

app.post("/orders", async (req, res) => {
  const traceId = req.header("x-trace-id") ?? newTraceId();

  const parsed = OrderRequestSchema.safeParse(req.body);
  await audit(traceId, "order.requested", { raw: req.body, valid: parsed.success });

  if (!parsed.success) {
    await audit(traceId, "order.blocked", { reason: "INVALID_ORDER_SCHEMA", details: parsed.error.flatten() });
    return res.status(400).json({ traceId, status: "BLOCKED", reason: "INVALID_ORDER_SCHEMA" });
  }

  const order = parsed.data;
  const decision = await decideRisk(order);
  await audit(traceId, "risk.decision", decision);

  if (decision.decision === "BLOCK") {
    await audit(traceId, "order.blocked", { ...decision, order });
    return res.status(403).json({ traceId, status: "BLOCKED", ...decision });
  }

  await audit(traceId, "order.accepted", { ...decision, order });

  // v0: no execution. Just accept.
  return res.json({ traceId, status: "ACCEPTED", ...decision });
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

app.get("/health", (_, res) => res.json({ ok: true }));

const port = process.env.PORT ? Number(process.env.PORT) : 7001;
app.listen(port, () => console.log(`order-api listening on :${port}`));
