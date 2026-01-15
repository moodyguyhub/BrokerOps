/**
 * OPA Policy Decision Tests
 * 
 * Tests the Rego policy at policies/order.rego via OPA API.
 * Run: pnpm --filter @broker/tests test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const OPA_URL = process.env.OPA_URL ?? "http://localhost:8181";
const POLICY_PATH = "/v1/data/broker/risk/order";

interface OpaDecision {
  allow: boolean;
  reason_code: string;
  rule_id: string;
}

interface OpaResponse {
  result?: {
    decision?: OpaDecision;
    policy_version?: string;
  };
}

async function queryOpa(input: unknown): Promise<OpaResponse> {
  const res = await fetch(`${OPA_URL}${POLICY_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input })
  });
  if (!res.ok) throw new Error(`OPA query failed: ${res.status}`);
  return res.json() as Promise<OpaResponse>;
}

describe("OPA Policy: broker.risk.order", () => {
  
  it("returns policy version v0.2", async () => {
    const res = await queryOpa({ symbol: "AAPL", side: "BUY", qty: 1 });
    assert.equal(res.result?.policy_version, "policy.v0.2");
  });

  describe("ALLOW cases", () => {
    
    it("allows normal order: AAPL qty=5 price=187", async () => {
      const res = await queryOpa({ 
        clientOrderId: "test-1", 
        symbol: "AAPL", 
        side: "BUY", 
        qty: 5, 
        price: 187.2 
      });
      assert.equal(res.result?.decision?.allow, true);
      assert.equal(res.result?.decision?.reason_code, "OK");
      assert.equal(res.result?.decision?.rule_id, "allow_default");
    });

    it("allows GME with qty <= 10", async () => {
      const res = await queryOpa({ 
        clientOrderId: "gme-ok", 
        symbol: "GME", 
        side: "BUY", 
        qty: 10 
      });
      assert.equal(res.result?.decision?.allow, true);
      assert.equal(res.result?.decision?.reason_code, "OK");
    });

    it("allows penny stock with qty <= 100", async () => {
      const res = await queryOpa({ 
        clientOrderId: "penny-ok", 
        symbol: "XYZ", 
        side: "BUY", 
        qty: 100, 
        price: 0.50 
      });
      assert.equal(res.result?.decision?.allow, true);
    });

  });

  describe("BLOCK cases", () => {

    it("blocks qty > 1000 (QTY_LIMIT_EXCEEDED)", async () => {
      const res = await queryOpa({ 
        clientOrderId: "big", 
        symbol: "AAPL", 
        side: "BUY", 
        qty: 5000 
      });
      assert.equal(res.result?.decision?.allow, false);
      assert.equal(res.result?.decision?.reason_code, "QTY_LIMIT_EXCEEDED");
      assert.equal(res.result?.decision?.rule_id, "qty_limit");
    });

    it("blocks GME with qty > 10 (SYMBOL_RESTRICTION)", async () => {
      const res = await queryOpa({ 
        clientOrderId: "gme-block", 
        symbol: "GME", 
        side: "BUY", 
        qty: 50 
      });
      assert.equal(res.result?.decision?.allow, false);
      assert.equal(res.result?.decision?.reason_code, "SYMBOL_RESTRICTION");
      assert.equal(res.result?.decision?.rule_id, "symbol_gme");
    });

    it("blocks penny stock with price < 1 and qty > 100 (PENNY_STOCK_RESTRICTION)", async () => {
      const res = await queryOpa({ 
        clientOrderId: "penny-block", 
        symbol: "XYZ", 
        side: "BUY", 
        qty: 500, 
        price: 0.50 
      });
      assert.equal(res.result?.decision?.allow, false);
      assert.equal(res.result?.decision?.reason_code, "PENNY_STOCK_RESTRICTION");
      assert.equal(res.result?.decision?.rule_id, "penny_stock");
    });

    it("blocks case-insensitive GME (gme, Gme)", async () => {
      const res = await queryOpa({ 
        clientOrderId: "gme-lower", 
        symbol: "gme", 
        side: "BUY", 
        qty: 50 
      });
      assert.equal(res.result?.decision?.allow, false);
      assert.equal(res.result?.decision?.reason_code, "SYMBOL_RESTRICTION");
    });

  });

  describe("Edge cases", () => {

    it("boundary: qty exactly 1000 is allowed", async () => {
      const res = await queryOpa({ 
        clientOrderId: "boundary", 
        symbol: "AAPL", 
        side: "BUY", 
        qty: 1000 
      });
      assert.equal(res.result?.decision?.allow, true);
    });

    it("boundary: qty 1001 is blocked", async () => {
      const res = await queryOpa({ 
        clientOrderId: "boundary-fail", 
        symbol: "AAPL", 
        side: "BUY", 
        qty: 1001 
      });
      assert.equal(res.result?.decision?.allow, false);
      assert.equal(res.result?.decision?.reason_code, "QTY_LIMIT_EXCEEDED");
    });

  });

});
