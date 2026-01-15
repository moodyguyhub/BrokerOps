/**
 * Evidence Pack v1 Module (P0.3)
 * 
 * Creates a cryptographically signed evidence bundle for regulatory submission.
 * All components are hashed individually and collected in a signed manifest.
 * 
 * Structure:
 * - manifest.json (signed, contains SHA-256 hashes of all components)
 * - policy_snapshot.rego (active policy at decision time)
 * - decision.json (OPA input/output)
 * - audit_chain.json (hash-chained events)
 * - economics.json (economic impact)
 * - operator_identity.json (who was involved in decision/override)
 */

import { createHash } from "crypto";
import { readFile } from "fs/promises";

/**
 * Evidence Pack Manifest v1
 * Contains SHA-256 hashes of all evidence components
 */
export interface EvidenceManifestV1 {
  manifestVersion: "1.0";
  traceId: string;
  generatedAt: string;
  generator: {
    name: string;
    version: string;
    commitHash: string;
  };
  
  // SHA-256 hashes of each component
  componentHashes: {
    policy_snapshot: string;
    decision: string;
    audit_chain: string;
    economics?: string;
    operator_identity?: string;
  };
  
  // Computed hash of all component hashes (for quick verification)
  packHash: string;
  
  // Signature of the packHash (optional, if signing key available)
  signature?: string;
}

/**
 * Policy snapshot component
 */
export interface PolicySnapshotComponent {
  policyVersion: string;
  policyContent: string;  // Raw Rego content
  policyHash: string;     // SHA-256 of content
  loadedAt: string;       // When policy was active
  opaVersion?: string;
}

/**
 * Decision component (OPA input/output)
 */
export interface DecisionComponent {
  traceId: string;
  timestamp: string;
  
  // OPA input
  input: {
    order: {
      symbol: string;
      side: string;
      qty: number;
      price?: number;
      clientOrderId?: string;
    };
    context?: Record<string, unknown>;
  };
  
  // OPA output
  output: {
    decision: "ALLOW" | "BLOCK";
    reasonCode: string;
    ruleId?: string;
    policyVersion: string;
  };
  
  // Decision Token (if issued)
  decisionToken?: {
    signature: string;
    issuedAt: string;
    expiresAt: string;
  };
}

/**
 * Audit chain component
 */
export interface AuditChainComponent {
  traceId: string;
  events: AuditEvent[];
  chainIntegrity: {
    isValid: boolean;
    verifiedAt: string;
    firstHash: string;
    lastHash: string;
    eventCount: number;
  };
}

export interface AuditEvent {
  seq: number;
  eventType: string;
  eventVersion: string;
  timestamp: string;
  payload: unknown;
  prevHash: string | null;
  hash: string;
}

/**
 * Economics component (legacy v1)
 */
export interface EconomicsComponent {
  traceId: string;
  summary: {
    grossRevenue: number;
    fees: number;
    costs: number;
    estimatedLostRevenue: number;
    netImpact: number;
    currency: string;
  };
  events: {
    eventType: string;
    amount: number;
    source: string;
    timestamp: string;
  }[];
}

/**
 * Snapshot Economics for Evidence Pack (P1)
 */
export interface EvidenceSnapshotEconomics {
  decision_time: string;
  decision_time_price: number | null;
  qty: number;
  notional: number | null;
  projected_exposure_delta: number | null;
  saved_exposure: number | null;
  price_source: 'FIRM' | 'INDICATIVE' | 'REFERENCE' | 'UNAVAILABLE';
  price_unavailable: boolean;
  exposure_pre: number | null;
  exposure_post: number | null;
  currency: 'USD';
}

/**
 * Policy limit context for evidence
 */
export interface EvidencePolicyContext {
  limit_type?: string;
  limit_value?: number;
  current_value?: number;
  breach_amount?: number;
}

/**
 * Economics component v2 (P1 - Snapshot Economics)
 */
export interface EconomicsComponentV2 {
  version: "2.0";
  traceId: string;
  timestamp: string;
  
  // Snapshot economics (P1)
  snapshot: EvidenceSnapshotEconomics;
  
  // Policy context (if applicable)
  policy_context?: EvidencePolicyContext;
  
  // Legacy summary (backward compat)
  summary?: {
    grossRevenue: number;
    fees: number;
    costs: number;
    estimatedLostRevenue: number;
    netImpact: number;
    currency: string;
  };
}

/**
 * Operator identity component
 */
export interface OperatorIdentityComponent {
  traceId: string;
  operators: {
    role: "requester" | "approver" | "system";
    operatorId: string;
    action: string;
    timestamp: string;
    source?: string;  // e.g., "override.requested", "override.approved"
  }[];
  dualControlVerified: boolean;
}

/**
 * Complete Evidence Pack v1
 */
export interface EvidencePackV1 {
  manifest: EvidenceManifestV1;
  components: {
    policySnapshot: PolicySnapshotComponent;
    decision: DecisionComponent;
    auditChain: AuditChainComponent;
    economics?: EconomicsComponent | EconomicsComponentV2;
    operatorIdentity?: OperatorIdentityComponent;
  };
}

/**
 * Calculate SHA-256 hash of a JSON object
 */
export function hashComponent(data: unknown): string {
  const json = JSON.stringify(data, null, 0); // Canonical JSON (no formatting)
  return createHash("sha256").update(json).digest("hex");
}

/**
 * Calculate the pack hash from all component hashes
 */
export function calculatePackHash(componentHashes: EvidenceManifestV1["componentHashes"]): string {
  const orderedHashes = [
    componentHashes.policy_snapshot,
    componentHashes.decision,
    componentHashes.audit_chain,
    componentHashes.economics ?? "",
    componentHashes.operator_identity ?? ""
  ].join(":");
  
  return createHash("sha256").update(orderedHashes).digest("hex");
}

/**
 * Sign the pack hash with HMAC-SHA256
 */
export function signPackHash(packHash: string, signingKey?: string): string | undefined {
  if (!signingKey) return undefined;
  
  const { createHmac } = require("crypto");
  return createHmac("sha256", signingKey)
    .update(packHash)
    .digest("hex");
}

/**
 * Build Evidence Pack v1 from components
 */
export function buildEvidencePack(
  traceId: string,
  components: {
    policySnapshot: PolicySnapshotComponent;
    decision: DecisionComponent;
    auditChain: AuditChainComponent;
    economics?: EconomicsComponent;
    operatorIdentity?: OperatorIdentityComponent;
  },
  options?: {
    generatorName?: string;
    generatorVersion?: string;
    commitHash?: string;
    signingKey?: string;
  }
): EvidencePackV1 {
  // Calculate component hashes
  const componentHashes: EvidenceManifestV1["componentHashes"] = {
    policy_snapshot: hashComponent(components.policySnapshot),
    decision: hashComponent(components.decision),
    audit_chain: hashComponent(components.auditChain),
    economics: components.economics ? hashComponent(components.economics) : undefined,
    operator_identity: components.operatorIdentity ? hashComponent(components.operatorIdentity) : undefined
  };
  
  // Calculate pack hash
  const packHash = calculatePackHash(componentHashes);
  
  // Sign if key available
  const signature = signPackHash(packHash, options?.signingKey);
  
  // Build manifest
  const manifest: EvidenceManifestV1 = {
    manifestVersion: "1.0",
    traceId,
    generatedAt: new Date().toISOString(),
    generator: {
      name: options?.generatorName ?? "BrokerOps Evidence Pack Generator",
      version: options?.generatorVersion ?? "1.0.0",
      commitHash: options?.commitHash ?? "unknown"
    },
    componentHashes,
    packHash,
    signature
  };
  
  return {
    manifest,
    components
  };
}

/**
 * Verify Evidence Pack integrity
 * Recalculates all hashes and compares to manifest
 */
export function verifyEvidencePack(pack: EvidencePackV1): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  
  // Verify each component hash
  const policyHash = hashComponent(pack.components.policySnapshot);
  if (policyHash !== pack.manifest.componentHashes.policy_snapshot) {
    errors.push(`Policy snapshot hash mismatch: expected ${pack.manifest.componentHashes.policy_snapshot}, got ${policyHash}`);
  }
  
  const decisionHash = hashComponent(pack.components.decision);
  if (decisionHash !== pack.manifest.componentHashes.decision) {
    errors.push(`Decision hash mismatch: expected ${pack.manifest.componentHashes.decision}, got ${decisionHash}`);
  }
  
  const auditChainHash = hashComponent(pack.components.auditChain);
  if (auditChainHash !== pack.manifest.componentHashes.audit_chain) {
    errors.push(`Audit chain hash mismatch: expected ${pack.manifest.componentHashes.audit_chain}, got ${auditChainHash}`);
  }
  
  if (pack.components.economics && pack.manifest.componentHashes.economics) {
    const economicsHash = hashComponent(pack.components.economics);
    if (economicsHash !== pack.manifest.componentHashes.economics) {
      errors.push(`Economics hash mismatch: expected ${pack.manifest.componentHashes.economics}, got ${economicsHash}`);
    }
  }
  
  if (pack.components.operatorIdentity && pack.manifest.componentHashes.operator_identity) {
    const operatorHash = hashComponent(pack.components.operatorIdentity);
    if (operatorHash !== pack.manifest.componentHashes.operator_identity) {
      errors.push(`Operator identity hash mismatch: expected ${pack.manifest.componentHashes.operator_identity}, got ${operatorHash}`);
    }
  }
  
  // Verify pack hash
  const calculatedPackHash = calculatePackHash(pack.manifest.componentHashes);
  if (calculatedPackHash !== pack.manifest.packHash) {
    errors.push(`Pack hash mismatch: expected ${pack.manifest.packHash}, got ${calculatedPackHash}`);
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Verify Evidence Pack policy snapshot matches Decision Token hash (P0-R3)
 * This ensures the evidence pack contains the exact policy used at decision time
 */
export function verifyPolicyConsistency(
  pack: EvidencePackV1,
  decisionTokenPolicyHash?: string
): {
  consistent: boolean;
  packPolicyHash: string;
  tokenPolicyHash: string | null;
  error?: string;
} {
  const packPolicyHash = pack.components.policySnapshot.policyHash;
  
  // If no decision token hash provided, try to extract from audit chain
  let tokenPolicyHash = decisionTokenPolicyHash ?? null;
  
  if (!tokenPolicyHash) {
    // Look for policy_snapshot_hash in decision events
    const decisionEvent = pack.components.auditChain.events.find(
      e => e.eventType === "risk.decision" || 
           e.eventType === "order.authorized" || 
           e.eventType === "order.blocked"
    );
    
    if (decisionEvent?.payload) {
      const payload = decisionEvent.payload as any;
      tokenPolicyHash = payload.decision_token?.payload?.policy_snapshot_hash ?? 
                        payload.policy_snapshot_hash ?? null;
    }
  }
  
  if (!tokenPolicyHash) {
    return {
      consistent: false,
      packPolicyHash,
      tokenPolicyHash: null,
      error: "No policy_snapshot_hash found in decision token or audit chain"
    };
  }
  
  // The decision token uses a truncated hash (16 chars), so compare prefixes
  const packHashPrefix = packPolicyHash.slice(0, 16);
  const tokenHashPrefix = tokenPolicyHash.slice(0, 16);
  
  const consistent = packHashPrefix === tokenHashPrefix;
  
  return {
    consistent,
    packPolicyHash,
    tokenPolicyHash,
    error: consistent ? undefined : `Policy hash mismatch: pack=${packHashPrefix}, token=${tokenHashPrefix}`
  };
}

/**
 * Serialize Evidence Pack to JSON (for storage/transmission)
 */
export function serializeEvidencePack(pack: EvidencePackV1): string {
  return JSON.stringify(pack, null, 2);
}

/**
 * Deserialize Evidence Pack from JSON
 */
export function deserializeEvidencePack(json: string): EvidencePackV1 {
  return JSON.parse(json) as EvidencePackV1;
}

/**
 * Extract Policy Snapshot from trace bundle
 */
export function extractPolicySnapshot(
  traceBundle: any,
  policyContent: string
): PolicySnapshotComponent {
  return {
    policyVersion: traceBundle.summary?.policyVersion ?? "unknown",
    policyContent,
    policyHash: createHash("sha256").update(policyContent).digest("hex"),
    loadedAt: traceBundle.summary?.firstEvent ?? new Date().toISOString()
  };
}

/**
 * Extract Decision from trace bundle
 */
export function extractDecision(traceBundle: any): DecisionComponent {
  const riskDecisionEvent = traceBundle.events?.find(
    (e: any) => e.eventType === "risk.decision"
  );
  
  const orderRequestedEvent = traceBundle.events?.find(
    (e: any) => e.eventType === "order.requested"
  );
  
  const authorizedEvent = traceBundle.events?.find(
    (e: any) => e.eventType === "order.authorized" || e.eventType === "order.accepted"
  );
  
  return {
    traceId: traceBundle.traceId,
    timestamp: riskDecisionEvent?.timestamp ?? new Date().toISOString(),
    input: {
      order: traceBundle.summary?.order ?? orderRequestedEvent?.payload?.raw ?? {}
    },
    output: {
      decision: traceBundle.summary?.decision ?? "BLOCK",
      reasonCode: traceBundle.summary?.reasonCode ?? "UNKNOWN",
      ruleId: traceBundle.summary?.ruleId,
      policyVersion: traceBundle.summary?.policyVersion ?? "unknown"
    },
    decisionToken: traceBundle.summary?.decisionSignature ? {
      signature: traceBundle.summary.decisionSignature,
      issuedAt: authorizedEvent?.timestamp ?? new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300000).toISOString() // 5 min from issue
    } : undefined
  };
}

/**
 * Extract Audit Chain from trace bundle
 */
export function extractAuditChain(traceBundle: any): AuditChainComponent {
  const events: AuditEvent[] = (traceBundle.events ?? []).map((e: any, i: number) => ({
    seq: i + 1,
    eventType: e.eventType,
    eventVersion: e.eventVersion ?? "v1",
    timestamp: e.timestamp ?? e.createdAt,
    payload: e.payload,
    prevHash: e.prevHash,
    hash: e.hash
  }));
  
  return {
    traceId: traceBundle.traceId,
    events,
    chainIntegrity: {
      isValid: traceBundle.summary?.hashChainValid ?? false,
      verifiedAt: new Date().toISOString(),
      firstHash: events[0]?.hash ?? "",
      lastHash: events[events.length - 1]?.hash ?? "",
      eventCount: events.length
    }
  };
}

/**
 * Extract Operator Identity from trace bundle
 */
export function extractOperatorIdentity(traceBundle: any): OperatorIdentityComponent | undefined {
  const operators: OperatorIdentityComponent["operators"] = [];
  
  for (const event of traceBundle.events ?? []) {
    if (event.eventType === "override.requested") {
      operators.push({
        role: "requester",
        operatorId: event.payload?.requestedBy ?? "unknown",
        action: "requested_override",
        timestamp: event.timestamp ?? event.createdAt,
        source: "override.requested"
      });
    }
    if (event.eventType === "override.approved") {
      operators.push({
        role: "approver",
        operatorId: event.payload?.approvedBy ?? "unknown",
        action: "approved_override",
        timestamp: event.timestamp ?? event.createdAt,
        source: "override.approved"
      });
    }
    if (event.eventType === "override.rejected") {
      operators.push({
        role: "approver",
        operatorId: event.payload?.rejectedBy ?? "unknown",
        action: "rejected_override",
        timestamp: event.timestamp ?? event.createdAt,
        source: "override.rejected"
      });
    }
  }
  
  if (operators.length === 0) {
    // System decision, no operators involved
    operators.push({
      role: "system",
      operatorId: "brokerops-risk-gate",
      action: "automated_decision",
      timestamp: traceBundle.summary?.firstEvent ?? new Date().toISOString(),
      source: "risk.decision"
    });
  }
  
  // Check dual control - different requester and approver
  const requester = operators.find(o => o.role === "requester");
  const approver = operators.find(o => o.role === "approver");
  const dualControlVerified = 
    !requester || 
    !approver || 
    requester.operatorId !== approver.operatorId;
  
  return {
    traceId: traceBundle.traceId,
    operators,
    dualControlVerified
  };
}
