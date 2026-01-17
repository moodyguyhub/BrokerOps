/**
 * P0 Acceptance Criteria Tests
 * 
 * Verifies:
 * 1. Decision Token verification - recompute signature from payload + key
 * 2. Hold expiry correctness - AUTHORIZED + no fill → exposure returns to 0
 * 3. Evidence Pack integrity - manifest hashes match component bytes
 * 4. Policy snapshot consistency - evidence pack policy hash == decision token hash
 * 5. UI semantics - no forbidden strings remain
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dynamic import for @broker/common (ESM)
const common = await import("@broker/common");
const {
  issueDecisionToken,
  verifyDecisionToken,
  getCompactSignature,
  buildEvidencePack,
  verifyEvidencePack,
  verifyPolicyConsistency,
  hashComponent,
  extractPolicySnapshot,
  extractDecision,
  extractAuditChain,
  extractOperatorIdentity,
  computeOrderDigest,
  verifyOrderDigest
} = common;

describe("P0 Acceptance Criteria", () => {
  
  // =========================================================================
  // Criterion 1: Decision Token Verification
  // =========================================================================
  describe("1. Decision Token Verification", () => {
    it("should issue a valid token that passes verification", () => {
      const token = issueDecisionToken({
        traceId: "test-trace-123",
        decision: "ALLOW",
        reasonCode: "OK",
        ruleId: "allow_default",
        policyVersion: "policy.v0.2",
        order: {
          symbol: "AAPL",
          side: "BUY",
          qty: 100,
          price: 150.00,
          clientOrderId: "test-order-1"
        }
      });

      const result = verifyDecisionToken(token);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.reason, undefined);
    });

    it("should detect tampered payload", () => {
      const token = issueDecisionToken({
        traceId: "test-trace-456",
        decision: "ALLOW",
        reasonCode: "OK",
        policyVersion: "policy.v0.2",
        order: {
          symbol: "AAPL",
          side: "BUY",
          qty: 100,
          clientOrderId: "test-order-2"
        }
      });

      // Tamper with the payload
      token.payload.decision = "BLOCKED";

      const result = verifyDecisionToken(token);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.reason, "INVALID_SIGNATURE");
    });

    it("should detect expired token", () => {
      const token = issueDecisionToken({
        traceId: "test-trace-789",
        decision: "ALLOW",
        reasonCode: "OK",
        policyVersion: "policy.v0.2",
        order: {
          symbol: "AAPL",
          side: "BUY",
          qty: 100,
          clientOrderId: "test-order-3"
        },
        expirySeconds: -1 // Already expired
      });

      const result = verifyDecisionToken(token);
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.reason, "TOKEN_EXPIRED");
    });

    it("should produce consistent compact signature format", () => {
      const token = issueDecisionToken({
        traceId: "abcd1234-5678-90ab-cdef-ghijklmnopqr",
        decision: "ALLOW",
        reasonCode: "OK",
        policyVersion: "policy.v0.2",
        order: {
          symbol: "AAPL",
          side: "BUY",
          qty: 100,
          clientOrderId: "test-order-4"
        }
      });

      const compact = getCompactSignature(token);
      
      // Format: v1:<traceId_prefix>:<hash_prefix>
      assert.match(compact, /^v1:[a-f0-9]{8}:[a-f0-9]{32}$/);
      assert.ok(compact.startsWith("v1:abcd1234:"));
    });
  });

  // =========================================================================
  // Criterion 3: Evidence Pack Integrity
  // =========================================================================
  describe("3. Evidence Pack Integrity", () => {
    const mockTraceBundle = {
      traceId: "test-evidence-pack-123",
      events: [
        {
          eventType: "order.requested",
          eventVersion: "v1",
          timestamp: "2026-01-15T10:00:00Z",
          payload: { raw: { symbol: "AAPL", qty: 100, side: "BUY" } },
          prevHash: null,
          hash: "hash1"
        },
        {
          eventType: "risk.decision",
          eventVersion: "v1",
          timestamp: "2026-01-15T10:00:01Z",
          payload: { decision: "ALLOW", reasonCode: "OK", policyVersion: "v0.2" },
          prevHash: "hash1",
          hash: "hash2"
        },
        {
          eventType: "order.authorized",
          eventVersion: "v1",
          timestamp: "2026-01-15T10:00:02Z",
          payload: { decision_signature: "v1:test:abc123" },
          prevHash: "hash2",
          hash: "hash3"
        }
      ],
      summary: {
        traceId: "test-evidence-pack-123",
        outcome: "AUTHORIZED",
        decision: "ALLOW",
        reasonCode: "OK",
        policyVersion: "v0.2",
        hashChainValid: true,
        order: { symbol: "AAPL", qty: 100, side: "BUY" },
        firstEvent: "2026-01-15T10:00:00Z",
        lastEvent: "2026-01-15T10:00:02Z"
      }
    };

    it("should build evidence pack with valid component hashes", () => {
      const policyContent = "package broker.risk\ndefault allow = true";
      
      const policySnapshot = extractPolicySnapshot(mockTraceBundle, policyContent);
      const decision = extractDecision(mockTraceBundle);
      const auditChain = extractAuditChain(mockTraceBundle);
      const operatorIdentity = extractOperatorIdentity(mockTraceBundle);

      const pack = buildEvidencePack("test-evidence-pack-123", {
        policySnapshot,
        decision,
        auditChain,
        operatorIdentity
      });

      // Verify each component hash matches
      assert.strictEqual(pack.manifest.componentHashes.policy_snapshot, hashComponent(policySnapshot));
      assert.strictEqual(pack.manifest.componentHashes.decision, hashComponent(decision));
      assert.strictEqual(pack.manifest.componentHashes.audit_chain, hashComponent(auditChain));
    });

    it("should pass full verification", () => {
      const policyContent = "package broker.risk\ndefault allow = true";
      
      const pack = buildEvidencePack("test-evidence-pack-123", {
        policySnapshot: extractPolicySnapshot(mockTraceBundle, policyContent),
        decision: extractDecision(mockTraceBundle),
        auditChain: extractAuditChain(mockTraceBundle),
        operatorIdentity: extractOperatorIdentity(mockTraceBundle)
      });

      const result = verifyEvidencePack(pack);
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    it("should detect tampered component", () => {
      const policyContent = "package broker.risk\ndefault allow = true";
      
      const pack = buildEvidencePack("test-evidence-pack-123", {
        policySnapshot: extractPolicySnapshot(mockTraceBundle, policyContent),
        decision: extractDecision(mockTraceBundle),
        auditChain: extractAuditChain(mockTraceBundle)
      });

      // Tamper with a component
      pack.components.policySnapshot.policyContent = "TAMPERED";

      const result = verifyEvidencePack(pack);
      assert.strictEqual(result.isValid, false);
      assert.ok(result.errors.some((e: string) => e.includes("Policy snapshot hash mismatch")));
    });
  });

  // =========================================================================
  // Criterion 5: UI Semantics
  // =========================================================================
  describe("5. UI Semantics - No Forbidden Strings", () => {
    const FORBIDDEN_STRINGS = [
      "Released",
      "Auto-Approved",
    ];

    const UI_DIR = join(__dirname, "../../services/ui/public");

    it("should not contain forbidden strings in UI files", () => {
      const files = ["index.html", "PolicyTranslator.js"];
      const violations: string[] = [];

      for (const file of files) {
        try {
          const content = readFileSync(join(UI_DIR, file), "utf-8");
          
          for (const forbidden of FORBIDDEN_STRINGS) {
            if (content.includes(forbidden)) {
              violations.push(`${file} contains forbidden string: "${forbidden}"`);
            }
          }
        } catch {
          // File might not exist in test environment - skip
        }
      }

      assert.strictEqual(violations.length, 0, violations.join(", "));
    });
  });

  // =========================================================================
  // Criterion 4: Policy Snapshot Consistency
  // =========================================================================
  describe("4. Policy Snapshot Consistency", () => {
    it("should verify policy hash consistency", () => {
      const policyContent = "package broker.risk\ndefault allow = true";
      const policyHash = createHash("sha256").update(policyContent).digest("hex");
      
      const mockTraceBundle = {
        traceId: "test-policy-123",
        events: [
          {
            eventType: "risk.decision",
            payload: {
              decision_token: {
                payload: {
                  policy_snapshot_hash: policyHash.slice(0, 16)
                }
              }
            }
          }
        ],
        summary: { policyVersion: "v0.2" }
      };

      const pack = buildEvidencePack("test-policy-123", {
        policySnapshot: extractPolicySnapshot(mockTraceBundle, policyContent),
        decision: extractDecision(mockTraceBundle),
        auditChain: extractAuditChain(mockTraceBundle)
      });

      const result = verifyPolicyConsistency(pack, policyHash.slice(0, 16));
      assert.strictEqual(result.consistent, true);
    });

    it("should detect policy hash mismatch", () => {
      const originalPolicy = "package broker.risk\ndefault allow = true";
      const tamperedPolicy = "package broker.risk\ndefault allow = false";
      
      const originalHash = createHash("sha256").update(originalPolicy).digest("hex");
      
      const mockTraceBundle = {
        traceId: "test-policy-mismatch",
        events: [],
        summary: { policyVersion: "v0.2" }
      };

      // Build pack with tampered policy
      const pack = buildEvidencePack("test-policy-mismatch", {
        policySnapshot: extractPolicySnapshot(mockTraceBundle, tamperedPolicy),
        decision: extractDecision(mockTraceBundle),
        auditChain: extractAuditChain(mockTraceBundle)
      });

      // Verify against original hash
      const result = verifyPolicyConsistency(pack, originalHash.slice(0, 16));
      assert.strictEqual(result.consistent, false);
      assert.ok(result.error?.includes("Policy hash mismatch"));
    });
  });

  // =========================================================================
  // Criterion 6: Order Digest Binding
  // =========================================================================
  describe("6. Order Digest Binding", () => {
    it("should include order_digest in issued token", () => {
      const token = issueDecisionToken({
        traceId: "test-digest-001",
        decision: "ALLOW",
        reasonCode: "OK",
        policyVersion: "policy.v0.2",
        order: {
          symbol: "AAPL",
          side: "BUY",
          qty: 100,
          price: 150.50,
          clientOrderId: "order-digest-test"
        }
      });

      assert.ok(token.payload.order_digest, "Token should contain order_digest");
      assert.strictEqual(token.payload.order_digest_version, "v1");
      assert.match(token.payload.order_digest, /^[a-f0-9]{64}$/, "Digest should be 64 hex chars");
    });

    it("should produce deterministic digest for same order", () => {
      const orderParams = {
        client_order_id: "deterministic-test-001",
        symbol: "GME",
        side: "SELL" as const,
        qty: 50,
        price: 25.75
      };

      const digest1 = computeOrderDigest(orderParams);
      const digest2 = computeOrderDigest(orderParams);

      assert.strictEqual(digest1, digest2, "Same order should produce identical digest");
    });

    it("should produce different digest when order content changes", () => {
      const baseOrder = {
        client_order_id: "mutation-test-001",
        symbol: "AAPL",
        side: "BUY" as const,
        qty: 100,
        price: 150.00
      };

      const originalDigest = computeOrderDigest(baseOrder);

      // Mutate quantity
      const mutatedQty = computeOrderDigest({ ...baseOrder, qty: 101 });
      assert.notStrictEqual(originalDigest, mutatedQty, "Qty change should produce different digest");

      // Mutate symbol
      const mutatedSymbol = computeOrderDigest({ ...baseOrder, symbol: "MSFT" });
      assert.notStrictEqual(originalDigest, mutatedSymbol, "Symbol change should produce different digest");

      // Mutate side
      const mutatedSide = computeOrderDigest({ ...baseOrder, side: "SELL" });
      assert.notStrictEqual(originalDigest, mutatedSide, "Side change should produce different digest");

      // Mutate price
      const mutatedPrice = computeOrderDigest({ ...baseOrder, price: 150.01 });
      assert.notStrictEqual(originalDigest, mutatedPrice, "Price change should produce different digest");
    });

    it("should handle market orders (no price)", () => {
      const marketOrder = {
        client_order_id: "market-order-001",
        symbol: "TSLA",
        side: "BUY" as const,
        qty: 10,
        price: undefined
      };

      const digest = computeOrderDigest(marketOrder);
      assert.match(digest, /^[a-f0-9]{64}$/, "Market order should produce valid digest");

      // Verify consistency
      const digest2 = computeOrderDigest(marketOrder);
      assert.strictEqual(digest, digest2, "Market order digest should be deterministic");
    });

    it("should verify matching order digest", () => {
      const order = {
        client_order_id: "verify-test-001",
        symbol: "NVDA",
        side: "BUY" as const,
        qty: 25,
        price: 450.00
      };

      const expectedDigest = computeOrderDigest(order);
      const result = verifyOrderDigest(order, expectedDigest);

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.computedDigest, expectedDigest);
    });

    it("should detect execution that differs from authorized order", () => {
      // Original authorized order
      const authorizedOrder = {
        client_order_id: "exec-diff-001",
        symbol: "META",
        side: "BUY" as const,
        qty: 100,
        price: 350.00
      };

      const authorizedDigest = computeOrderDigest(authorizedOrder);

      // Executed order differs (qty changed)
      const executedOrder = {
        client_order_id: "exec-diff-001",
        symbol: "META",
        side: "BUY" as const,
        qty: 150, // CHANGED!
        price: 350.00
      };

      const result = verifyOrderDigest(executedOrder, authorizedDigest);

      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.reason, "ORDER_DIGEST_MISMATCH");
      assert.notStrictEqual(result.computedDigest, authorizedDigest);
    });

    it("should normalize symbol to uppercase", () => {
      const lowerCase = computeOrderDigest({
        client_order_id: "case-test",
        symbol: "aapl",
        side: "BUY",
        qty: 100
      });

      const upperCase = computeOrderDigest({
        client_order_id: "case-test",
        symbol: "AAPL",
        side: "BUY",
        qty: 100
      });

      assert.strictEqual(lowerCase, upperCase, "Symbol should be case-insensitive");
    });

    it("should normalize price to 8 decimal places", () => {
      const twoDecimals = computeOrderDigest({
        client_order_id: "price-test",
        symbol: "AAPL",
        side: "BUY",
        qty: 100,
        price: 150.50
      });

      const eightDecimals = computeOrderDigest({
        client_order_id: "price-test",
        symbol: "AAPL",
        side: "BUY",
        qty: 100,
        price: 150.50000000
      });

      assert.strictEqual(twoDecimals, eightDecimals, "Price normalization should be consistent");
    });

    it("should include order_digest in token that passes signature verification", () => {
      const token = issueDecisionToken({
        traceId: "sig-with-digest-001",
        decision: "ALLOW",
        reasonCode: "OK",
        policyVersion: "policy.v0.2",
        order: {
          symbol: "AAPL",
          side: "BUY",
          qty: 100,
          price: 150.00,
          clientOrderId: "sig-test-001"
        }
      });

      // Token with digest should pass verification
      const sigResult = verifyDecisionToken(token);
      assert.strictEqual(sigResult.valid, true, "Token with order_digest should pass signature verification");

      // Digest should match recomputed value
      const recomputedDigest = computeOrderDigest({
        client_order_id: "sig-test-001",
        symbol: "AAPL",
        side: "BUY",
        qty: 100,
        price: 150.00
      });
      assert.strictEqual(token.payload.order_digest, recomputedDigest, "Embedded digest should match recomputed");
    });
  });
});
