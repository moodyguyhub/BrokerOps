/**
 * Decision Token - Cryptographic proof of BrokerOps authorization decision
 * 
 * The Decision Token is the core output of the Gate. It provides:
 * 1. Verifiable proof that a decision was made by BrokerOps
 * 2. Audit trail linkage via trace_id
 * 3. Policy context for reproducibility
 * 4. Expiration to prevent stale authorization
 * 5. Order binding via order_digest (prevents execution of modified orders)
 */

import { createHmac, createHash, randomBytes } from "crypto";

// Token validity window (5 minutes default)
const DEFAULT_EXPIRY_SECONDS = 300;

// In production, this would be loaded from secure key management (HSM/Vault)
// For MVP, we use a deterministic key derived from environment
const SIGNING_KEY = process.env.DECISION_TOKEN_KEY ?? "brokerops-dev-signing-key-v1";

/**
 * Order fields used for digest computation
 * See docs/specs/ORDER_DIGEST.md for full specification
 */
export interface OrderDigestInput {
  client_order_id: string;
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  price?: number | null;
}

/**
 * Compute canonical order digest (SHA-256)
 * 
 * Canonical format: {client_order_id}|{SYMBOL}|{SIDE}|{qty}|{price}
 * - symbol: UPPERCASE
 * - side: UPPERCASE  
 * - qty: integer
 * - price: 8 decimal places or "null" if absent
 */
export function computeOrderDigest(order: OrderDigestInput): string {
  const normalizedSymbol = order.symbol.trim().toUpperCase();
  const normalizedSide = order.side.toUpperCase();
  const normalizedQty = Math.floor(order.qty);
  const normalizedPrice = order.price != null 
    ? order.price.toFixed(8) 
    : "null";
  
  const canonical = [
    order.client_order_id.trim(),
    normalizedSymbol,
    normalizedSide,
    normalizedQty.toString(),
    normalizedPrice
  ].join("|");
  
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Verify that an order matches a token's order_digest
 * Returns true if the order is the same one that was authorized
 */
export function verifyOrderDigest(order: OrderDigestInput, expectedDigest: string): {
  valid: boolean;
  computedDigest: string;
  reason?: string;
} {
  const computedDigest = computeOrderDigest(order);
  
  if (computedDigest === expectedDigest) {
    return { valid: true, computedDigest };
  }
  
  return { 
    valid: false, 
    computedDigest,
    reason: "ORDER_DIGEST_MISMATCH" 
  };
}

export interface DecisionTokenPayload {
  /** Unique trace identifier linking to audit chain */
  trace_id: string;
  /** Authorization decision: AUTHORIZED or BLOCKED */
  decision: "AUTHORIZED" | "BLOCKED";
  /** Human-readable reason code */
  reason_code: string;
  /** Rule IDs that fired (for BLOCK) or allowed (for AUTHORIZED) */
  rule_ids: string[];
  /** SHA-256 hash of the policy snapshot used for decision */
  policy_snapshot_hash: string;
  /** ISO timestamp when token was issued */
  issued_at: string;
  /** ISO timestamp when token expires */
  expires_at: string;
  /** Random nonce to prevent replay */
  nonce: string;
  /** Subject identifier (client/account) */
  subject: string;
  /** Audience (platform/adapter receiving this token) */
  audience: string;
  /** Order details for audit correlation */
  order: {
    symbol: string;
    side: "BUY" | "SELL";
    qty: number;
    price?: number;
    client_order_id: string;
  };
  /** Projected exposure at decision time */
  projected_exposure?: number;
  /** 
   * SHA-256 hash of canonical order content.
   * Execution platform MUST verify this matches the order being executed.
   * See docs/specs/ORDER_DIGEST.md
   */
  order_digest: string;
  /** Version of the order digest algorithm */
  order_digest_version: "v1";
}

export interface DecisionToken {
  /** The token payload */
  payload: DecisionTokenPayload;
  /** HMAC-SHA256 signature of the canonical payload */
  signature: string;
  /** Token version for future compatibility */
  version: "v1";
}

/**
 * Generate a canonical JSON string for consistent hashing
 */
function canonicalize(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as object).sort());
}

/**
 * Sign a payload using HMAC-SHA256
 */
function sign(payload: DecisionTokenPayload): string {
  const canonical = canonicalize(payload);
  return createHmac("sha256", SIGNING_KEY)
    .update(canonical)
    .digest("hex");
}

/**
 * Issue a new Decision Token
 */
export function issueDecisionToken(params: {
  traceId: string;
  decision: "ALLOW" | "BLOCK";
  reasonCode: string;
  ruleId?: string;
  policyVersion: string;
  order: {
    symbol: string;
    side: "BUY" | "SELL";
    qty: number;
    price?: number;
    clientOrderId: string;
  };
  subject?: string;
  audience?: string;
  expirySeconds?: number;
  projectedExposure?: number;
}): DecisionToken {
  const now = new Date();
  const expiry = new Date(now.getTime() + (params.expirySeconds ?? DEFAULT_EXPIRY_SECONDS) * 1000);
  
  // Map internal decision to token decision
  const tokenDecision: "AUTHORIZED" | "BLOCKED" = 
    params.decision === "ALLOW" ? "AUTHORIZED" : "BLOCKED";
  
  // Compute order digest for execution binding
  const orderDigest = computeOrderDigest({
    client_order_id: params.order.clientOrderId,
    symbol: params.order.symbol,
    side: params.order.side,
    qty: params.order.qty,
    price: params.order.price
  });
  
  const payload: DecisionTokenPayload = {
    trace_id: params.traceId,
    decision: tokenDecision,
    reason_code: params.reasonCode,
    rule_ids: params.ruleId ? [params.ruleId] : [],
    policy_snapshot_hash: createHmac("sha256", "policy")
      .update(params.policyVersion)
      .digest("hex")
      .slice(0, 16),
    issued_at: now.toISOString(),
    expires_at: expiry.toISOString(),
    nonce: randomBytes(16).toString("hex"),
    subject: params.subject ?? "default-client",
    audience: params.audience ?? "trading-platform",
    order: {
      symbol: params.order.symbol,
      side: params.order.side,
      qty: params.order.qty,
      price: params.order.price,
      client_order_id: params.order.clientOrderId
    },
    projected_exposure: params.projectedExposure,
    order_digest: orderDigest,
    order_digest_version: "v1"
  };
  
  return {
    payload,
    signature: sign(payload),
    version: "v1"
  };
}

/**
 * Verify a Decision Token signature
 * Returns true if valid, false if tampered or expired
 */
export function verifyDecisionToken(token: DecisionToken): {
  valid: boolean;
  reason?: string;
} {
  // Check expiration
  const now = new Date();
  const expiresAt = new Date(token.payload.expires_at);
  if (now > expiresAt) {
    return { valid: false, reason: "TOKEN_EXPIRED" };
  }
  
  // Verify signature
  const expectedSignature = sign(token.payload);
  if (token.signature !== expectedSignature) {
    return { valid: false, reason: "INVALID_SIGNATURE" };
  }
  
  return { valid: true };
}

/**
 * Extract a compact signature for API responses
 * This is the `decision_signature` field that downstream systems attach to execution logs
 */
export function getCompactSignature(token: DecisionToken): string {
  return `${token.version}:${token.payload.trace_id.slice(0, 8)}:${token.signature.slice(0, 32)}`;
}
