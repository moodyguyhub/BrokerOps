import express from "express";
import { newTraceId, OrderRequestSchema, type RiskDecision } from "@broker/common";

const app = express();
app.use(express.json());

const RISK_GATE_URL = process.env.RISK_GATE_URL ?? "http://localhost:7002";
const AUDIT_URL = process.env.AUDIT_URL ?? "http://localhost:7003";

async function audit(traceId: string, eventType: string, payload: any) {
  const r = await fetch(`${AUDIT_URL}/append`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ traceId, eventType, eventVersion: "v1", payload })
  });
  if (!r.ok) throw new Error(`audit append failed: ${r.status}`);
  return r.json();
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

app.get("/health", (_, res) => res.json({ ok: true }));

const port = process.env.PORT ? Number(process.env.PORT) : 7001;
app.listen(port, () => console.log(`order-api listening on :${port}`));
