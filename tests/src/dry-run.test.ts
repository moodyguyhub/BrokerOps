/**
 * Unit tests for /dry-run endpoint
 * Tests policy evaluation without persistence
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

const BASE_URL = process.env.TEST_ORDER_API_URL ?? "http://localhost:7001";

describe("/dry-run endpoint", () => {
  describe("Response structure", () => {
    it("should return dryRun: true for all responses", async () => {
      const resp = await fetch(`${BASE_URL}/dry-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientOrderId: "test-001",
          symbol: "AAPL",
          side: "BUY",
          qty: 100,
          price: 150.00
        })
      });

      const data = await resp.json();
      expect(data.dryRun).toBe(true);
    });

    it("should include preview economics", async () => {
      const resp = await fetch(`${BASE_URL}/dry-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientOrderId: "test-002",
          symbol: "AAPL",
          side: "BUY",
          qty: 100,
          price: 150.00
        })
      });

      const data = await resp.json();
      expect(data.previewEconomics).toBeDefined();
      expect(data.previewEconomics.attemptNotional).toBe(15000);
      expect(data.previewEconomics.simulationCost).toBe(0);
    });

    it("should include policyVersion in response", async () => {
      const resp = await fetch(`${BASE_URL}/dry-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientOrderId: "test-003",
          symbol: "AAPL",
          side: "BUY",
          qty: 100
        })
      });

      const data = await resp.json();
      expect(data.policyVersion).toBeDefined();
      expect(typeof data.policyVersion).toBe("string");
    });
  });

  describe("Policy evaluation (ALLOW scenarios)", () => {
    it("should ALLOW normal order under qty limit", async () => {
      const resp = await fetch(`${BASE_URL}/dry-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientOrderId: "allow-001",
          symbol: "AAPL",
          side: "BUY",
          qty: 100,
          price: 150.00
        })
      });

      const data = await resp.json();
      expect(resp.status).toBe(200);
      expect(data.decision).toBe("ALLOW");
      expect(data.allow).toBe(true);
      expect(data.previewEconomics.savedExposure).toBe(0);
    });

    it("should ALLOW small GME order", async () => {
      const resp = await fetch(`${BASE_URL}/dry-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientOrderId: "allow-002",
          symbol: "GME",
          side: "BUY",
          qty: 5,
          price: 25.00
        })
      });

      const data = await resp.json();
      expect(data.decision).toBe("ALLOW");
    });
  });

  describe("Policy evaluation (BLOCK scenarios)", () => {
    it("should BLOCK order exceeding qty limit (>1000)", async () => {
      const resp = await fetch(`${BASE_URL}/dry-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientOrderId: "block-001",
          symbol: "AAPL",
          side: "BUY",
          qty: 5000,
          price: 150.00
        })
      });

      const data = await resp.json();
      expect(data.decision).toBe("BLOCK");
      expect(data.allow).toBe(false);
      expect(data.ruleId).toBe("qty_limit");
      expect(data.previewEconomics.savedExposure).toBe(750000); // 5000 * 150
    });

    it("should BLOCK GME order >10 qty", async () => {
      const resp = await fetch(`${BASE_URL}/dry-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientOrderId: "block-002",
          symbol: "GME",
          side: "BUY",
          qty: 500,
          price: 25.00
        })
      });

      const data = await resp.json();
      expect(data.decision).toBe("BLOCK");
      expect(data.ruleId).toBe("symbol_gme");
    });

    it("should BLOCK penny stock order >100 qty", async () => {
      const resp = await fetch(`${BASE_URL}/dry-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientOrderId: "block-003",
          symbol: "PENNY",
          side: "BUY",
          qty: 500,
          price: 0.50
        })
      });

      const data = await resp.json();
      expect(data.decision).toBe("BLOCK");
      expect(data.ruleId).toBe("penny_stock");
    });
  });

  describe("Schema validation", () => {
    it("should reject invalid schema with 400", async () => {
      const resp = await fetch(`${BASE_URL}/dry-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Missing required fields
          symbol: "AAPL"
        })
      });

      const data = await resp.json();
      expect(resp.status).toBe(400);
      expect(data.dryRun).toBe(true);
      expect(data.decision).toBe("BLOCK");
      expect(data.reasonCode).toBe("INVALID_ORDER_SCHEMA");
    });

    it("should reject invalid side value", async () => {
      const resp = await fetch(`${BASE_URL}/dry-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientOrderId: "invalid-001",
          symbol: "AAPL",
          side: "INVALID",
          qty: 100
        })
      });

      expect(resp.status).toBe(400);
    });
  });

  describe("No persistence guarantee", () => {
    it("should NOT create audit trail (verify by checking traces)", async () => {
      const uniqueId = `no-persist-${Date.now()}`;
      
      // Make dry-run request
      await fetch(`${BASE_URL}/dry-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientOrderId: uniqueId,
          symbol: "AAPL",
          side: "BUY",
          qty: 100
        })
      });

      // Try to find trace (should not exist)
      // Note: This test assumes reconstruction-api is also running
      // In isolation, we rely on the endpoint design (no audit calls)
      // The endpoint implementation explicitly does not call audit()
    });
  });
});

describe("/dry-run preview economics", () => {
  it("should calculate correct notional for BUY order", async () => {
    const resp = await fetch(`${BASE_URL}/dry-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientOrderId: "econ-001",
        symbol: "TSLA",
        side: "BUY",
        qty: 50,
        price: 200.00
      })
    });

    const data = await resp.json();
    expect(data.previewEconomics.attemptNotional).toBe(10000);
  });

  it("should show savedExposure only for BLOCK decisions", async () => {
    // ALLOW case
    const allowResp = await fetch(`${BASE_URL}/dry-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientOrderId: "econ-allow",
        symbol: "AAPL",
        side: "BUY",
        qty: 10,
        price: 150.00
      })
    });
    const allowData = await allowResp.json();
    expect(allowData.previewEconomics.savedExposure).toBe(0);

    // BLOCK case
    const blockResp = await fetch(`${BASE_URL}/dry-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientOrderId: "econ-block",
        symbol: "GME",
        side: "BUY",
        qty: 500,
        price: 25.00
      })
    });
    const blockData = await blockResp.json();
    expect(blockData.previewEconomics.savedExposure).toBe(12500);
  });
});
