import express from "express";
import { execSync } from "child_process";
import { OrderRequestSchema, type RiskDecision } from "@broker/common";

// Build identity for demo/incident triage
const BUILD_INFO = {
  commit: (() => {
    try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); }
    catch { return "unknown"; }
  })(),
  built_at: new Date().toISOString(),
  service: "risk-gate"
};

const app = express();
app.use(express.json());

const OPA_URL = process.env.OPA_URL ?? "http://localhost:8181";
const FALLBACK_POLICY_VERSION = "policy.v0.2-fallback";

interface OpaDecision {
  allow: boolean;
  reason_code: string;
  rule_id: string;
}

interface OpaResponse {
  result?: {
    decision?: OpaDecision;
    policy_version?: string;
  };
}

async function queryOpa(order: unknown): Promise<RiskDecision> {
  try {
    const response = await fetch(`${OPA_URL}/v1/data/broker/risk/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: order })
    });

    if (!response.ok) {
      console.error(`OPA query failed: ${response.status}`);
      return { decision: "BLOCK", reasonCode: "OPA_UNAVAILABLE", policyVersion: FALLBACK_POLICY_VERSION };
    }

    const data = await response.json() as OpaResponse;
    const decision = data.result?.decision;
    const policyVersion = data.result?.policy_version ?? FALLBACK_POLICY_VERSION;

    if (!decision) {
      return { decision: "BLOCK", reasonCode: "OPA_NO_DECISION", policyVersion };
    }

    return {
      decision: decision.allow ? "ALLOW" : "BLOCK",
      reasonCode: decision.reason_code,
      policyVersion,
      ruleId: decision.rule_id
    } as RiskDecision & { ruleId: string };
  } catch (err) {
    console.error("OPA query error:", err);
    return { decision: "BLOCK", reasonCode: "OPA_ERROR", policyVersion: FALLBACK_POLICY_VERSION };
  }
}

function decide(order: unknown): RiskDecision {
  const parsed = OrderRequestSchema.safeParse(order);
  if (!parsed.success) {
    return { decision: "BLOCK", reasonCode: "INVALID_ORDER_SCHEMA", policyVersion: FALLBACK_POLICY_VERSION };
  }
  return { decision: "ALLOW", reasonCode: "SCHEMA_VALID", policyVersion: FALLBACK_POLICY_VERSION };
}

app.post("/decide", async (req, res) => {
  // First validate schema
  const parsed = OrderRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.json({ 
      decision: "BLOCK", 
      reasonCode: "INVALID_ORDER_SCHEMA", 
      policyVersion: FALLBACK_POLICY_VERSION 
    });
  }

  // Then query OPA for policy decision
  const decision = await queryOpa(parsed.data);
  res.json(decision);
});

// Policy evaluation endpoint (used by /dry-run - no persistence, no audit)
app.post("/evaluate", async (req, res) => {
  // Validate schema
  const parsed = OrderRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.json({ 
      decision: "BLOCK", 
      reasonCode: "INVALID_ORDER_SCHEMA", 
      policyVersion: FALLBACK_POLICY_VERSION,
      dryRun: true,
      validationErrors: parsed.error.errors
    });
  }

  // Query OPA for policy evaluation
  const decision = await queryOpa(parsed.data);
  
  // Calculate preview economics
  const order = parsed.data;
  const attemptNotional = (order.qty ?? 0) * (order.price ?? 0);
  
  res.json({
    ...decision,
    dryRun: true,
    order: {
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      price: order.price
    },
    previewEconomics: {
      attemptNotional,
      savedExposure: decision.decision === "BLOCK" ? attemptNotional : 0
    },
    evaluatedAt: new Date().toISOString()
  });
});

app.get("/health", async (_, res) => {
  try {
    const opaRes = await fetch(`${OPA_URL}/health`);
    const opaOk = opaRes.ok;
    res.json({ ok: true, opa: opaOk ? "connected" : "unreachable", build: BUILD_INFO });
  } catch {
    res.json({ ok: true, opa: "unreachable", build: BUILD_INFO });
  }
});

const port = process.env.PORT ? Number(process.env.PORT) : 7002;
app.listen(port, () => console.log(`risk-gate listening on :${port} (OPA: ${OPA_URL})`));
