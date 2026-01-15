import express from "express";
import crypto from "crypto";
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

// Canonical JSON for hash recomputation (must match audit-writer)
function canonicalJson(x: unknown): string {
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

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// Recompute hash to verify integrity
function computeExpectedHash(event: AuditRow, prevHash: string | null): string {
  const material = (prevHash ?? "") + "|" + event.event_type + "|" + event.event_version + "|" + canonicalJson(event.payload_json);
  return sha256(material);
}

interface HashChainVerification {
  valid: boolean;
  brokenAt?: number;
  brokenEventId?: string;
  expectedHash?: string;
  actualHash?: string;
  reason?: string;
}

function verifyHashChain(events: AuditRow[]): HashChainVerification {
  if (events.length === 0) {
    return { valid: true };
  }

  // First event must have null prev_hash
  if (events[0].prev_hash !== null) {
    return {
      valid: false,
      brokenAt: 0,
      brokenEventId: events[0].id,
      reason: "First event has non-null prev_hash"
    };
  }

  // Verify first event hash
  const firstExpected = computeExpectedHash(events[0], null);
  if (events[0].hash !== firstExpected) {
    return {
      valid: false,
      brokenAt: 0,
      brokenEventId: events[0].id,
      expectedHash: firstExpected,
      actualHash: events[0].hash,
      reason: "Hash mismatch on first event"
    };
  }

  // Verify chain continuity and hash integrity
  for (let i = 1; i < events.length; i++) {
    // Check prev_hash links to previous event's hash
    if (events[i].prev_hash !== events[i - 1].hash) {
      return {
        valid: false,
        brokenAt: i,
        brokenEventId: events[i].id,
        expectedHash: events[i - 1].hash,
        actualHash: events[i].prev_hash ?? "null",
        reason: "Chain link broken: prev_hash mismatch"
      };
    }

    // Recompute and verify hash
    const expectedHash = computeExpectedHash(events[i], events[i].prev_hash);
    if (events[i].hash !== expectedHash) {
      return {
        valid: false,
        brokenAt: i,
        brokenEventId: events[i].id,
        expectedHash,
        actualHash: events[i].hash,
        reason: "Hash mismatch: possible tampering"
      };
    }
  }

  return { valid: true };
}

app.get("/trace/:traceId", async (req, res) => {
  const traceId = req.params.traceId;
  const r = await pool.query(
    "SELECT id, trace_id, event_type, event_version, payload_json, prev_hash, hash, created_at FROM audit_events WHERE trace_id=$1 ORDER BY id ASC",
    [traceId]
  );
  res.json({ traceId, count: r.rowCount, events: r.rows });
});

// P3: Trace Bundle - pitch-ready artifact with fail-closed verification
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

  // CRITICAL: Verify hash chain integrity (fail closed)
  const hashVerification = verifyHashChain(events);
  
  if (!hashVerification.valid) {
    // Fail closed: return 500 with tampering evidence
    return res.status(500).json({
      error: "AUDIT_CHAIN_INTEGRITY_FAILURE",
      traceId,
      verification: hashVerification,
      message: "Hash chain verification failed. Audit trail may have been tampered with.",
      action: "Contact security team immediately. Do not trust this trace."
    });
  }

  // Extract summary from events
  const riskDecision = events.find(e => e.event_type === "risk.decision");
  const orderRequested = events.find(e => e.event_type === "order.requested");
  const orderOutcome = events.find(e => 
    e.event_type === "order.accepted" || e.event_type === "order.blocked"
  );
  const operatorOverride = events.find(e => 
    e.event_type === "operator.override" || e.event_type === "override.approved"
  );

  const summary = {
    traceId,
    outcome: orderOutcome?.event_type === "order.accepted" ? "ACCEPTED" : "BLOCKED",
    decision: riskDecision?.payload_json?.decision ?? "UNKNOWN",
    reasonCode: riskDecision?.payload_json?.reasonCode ?? "UNKNOWN",
    ruleId: riskDecision?.payload_json?.ruleId ?? null,
    policyVersion: riskDecision?.payload_json?.policyVersion ?? "UNKNOWN",
    hasOverride: !!operatorOverride,
    overrideBy: operatorOverride?.payload_json?.operatorId ?? operatorOverride?.payload_json?.approvedBy ?? null,
    overrideReason: operatorOverride?.payload_json?.reason ?? null,
    order: orderRequested?.payload_json?.raw ?? null,
    eventCount: events.length,
    hashChainValid: true, // If we got here, it's valid
    hashChainVerified: true,
    firstEvent: events[0]?.created_at ?? null,
    lastEvent: events[events.length - 1]?.created_at ?? null
  };

  const bundle = {
    version: "bundle.v2",
    generatedAt: new Date().toISOString(),
    integrityVerified: true,
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
