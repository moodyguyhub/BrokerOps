import express from "express";
import pg from "pg";
const { Pool } = pg;

const app = express();

const pool = new Pool({
  host: process.env.PGHOST ?? "localhost",
  port: Number(process.env.PGPORT ?? 5434),
  user: process.env.PGUSER ?? "broker",
  password: process.env.PGPASSWORD ?? "broker",
  database: process.env.PGDATABASE ?? "broker"
});

interface AuditRow {
  id: string;
  trace_id: string;
  event_type: string;
  event_version: string;
  payload_json: any;
  prev_hash: string | null;
  hash: string;
  created_at: string;
}

app.get("/trace/:traceId", async (req, res) => {
  const traceId = req.params.traceId;
  const r = await pool.query(
    "SELECT id, trace_id, event_type, event_version, payload_json, prev_hash, hash, created_at FROM audit_events WHERE trace_id=$1 ORDER BY id ASC",
    [traceId]
  );
  res.json({ traceId, count: r.rowCount, events: r.rows });
});

// P3: Trace Bundle - pitch-ready artifact
app.get("/trace/:traceId/bundle", async (req, res) => {
  const traceId = req.params.traceId;
  const r = await pool.query<AuditRow>(
    "SELECT id, trace_id, event_type, event_version, payload_json, prev_hash, hash, created_at FROM audit_events WHERE trace_id=$1 ORDER BY id ASC",
    [traceId]
  );

  if (!r.rowCount) {
    return res.status(404).json({ error: "Trace not found", traceId });
  }

  const events = r.rows;

  // Extract summary from events
  const riskDecision = events.find(e => e.event_type === "risk.decision");
  const orderRequested = events.find(e => e.event_type === "order.requested");
  const orderOutcome = events.find(e => 
    e.event_type === "order.accepted" || e.event_type === "order.blocked"
  );
  const operatorOverride = events.find(e => e.event_type === "operator.override");

  // Verify hash chain integrity
  let hashChainValid = true;
  for (let i = 1; i < events.length; i++) {
    if (events[i].prev_hash !== events[i - 1].hash) {
      hashChainValid = false;
      break;
    }
  }

  const summary = {
    traceId,
    outcome: orderOutcome?.event_type === "order.accepted" ? "ACCEPTED" : "BLOCKED",
    decision: riskDecision?.payload_json?.decision ?? "UNKNOWN",
    reasonCode: riskDecision?.payload_json?.reasonCode ?? "UNKNOWN",
    ruleId: riskDecision?.payload_json?.ruleId ?? null,
    policyVersion: riskDecision?.payload_json?.policyVersion ?? "UNKNOWN",
    hasOverride: !!operatorOverride,
    overrideBy: operatorOverride?.payload_json?.operatorId ?? null,
    overrideReason: operatorOverride?.payload_json?.reason ?? null,
    order: orderRequested?.payload_json?.raw ?? null,
    eventCount: events.length,
    hashChainValid,
    firstEvent: events[0]?.created_at ?? null,
    lastEvent: events[events.length - 1]?.created_at ?? null
  };

  const bundle = {
    version: "bundle.v1",
    generatedAt: new Date().toISOString(),
    summary,
    hashChain: events.map(e => ({
      seq: e.id,
      eventType: e.event_type,
      hash: e.hash,
      prevHash: e.prev_hash,
      timestamp: e.created_at
    })),
    events
  };

  res.json(bundle);
});

app.get("/health", async (_, res) => {
  const r = await pool.query("SELECT 1 as ok");
  res.json({ ok: r.rows?.[0]?.ok === 1 });
});

const port = process.env.PORT ? Number(process.env.PORT) : 7004;
app.listen(port, () => console.log(`reconstruction-api listening on :${port}`));
