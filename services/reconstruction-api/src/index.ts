import express from "express";
import crypto from "crypto";
import pg from "pg";
import {
  buildEvidencePack,
  extractPolicySnapshot,
  extractDecision,
  extractAuditChain,
  extractOperatorIdentity,
  serializeEvidencePack,
  type EconomicsComponent,
  type EvidenceRealizedEconomics,
  // Phase 1 LP Order imports
  reconstructTimeline,
  isTerminalStatus,
  type LpOrderEvent,
  type Timeline
} from "@broker/common";
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
      MAX(CASE WHEN event_type IN ('order.accepted', 'order.authorized') THEN 'AUTHORIZED' 
               WHEN event_type = 'order.blocked' THEN 'BLOCKED' 
               ELSE NULL END) as outcome,
      MAX(CASE WHEN event_type = 'risk.decision' THEN payload_json->>'reasonCode' ELSE NULL END) as reason_code,
      MAX(CASE WHEN event_type = 'risk.decision' THEN payload_json->>'ruleId' ELSE NULL END) as rule_id,
      MAX(CASE WHEN event_type = 'override.approved' THEN 'true' ELSE NULL END) as has_override,
      MAX(CASE WHEN event_type IN ('order.authorized', 'order.blocked') THEN payload_json->>'decision_signature' ELSE NULL END) as decision_signature
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
      hasOverride: row.has_override === "true",
      decisionSignature: row.decision_signature ?? null
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
    e.event_type === "order.accepted" || e.event_type === "order.authorized" || e.event_type === "order.blocked"
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
    outcome: (orderOutcome?.event_type === "order.accepted" || orderOutcome?.event_type === "order.authorized") ? "AUTHORIZED" : "BLOCKED",
    decisionSignature: orderOutcome?.payload_json?.decision_signature ?? null,
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
      MAX(CASE WHEN ae.event_type IN ('order.accepted', 'order.authorized') THEN 'AUTHORIZED' 
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

// GET /trace/:traceId/evidence-pack - Generate Evidence Pack v1 for trace
app.get("/trace/:traceId/evidence-pack", async (req, res) => {
  const { traceId } = req.params;
  
  try {
    // Fetch trace bundle first
    const events = await pool.query<AuditRow>(
      "SELECT * FROM audit_events WHERE trace_id = $1 ORDER BY id",
      [traceId]
    );
    
    if (events.rows.length === 0) {
      return res.status(404).json({ error: "TRACE_NOT_FOUND", traceId });
    }
    
    // Build trace bundle (reuse existing logic)
    const chainVerification = verifyHashChain(events.rows);
    
    // Fetch economics if available
    let economics: EconomicsComponent | undefined;
    let realizedEconomics: EvidenceRealizedEconomics | undefined;
    
    try {
      const econRes = await fetch(`${ECONOMICS_URL}/economics/trace/${traceId}`);
      if (econRes.ok) {
        const econData = await econRes.json();
        if (!econData.error && econData.summary) {
          economics = {
            traceId,
            summary: {
              grossRevenue: econData.summary.totalRevenue ?? 0,
              fees: econData.summary.fees ?? 0,
              costs: econData.summary.totalCosts ?? 0,
              estimatedLostRevenue: econData.summary.estimatedLostRevenue ?? 0,
              netImpact: (econData.summary.totalRevenue ?? 0) - (econData.summary.totalCosts ?? 0),
              currency: econData.summary.currency ?? "USD"
            },
            events: (econData.events ?? []).map((e: any) => ({
              eventType: e.eventType,
              amount: e.grossRevenue ?? e.estimatedLostRevenue ?? 0,
              source: e.source ?? "unknown",
              timestamp: e.createdAt
            }))
          };
        }
      }
    } catch {
      // Economics service might not be available
    }
    
    // P2-G2: Fetch realized economics from lifecycle_events (execution + close events)
    try {
      // Get the decision_token from audit events for this trace
      // The decision token payload contains trace_id, and lifecycle events store decision_token=traceId
      const decisionEvent = events.rows.find(e => 
        e.event_type === 'order.authorized' || e.event_type === 'order.accepted'
      );
      
      // Use traceId as the lookup key (lifecycle events store traceId as decision_token)
      const decisionToken = decisionEvent?.payload_json?.decisionToken?.trace_id ?? traceId;
      
      if (decisionToken) {
        // Fetch execution events
        const execRes = await pool.query(`
          SELECT * FROM lifecycle_events 
          WHERE decision_token = $1 AND event_type = 'execution.reported'
          ORDER BY created_at ASC
        `, [decisionToken]);
        
        // Fetch close events
        const closeRes = await pool.query(`
          SELECT * FROM lifecycle_events 
          WHERE decision_token = $1 AND event_type = 'position.closed'
          ORDER BY created_at DESC LIMIT 1
        `, [decisionToken]);
        
        // Fetch reconciliation if exists
        const reconRes = await pool.query(`
          SELECT * FROM realized_economics 
          WHERE decision_token = $1
          ORDER BY created_at DESC LIMIT 1
        `, [decisionToken]);
        
        const execEvent = execRes.rows[0];
        const closeEvent = closeRes.rows[0];
        const reconEvent = reconRes.rows[0];
        
        if (execEvent || closeEvent) {
          realizedEconomics = {
            fill_price: execEvent?.price ?? closeEvent?.raw_payload?.exit_price,
            fill_qty: execEvent?.qty ?? closeEvent?.qty,
            fill_timestamp: execEvent?.raw_payload?.fill_timestamp ?? execEvent?.created_at,
            realized_pnl: closeEvent?.realized_pnl ?? reconEvent?.authoritative_pnl,
            pnl_status: reconEvent ? 'FINAL' : (closeEvent ? 'PROVISIONAL' : 'PROJECTED'),
            pnl_source: reconEvent ? 'BACKOFFICE' : (closeEvent?.pnl_source ?? 'PLATFORM'),
            final_pnl: reconEvent?.authoritative_pnl,
            finalized_at: reconEvent?.created_at,
            platform_pnl: closeEvent?.realized_pnl ?? reconEvent?.platform_pnl,
            discrepancy: reconEvent?.discrepancy,
            discrepancy_percent: reconEvent?.discrepancy_percent
          };
        }
      }
    } catch (err) {
      // Lifecycle events table might not exist yet - continue without realized economics
      console.debug("Realized economics fetch failed (expected if P2 tables not migrated):", err);
    }
    
    // Build minimal trace bundle for extraction
    const traceBundle = {
      traceId,
      events: events.rows.map(r => ({
        eventType: r.event_type,
        eventVersion: r.event_version,
        payload: r.payload_json,
        prevHash: r.prev_hash,
        hash: r.hash,
        timestamp: r.created_at
      })),
      summary: buildSummaryFromEvents(events.rows, chainVerification)
    };
    
    // Get policy content (from OPA or file)
    let policyContent = "# Policy content not available";
    try {
      const opaRes = await fetch("http://localhost:8181/v1/policies");
      if (opaRes.ok) {
        const policies = await opaRes.json();
        policyContent = JSON.stringify(policies.result, null, 2);
      }
    } catch {
      // OPA might not be available
    }
    
    // Extract components
    const policySnapshot = extractPolicySnapshot(traceBundle, policyContent);
    const decision = extractDecision(traceBundle);
    const auditChain = extractAuditChain(traceBundle);
    const operatorIdentity = extractOperatorIdentity(traceBundle);
    
    // Build evidence pack (with P2 realized economics)
    const pack = buildEvidencePack(
      traceId,
      {
        policySnapshot,
        decision,
        auditChain,
        economics,
        operatorIdentity,
        realizedEconomics  // P2-G2: Include realized economics if available
      },
      {
        generatorName: "BrokerOps Reconstruction API",
        generatorVersion: "2.0.0",  // Bumped for P2
        commitHash: process.env.GIT_COMMIT ?? "unknown"
      }
    );
    
    res.json(pack);
  } catch (err) {
    console.error("Evidence pack generation error:", err);
    res.status(500).json({ 
      error: "EVIDENCE_PACK_GENERATION_FAILED",
      message: err instanceof Error ? err.message : "Unknown error"
    });
  }
});

// Helper function to build summary from events (reused)
function buildSummaryFromEvents(events: AuditRow[], chainVerification: HashChainVerification) {
  const riskDecision = events.find(e => e.event_type === "risk.decision");
  const orderRequested = events.find(e => e.event_type === "order.requested");
  const authorizedEvent = events.find(e => 
    e.event_type === "order.authorized" || e.event_type === "order.accepted"
  );
  const blockedEvent = events.find(e => e.event_type === "order.blocked");
  const overrideApproved = events.find(e => e.event_type === "override.approved");
  
  return {
    traceId: events[0]?.trace_id,
    outcome: authorizedEvent ? "AUTHORIZED" : blockedEvent ? "BLOCKED" : "PENDING",
    decision: riskDecision?.payload_json?.decision ?? "UNKNOWN",
    reasonCode: riskDecision?.payload_json?.reasonCode ?? "UNKNOWN",
    ruleId: riskDecision?.payload_json?.ruleId,
    policyVersion: riskDecision?.payload_json?.policyVersion ?? "unknown",
    decisionSignature: authorizedEvent?.payload_json?.decision_signature ?? blockedEvent?.payload_json?.decision_signature,
    hasOverride: !!overrideApproved,
    overrideBy: overrideApproved?.payload_json?.approvedBy,
    order: orderRequested?.payload_json?.raw ?? orderRequested?.payload_json,
    hashChainValid: chainVerification.valid,
    eventCount: events.length,
    firstEvent: events[0]?.created_at,
    lastEvent: events[events.length - 1]?.created_at
  };
}

// ============================================================================
// Phase 1: LP Order Timeline Reconstruction
// ============================================================================

interface LpTimelineResponse extends Timeline {
  verification: {
    chain_valid: boolean;
    chain_length: number;
    computed_hashes_match: boolean;
  };
  rejection_details?: {
    reason_class: string;
    reason_code: string;
    raw_provider_code: string | null;
    raw_provider_message: string | null;
    taxonomy_version: string;
  };
}

// GET /lp-timeline/:traceId - Reconstruct LP order timeline
app.get("/lp-timeline/:traceId", async (req, res) => {
  const traceId = req.params.traceId;
  
  try {
    // Fetch LP order events for this trace
    const r = await pool.query<AuditRow>(
      `SELECT id, trace_id, event_type, event_version, payload_json, prev_hash, hash, created_at 
       FROM audit_events 
       WHERE trace_id=$1 AND event_type LIKE 'lp.order.%'
       ORDER BY id ASC`,
      [traceId]
    );

    if (!r.rowCount) {
      return res.status(404).json({ 
        error: "LP_TIMELINE_NOT_FOUND", 
        trace_id: traceId,
        message: "No LP order events found for this trace"
      });
    }

    // Extract LP events from stored payload
    const lpEvents: LpOrderEvent[] = r.rows.map(row => {
      const stored = row.payload_json;
      // Remove internal validation metadata
      const { _validation, ...event } = stored;
      return event as LpOrderEvent;
    });

    // Reconstruct timeline using common module
    const timeline = reconstructTimeline(traceId, lpEvents);

    // Verify hash chain
    const chainVerification = verifyHashChain(r.rows);

    // Extract rejection details if present
    let rejectionDetails: LpTimelineResponse["rejection_details"];
    const rejectionEvent = lpEvents.find(e => e.normalization.status === "REJECTED");
    if (rejectionEvent?.normalization.reason) {
      const reason = rejectionEvent.normalization.reason;
      rejectionDetails = {
        reason_class: reason.reason_class,
        reason_code: reason.reason_code,
        raw_provider_code: reason.raw.provider_code ?? null,
        raw_provider_message: reason.raw.provider_message ?? null,
        taxonomy_version: reason.taxonomy_version
      };
    }

    const response: LpTimelineResponse = {
      ...timeline,
      verification: {
        chain_valid: chainVerification.valid,
        chain_length: r.rowCount ?? 0,
        computed_hashes_match: chainVerification.valid
      },
      rejection_details: rejectionDetails
    };

    // Add warning header if violations detected
    if (timeline.has_violations) {
      res.setHeader("X-BrokerOps-Warning", "TRANSITION_VIOLATIONS_DETECTED");
    }

    if (!chainVerification.valid) {
      res.setHeader("X-BrokerOps-Warning", "HASH_CHAIN_INVALID");
      response.integrity_status = "TAMPER_SUSPECTED";
    }

    res.json(response);
  } catch (err) {
    console.error("LP timeline reconstruction error:", err);
    res.status(500).json({
      error: "LP_TIMELINE_RECONSTRUCTION_FAILED",
      message: err instanceof Error ? err.message : "Unknown error"
    });
  }
});

// GET /lp-timeline/:traceId/evidence - Generate LP timeline evidence for pack inclusion
app.get("/lp-timeline/:traceId/evidence", async (req, res) => {
  const traceId = req.params.traceId;
  
  try {
    const r = await pool.query<AuditRow>(
      `SELECT id, trace_id, event_type, event_version, payload_json, prev_hash, hash, created_at 
       FROM audit_events 
       WHERE trace_id=$1 AND event_type LIKE 'lp.order.%'
       ORDER BY id ASC`,
      [traceId]
    );

    if (!r.rowCount) {
      return res.status(404).json({ error: "LP_TIMELINE_NOT_FOUND", trace_id: traceId });
    }

    const lpEvents: LpOrderEvent[] = r.rows.map(row => {
      const { _validation, ...event } = row.payload_json;
      return event as LpOrderEvent;
    });

    const timeline = reconstructTimeline(traceId, lpEvents);
    const chainVerification = verifyHashChain(r.rows);

    // Build evidence structure
    const evidence = {
      lp_timeline: {
        trace_id: traceId,
        generated_at: new Date().toISOString(),
        event_count: lpEvents.length,
        current_status: timeline.current_status,
        is_terminal: timeline.is_terminal,
        has_violations: timeline.has_violations,
        violations: timeline.violations,
        integrity_status: chainVerification.valid ? "VALID" : "TAMPER_SUSPECTED",
        fill_summary: timeline.fill_summary
      },
      hash_chain: r.rows.map(row => ({
        seq: row.id,
        event_id: row.payload_json.event_id,
        event_type: row.event_type,
        status: row.payload_json.normalization?.status,
        occurred_at: row.payload_json.occurred_at,
        hash: row.hash,
        prev_hash: row.prev_hash
      })),
      events: lpEvents.map(e => ({
        event_id: e.event_id,
        event_type: e.event_type,
        status: e.normalization.status,
        occurred_at: e.occurred_at,
        source: e.source,
        correlation: e.correlation,
        payload_summary: {
          symbol: e.payload.symbol,
          side: e.payload.side,
          qty: e.payload.qty,
          fill_qty: e.payload.fill_qty,
          fill_price: e.payload.fill_price
        },
        reason: e.normalization.reason
      })),
      checksums: {
        timeline_hash: crypto.createHash("sha256")
          .update(JSON.stringify(timeline))
          .digest("hex"),
        chain_verification: chainVerification
      }
    };

    res.json(evidence);
  } catch (err) {
    console.error("LP timeline evidence error:", err);
    res.status(500).json({
      error: "LP_TIMELINE_EVIDENCE_FAILED",
      message: err instanceof Error ? err.message : "Unknown error"
    });
  }
});

// GET /lp-timelines/recent - List recent LP order timelines
app.get("/lp-timelines/recent", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const serverId = typeof req.query.server_id === "string" ? req.query.server_id : null;
  
  try {
    const r = await pool.query(`
      WITH lp_traces AS (
        SELECT 
          trace_id,
          MIN(created_at) as started_at,
          MAX(created_at) as last_event_at,
          COUNT(*) as event_count,
          MAX(payload_json->'normalization'->>'status') as last_status,
          MAX(payload_json->'payload'->>'symbol') as symbol,
          MAX(payload_json->'payload'->>'side') as side,
          MAX((payload_json->'payload'->>'qty')::numeric) as qty,
          MAX(payload_json->'normalization'->'reason'->>'reason_code') as rejection_reason,
          MAX(payload_json->'source'->>'server_id') as server_id,
          MAX(payload_json->'source'->>'server_name') as server_name
        FROM audit_events
        WHERE event_type LIKE 'lp.order.%'
          AND ($2::text IS NULL OR payload_json->'source'->>'server_id' = $2)
        GROUP BY trace_id
      )
      SELECT * FROM lp_traces
      ORDER BY started_at DESC
      LIMIT $1
    `, [limit, serverId]);

    res.json({
      count: r.rowCount ?? 0,
      timelines: r.rows.map(row => ({
        trace_id: row.trace_id,
        started_at: row.started_at,
        last_event_at: row.last_event_at,
        event_count: parseInt(row.event_count),
        current_status: row.last_status,
        symbol: row.symbol,
        side: row.side,
        qty: row.qty,
        rejection_reason: row.rejection_reason,
        server_id: row.server_id,
        server_name: row.server_name
      }))
    });
  } catch (err) {
    console.error("LP timelines list error:", err);
    res.status(500).json({
      error: "LP_TIMELINES_LIST_FAILED",
      message: err instanceof Error ? err.message : "Unknown error"
    });
  }
});

app.get("/health", async (_, res) => {
  const r = await pool.query("SELECT 1 as ok");
  res.json({ ok: r.rows?.[0]?.ok === 1 });
});

const port = process.env.PORT ? Number(process.env.PORT) : 7004;
app.listen(port, () => console.log(`reconstruction-api listening on :${port}`));
