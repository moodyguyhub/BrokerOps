import express from "express";
import { OrderRequestSchema, type RiskDecision } from "@broker/common";

const app = express();
app.use(express.json());

const POLICY_VERSION = "policy.v0.1";

function decide(order: unknown): RiskDecision {
  const parsed = OrderRequestSchema.safeParse(order);
  if (!parsed.success) {
    return { decision: "BLOCK", reasonCode: "INVALID_ORDER_SCHEMA", policyVersion: POLICY_VERSION };
  }
  const o = parsed.data;

  // Minimal risk rules for v0 demo:
  if (o.qty > 1000) return { decision: "BLOCK", reasonCode: "QTY_LIMIT_EXCEEDED", policyVersion: POLICY_VERSION };
  if (o.symbol.toUpperCase() === "GME" && o.qty > 10) return { decision: "BLOCK", reasonCode: "SYMBOL_RESTRICTION", policyVersion: POLICY_VERSION };
  return { decision: "ALLOW", reasonCode: "OK", policyVersion: POLICY_VERSION };
}

app.post("/decide", (req, res) => {
  const decision = decide(req.body);
  res.json(decision);
});

app.get("/health", (_, res) => res.json({ ok: true, policyVersion: POLICY_VERSION }));

const port = process.env.PORT ? Number(process.env.PORT) : 7002;
app.listen(port, () => console.log(`risk-gate listening on :${port}`));
