import express from "express";
import crypto from "crypto";
import pg from "pg";
const { Pool } = pg;

const app = express();

const ECONOMICS_URL = process.env.ECONOMICS_URL ?? "http://localhost:7005";

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

// List recent traces (for UI)
app.get("/traces/recent", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  
  const r = await pool.query(`
    SELECT 
      trace_id,
      MIN(created_at) as started_at,
      MAX(created_at) as last_event_at,
      COUNT(*) as event_count,
      MAX(CASE WHEN event_type = 'order.accepted' THEN 'ACCEPTED' 
               WHEN event_type = 'order.blocked' THEN 'BLOCKED' 
               ELSE NULL END) as outcome,
      MAX(CASE WHEN event_type = 'risk.decision' THEN payload_json->>'reasonCode' ELSE NULL END) as reason_code,
      MAX(CASE WHEN event_type = 'risk.decision' THEN payload_json->>'ruleId' ELSE NULL END) as rule_id,
      MAX(CASE WHEN event_type = 'override.approved' THEN 'true' ELSE NULL END) as has_override
    FROM audit_events
    GROUP BY trace_id
    ORDER BY MAX(created_at) DESC
    LIMIT $1
  `, [limit]);

  res.json({
    count: r.rowCount,
    traces: r.rows.map(row => ({
      traceId: row.trace_id,
      startedAt: row.started_at,
      lastEventAt: row.last_event_at,
      eventCount: parseInt(row.event_count),
      outcome: row.outcome ?? "PENDING",
      reasonCode: row.reason_code,
      ruleId: row.rule_id,
      hasOverride: row.has_override === "true"
    }))
  });
});

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

  // Fetch economics data for this trace (best effort - don't fail if unavailable)
  let economicImpact: { estimatedLostRevenue?: number; grossRevenue?: number; currency: string } | null = null;
  try {
    const econRes = await fetch(`${ECONOMICS_URL}/economics/trace/${traceId}`);
    if (econRes.ok) {
      const econData = await econRes.json() as { 
        summary?: { estimatedLostRevenue?: number; totalRevenue?: number; currency?: string } 
      };
      if (econData.summary) {
        economicImpact = {
          estimatedLostRevenue: econData.summary.estimatedLostRevenue || undefined,
          grossRevenue: econData.summary.totalRevenue || undefined,
          currency: econData.summary.currency ?? "USD"
        };
      }
    }
  } catch {
    // Economics service unavailable - continue without it
  }

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
    economicImpact,
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

// ============================================================================
// Entity-Centric Read Views (Audit UX)
// ============================================================================

// GET /overrides/pending - Returns traces with pending override requests
app.get("/overrides/pending", async (req, res) => {
  const r = await pool.query(`
    WITH requested AS (
      SELECT DISTINCT trace_id, payload_json, created_at
      FROM audit_events 
      WHERE event_type = 'override.requested'
    ),
    resolved AS (
      SELECT DISTINCT trace_id
      FROM audit_events 
      WHERE event_type IN ('override.approved', 'override.rejected')
    )
    SELECT r.trace_id, r.payload_json, r.created_at
    FROM requested r
    LEFT JOIN resolved res ON r.trace_id = res.trace_id
    WHERE res.trace_id IS NULL
    ORDER BY r.created_at DESC
    LIMIT 100
  `);

  res.json({
    count: r.rowCount ?? 0,
    pendingOverrides: r.rows.map(row => ({
      traceId: row.trace_id,
      requestedBy: row.payload_json?.requestedBy,
      reason: row.payload_json?.reason,
      newDecision: row.payload_json?.newDecision,
      requestedAt: row.created_at
    }))
  });
});

// GET /overrides/recent - Returns recent override activity (all statuses)
app.get("/overrides/recent", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  
  const r = await pool.query(`
    SELECT 
      trace_id,
      event_type,
      payload_json,
      created_at
    FROM audit_events
    WHERE event_type IN ('override.requested', 'override.approved', 'override.rejected', 'operator.override')
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit]);

  res.json({
    count: r.rowCount ?? 0,
    overrides: r.rows.map(row => ({
      traceId: row.trace_id,
      eventType: row.event_type,
      status: row.event_type === 'override.approved' ? 'APPROVED' :
              row.event_type === 'override.rejected' ? 'REJECTED' :
              row.event_type === 'override.requested' ? 'PENDING' : 'LEGACY',
      operator: row.payload_json?.requestedBy || row.payload_json?.approvedBy || row.payload_json?.rejectedBy || row.payload_json?.operatorId,
      reason: row.payload_json?.reason,
      timestamp: row.created_at
    }))
  });
});

// GET /evaluations/by-account/:accountId - Evaluations for a specific account
// Note: Uses order.clientOrderId prefix as account identifier (convention: ACCT-XXX-*)
app.get("/evaluations/by-account/:accountId", async (req, res) => {
  const accountId = req.params.accountId;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  
  // Search for traces where order.requested payload has clientOrderId starting with accountId
  const r = await pool.query(`
    WITH account_traces AS (
      SELECT DISTINCT trace_id
      FROM audit_events
      WHERE event_type = 'order.requested'
        AND (
          payload_json->'raw'->>'clientOrderId' LIKE $1
          OR payload_json->>'clientOrderId' LIKE $1
        )
    )
    SELECT 
      ae.trace_id,
      MIN(ae.created_at) as started_at,
      COUNT(*) as event_count,
      MAX(CASE WHEN ae.event_type = 'order.accepted' THEN 'ACCEPTED' 
               WHEN ae.event_type = 'order.blocked' THEN 'BLOCKED' 
               ELSE NULL END) as outcome,
      MAX(CASE WHEN ae.event_type = 'risk.decision' THEN ae.payload_json->>'reasonCode' ELSE NULL END) as reason_code
    FROM audit_events ae
    INNER JOIN account_traces at ON ae.trace_id = at.trace_id
    GROUP BY ae.trace_id
    ORDER BY MIN(ae.created_at) DESC
    LIMIT $2
  `, [`${accountId}%`, limit]);

  res.json({
    accountId,
    count: r.rowCount ?? 0,
    evaluations: r.rows.map(row => ({
      traceId: row.trace_id,
      startedAt: row.started_at,
      eventCount: parseInt(row.event_count),
      outcome: row.outcome ?? "PENDING",
      reasonCode: row.reason_code
    }))
  });
});

app.get("/health", async (_, res) => {
  const r = await pool.query("SELECT 1 as ok");
  res.json({ ok: r.rows?.[0]?.ok === 1 });
});

const port = process.env.PORT ? Number(process.env.PORT) : 7004;
app.listen(port, () => console.log(`reconstruction-api listening on :${port}`));
