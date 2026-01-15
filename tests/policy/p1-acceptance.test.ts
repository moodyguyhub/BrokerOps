/**
 * P1 Acceptance Criteria Tests - Snapshot Economics
 * 
 * Verifies:
 * 1. Every AUTHORIZED decision includes SnapshotEconomics with projected_exposure_delta
 * 2. Every BLOCKED decision includes SnapshotEconomics with saved_exposure
 * 3. Price source is explicitly encoded (FIRM, INDICATIVE, UNAVAILABLE)
 * 4. Economics component is hashable and stable
 * 5. Market orders (no price) set price_unavailable=true, notional=null
 */

import { describe, it } from "node:test";
import assert from "node:assert";

// Dynamic import for @broker/common
const common = await import("@broker/common");
const { 
  computeSnapshotEconomics, 
  aggregateSavedExposure,
  verifySnapshotDeterminism,
  hashComponent
} = common;

describe("P1 Acceptance Criteria - Snapshot Economics", () => {
  
  describe("1. AUTHORIZED decisions include projected_exposure_delta", () => {
    it("should compute projected_exposure_delta for ALLOW decision with price", () => {
      const result = computeSnapshotEconomics({
        qty: 100,
        price: 150.00,
        decision: "ALLOW",
        exposure_pre: 50000
      });
      
      const e = result.economics;
      assert.strictEqual(e.decision_time_price, 150.00);
      assert.strictEqual(e.qty, 100);
      assert.strictEqual(e.notional, 15000);
      assert.strictEqual(e.projected_exposure_delta, 15000);
      assert.strictEqual(e.saved_exposure, null);
      assert.strictEqual(e.exposure_pre, 50000);
      assert.strictEqual(e.exposure_post, 65000); // pre + notional
      assert.strictEqual(e.currency, "USD");
    });

    it("should set exposure_post = exposure_pre + notional for ALLOW", () => {
      const result = computeSnapshotEconomics({
        qty: 50,
        price: 200.00,
        decision: "ALLOW",
        exposure_pre: 100000
      });
      
      assert.strictEqual(result.economics.exposure_post, 110000);
    });
  });

  describe("2. BLOCKED decisions include saved_exposure", () => {
    it("should compute saved_exposure for BLOCK decision", () => {
      const result = computeSnapshotEconomics({
        qty: 1000,
        price: 150.00,
        decision: "BLOCK",
        exposure_pre: 50000
      });
      
      const e = result.economics;
      assert.strictEqual(e.notional, 150000);
      assert.strictEqual(e.saved_exposure, 150000); // Full notional
      assert.strictEqual(e.projected_exposure_delta, null);
      assert.strictEqual(e.exposure_post, null); // No change for blocked
    });

    it("should not modify exposure for BLOCKED decisions", () => {
      const result = computeSnapshotEconomics({
        qty: 500,
        price: 100.00,
        decision: "BLOCK",
        exposure_pre: 75000
      });
      
      assert.strictEqual(result.economics.exposure_pre, 75000);
      assert.strictEqual(result.economics.exposure_post, null);
    });
  });

  describe("3. Price source is explicitly encoded", () => {
    it("should set FIRM for limit order with explicit price", () => {
      const result = computeSnapshotEconomics({
        qty: 100,
        price: 150.00,
        decision: "ALLOW"
      });
      
      assert.strictEqual(result.economics.price_source, "FIRM");
      assert.strictEqual(result.economics.price_unavailable, false);
    });

    it("should set INDICATIVE for reference price", () => {
      const result = computeSnapshotEconomics({
        qty: 100,
        price: null,
        referencePrice: 149.50,
        decision: "ALLOW"
      });
      
      assert.strictEqual(result.economics.price_source, "INDICATIVE");
      assert.strictEqual(result.economics.decision_time_price, 149.50);
      assert.strictEqual(result.economics.price_unavailable, false);
    });

    it("should set UNAVAILABLE for market order without price", () => {
      const result = computeSnapshotEconomics({
        qty: 100,
        price: null,
        decision: "ALLOW"
      });
      
      assert.strictEqual(result.economics.price_source, "UNAVAILABLE");
      assert.strictEqual(result.economics.price_unavailable, true);
      assert.strictEqual(result.economics.decision_time_price, null);
    });
  });

  describe("4. Economics component is hashable and stable", () => {
    it("should produce consistent hash for same economics", () => {
      const economics1 = computeSnapshotEconomics({
        qty: 100,
        price: 150.00,
        decision: "BLOCK",
        decision_time: "2026-01-15T12:00:00.000Z"
      });
      
      const economics2 = computeSnapshotEconomics({
        qty: 100,
        price: 150.00,
        decision: "BLOCK",
        decision_time: "2026-01-15T12:00:00.000Z"
      });
      
      const hash1 = hashComponent(economics1.economics);
      const hash2 = hashComponent(economics2.economics);
      
      assert.strictEqual(hash1, hash2);
    });

    it("should produce different hash for different economics", () => {
      const economics1 = computeSnapshotEconomics({
        qty: 100,
        price: 150.00,
        decision: "BLOCK"
      });
      
      const economics2 = computeSnapshotEconomics({
        qty: 100,
        price: 151.00, // Different price
        decision: "BLOCK"
      });
      
      const hash1 = hashComponent(economics1.economics);
      const hash2 = hashComponent(economics2.economics);
      
      assert.notStrictEqual(hash1, hash2);
    });
  });

  describe("5. Market orders set price_unavailable=true, notional=null", () => {
    it("should handle market order with no price", () => {
      const result = computeSnapshotEconomics({
        qty: 100,
        price: undefined,
        decision: "ALLOW"
      });
      
      assert.strictEqual(result.economics.price_unavailable, true);
      assert.strictEqual(result.economics.notional, null);
      assert.strictEqual(result.economics.projected_exposure_delta, null);
    });

    it("should handle zero price as unavailable", () => {
      const result = computeSnapshotEconomics({
        qty: 100,
        price: 0,
        decision: "BLOCK"
      });
      
      assert.strictEqual(result.economics.price_unavailable, true);
      assert.strictEqual(result.economics.saved_exposure, null);
    });
  });

  describe("6. Aggregate saved exposure calculation", () => {
    it("should sum saved_exposure across multiple blocked decisions", () => {
      const blocked1 = computeSnapshotEconomics({
        qty: 100,
        price: 150.00,
        decision: "BLOCK"
      }).economics;
      
      const blocked2 = computeSnapshotEconomics({
        qty: 50,
        price: 200.00,
        decision: "BLOCK"
      }).economics;
      
      const blocked3 = computeSnapshotEconomics({
        qty: 200,
        price: 100.00,
        decision: "BLOCK"
      }).economics;
      
      const total = aggregateSavedExposure([blocked1, blocked2, blocked3]);
      
      // 15000 + 10000 + 20000 = 45000
      assert.strictEqual(total.saved_exposure, 45000);
    });

    it("should handle empty array", () => {
      const total = aggregateSavedExposure([]);
      assert.strictEqual(total.saved_exposure, 0);
    });

    it("should handle null saved_exposure values", () => {
      const blockedNoPrice = computeSnapshotEconomics({
        qty: 100,
        price: null,
        decision: "BLOCK"
      }).economics;
      
      const blockedWithPrice = computeSnapshotEconomics({
        qty: 100,
        price: 100.00,
        decision: "BLOCK"
      }).economics;
      
      const total = aggregateSavedExposure([blockedNoPrice, blockedWithPrice]);
      assert.strictEqual(total.saved_exposure, 10000); // Only the one with price
    });
  });

  describe("7. Determinism verification", () => {
    it("should verify recomputed values match stored", () => {
      const input = {
        qty: 100,
        price: 150.00,
        decision: "BLOCK" as const,
        decision_time: "2026-01-15T12:00:00.000Z"
      };
      
      const stored = computeSnapshotEconomics(input).economics;
      
      const isValid = verifySnapshotDeterminism(stored, input);
      assert.strictEqual(isValid, true);
    });

    it("should detect mismatched values", () => {
      const stored = computeSnapshotEconomics({
        qty: 100,
        price: 150.00,
        decision: "BLOCK" as const
      }).economics;
      
      // Tamper with stored value
      stored.saved_exposure = 999999;
      
      const isValid = verifySnapshotDeterminism(stored, {
        qty: 100,
        price: 150.00,
        decision: "BLOCK"
      });
      
      assert.strictEqual(isValid, false);
    });
  });

  describe("8. Currency is USD only for P1", () => {
    it("should always set currency to USD", () => {
      const result = computeSnapshotEconomics({
        qty: 100,
        price: 150.00,
        decision: "ALLOW"
      });
      
      assert.strictEqual(result.economics.currency, "USD");
    });
  });

  describe("9. Policy context is included when provided", () => {
    it("should include policy context in result", () => {
      const result = computeSnapshotEconomics({
        qty: 5000,
        price: 150.00,
        decision: "BLOCK",
        policy_context: {
          limit_type: "QTY_LIMIT_EXCEEDED",
          limit_value: 1000,
          current_value: 5000
        }
      });
      
      assert.ok(result.policy_context);
      assert.strictEqual(result.policy_context.limit_type, "QTY_LIMIT_EXCEEDED");
      assert.strictEqual(result.policy_context.limit_value, 1000);
    });
  });
});

/**
 * P1 Hardening Tests - Price Trust & Currency Validation
 * 
 * Verifies:
 * 1. P1-R1: Price assertion fields present when price provided with assertion metadata
 * 2. P1-R2: Coverage stats computed correctly
 * 3. P1-R3: Currency validation warns on non-USD
 * 4. Non-USD excluded from saved exposure aggregation
 */
describe("P1 Hardening - Price Trust & Currency Validation", () => {
  
  const { validateCurrency, computeCoverageStats } = common;

  describe("P1-R1: Price Trust Boundary", () => {
    it("should include price_asserted_by when provided", () => {
      const result = computeSnapshotEconomics({
        qty: 100,
        price: 150.00,
        decision: "BLOCK",
        price_asserted_by: "MARKET_DATA_SERVICE",
        price_asserted_at: "2026-01-15T12:00:00.000Z"
      });
      
      assert.strictEqual(result.economics.price_asserted_by, "MARKET_DATA_SERVICE");
      assert.strictEqual(result.economics.price_asserted_at, "2026-01-15T12:00:00.000Z");
    });

    it("should include price_signature when provided", () => {
      const result = computeSnapshotEconomics({
        qty: 100,
        price: 150.00,
        decision: "ALLOW",
        price_asserted_by: "BLOOMBERG",
        price_asserted_at: "2026-01-15T12:00:00.000Z",
        price_signature: "sha256:abc123..."
      });
      
      assert.strictEqual(result.economics.price_signature, "sha256:abc123...");
    });

    it("should leave assertion fields undefined when not provided", () => {
      const result = computeSnapshotEconomics({
        qty: 100,
        price: 150.00,
        decision: "ALLOW"
      });
      
      assert.strictEqual(result.economics.price_asserted_by, undefined);
      assert.strictEqual(result.economics.price_asserted_at, undefined);
      assert.strictEqual(result.economics.price_signature, undefined);
    });
  });

  describe("P1-R2: Coverage Statistics", () => {
    it("should compute coverage percentage correctly", () => {
      // Create proper economics objects
      const decisions = [
        computeSnapshotEconomics({ qty: 100, price: 150.00, decision: "BLOCK" }).economics,
        computeSnapshotEconomics({ qty: 100, price: 200.00, decision: "BLOCK" }).economics,
        computeSnapshotEconomics({ qty: 100, price: null, decision: "BLOCK" }).economics,
        computeSnapshotEconomics({ qty: 100, price: 175.00, decision: "BLOCK" }).economics
      ];
      
      const stats = computeCoverageStats(decisions);
      
      assert.strictEqual(stats.total_decisions, 4);
      assert.strictEqual(stats.decisions_with_price, 3);
      assert.strictEqual(stats.coverage_percent, 75);
    });

    it("should compute USD percentage", () => {
      const decisions = [
        computeSnapshotEconomics({ qty: 100, price: 150.00, decision: "BLOCK" }).economics,
        computeSnapshotEconomics({ qty: 100, price: 200.00, decision: "BLOCK", currency: "EUR" }).economics,
        computeSnapshotEconomics({ qty: 100, price: 175.00, decision: "BLOCK" }).economics
      ];
      
      const stats = computeCoverageStats(decisions);
      
      assert.strictEqual(stats.decisions_usd, 2);
      assert.strictEqual(stats.decisions_non_usd, 1);
      assert.strictEqual(stats.usd_percent, (2 / 3) * 100);
    });

    it("should handle empty decisions array", () => {
      const stats = computeCoverageStats([]);
      
      assert.strictEqual(stats.total_decisions, 0);
      assert.strictEqual(stats.decisions_with_price, 0);
      assert.strictEqual(stats.coverage_percent, 0);
    });
  });

  describe("P1-R3: Currency Validation (Warn-Only)", () => {
    it("should support USD currency", () => {
      const validation = validateCurrency("USD");
      
      assert.strictEqual(validation.supported, true);
      assert.strictEqual(validation.warning, undefined);
    });

    it("should warn on non-USD currency but not reject", () => {
      const validation = validateCurrency("EUR");
      
      assert.strictEqual(validation.supported, false);
      assert.strictEqual(validation.original_currency, "EUR");
      assert.ok(validation.warning);
      assert.ok(validation.warning.includes("EUR"));
    });

    it("should warn on GBP currency", () => {
      const validation = validateCurrency("GBP");
      
      assert.strictEqual(validation.supported, false);
      assert.ok(validation.warning);
      assert.ok(validation.warning.includes("excluded from"));
    });

    it("should include currency_validation in economics", () => {
      const result = computeSnapshotEconomics({
        qty: 100,
        price: 150.00,
        decision: "BLOCK",
        currency: "EUR"
      });
      
      assert.ok(result.economics.currency_validation);
      assert.strictEqual(result.economics.currency_validation.supported, false);
      assert.strictEqual(result.economics.currency_validation.original_currency, "EUR");
    });
  });

  describe("Non-USD Excluded from Aggregation", () => {
    it("should exclude non-USD from saved exposure aggregation", () => {
      const economics = [
        computeSnapshotEconomics({ qty: 100, price: 100.00, decision: "BLOCK" }).economics, // 10000 USD
        computeSnapshotEconomics({ qty: 100, price: 200.00, decision: "BLOCK", currency: "EUR" }).economics, // 20000 EUR - excluded
        computeSnapshotEconomics({ qty: 100, price: 150.00, decision: "BLOCK" }).economics  // 15000 USD
      ];
      
      const result = aggregateSavedExposure(economics);
      
      // Only USD should be aggregated
      assert.strictEqual(result.saved_exposure, 25000); // 10000 + 15000
      assert.strictEqual(result.excluded_count, 1);
    });

    it("should include all USD decisions", () => {
      const economics = [
        computeSnapshotEconomics({ qty: 100, price: 50.00, decision: "BLOCK" }).economics,   // 5000
        computeSnapshotEconomics({ qty: 100, price: 100.00, decision: "BLOCK" }).economics,  // 10000
        computeSnapshotEconomics({ qty: 100, price: 150.00, decision: "BLOCK" }).economics   // 15000
      ];
      
      const result = aggregateSavedExposure(economics);
      
      assert.strictEqual(result.saved_exposure, 30000);
      assert.strictEqual(result.blocked_count, 3);
    });
  });
});
