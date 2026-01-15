# Decision Record: Snapshot Economics (P1)

**ID:** DEC-2026-01-15-SNAPSHOT-ECONOMICS  
**Status:** APPROVED  
**Date:** 2026-01-15  
**Authors:** Principal, System  
**Scope:** Layer 1 — Decision-Time Economics Only

---

## Context

P0 established the Gate Contract (authority boundary, decision token, evidence pack, shadow ledger). P1 adds **Snapshot Economics** — deterministic KPIs computable at decision-time without requiring reconciliation or close events.

**Goal:** Make "Saved Exposure" and "Projected Exposure" computable 100% of the time *if price exists*.

---

## Principal Decisions (P1 Blockers Resolved)

### Decision 1: Price Source

**Question:** Platform-provided price vs BrokerOps-sourced reference?

**Decision:** **Platform-provided price is primary; BrokerOps reference is fallback.**

| Scenario | Price Source | Confidence Level |
|----------|-------------|------------------|
| Limit order with price | `order.price` | `FIRM` |
| Market order, no price | Mark unavailable | `UNAVAILABLE` |
| Platform sends reference price | `order.referencePrice` | `INDICATIVE` |
| BrokerOps reference lookup (v1.1+) | External quote | `REFERENCE` |

**Rationale:**
- Platform already has execution-grade prices for limit orders
- Adding BrokerOps reference requires external data plumbing (future scope)
- For P1, explicitly marking `price_unavailable=true` for market orders is acceptable
- Evidence Pack must encode which source was used

### Decision 2: Currency Normalization

**Question:** Single currency vs per-symbol currency?

**Decision:** **USD-only for P1; multi-currency deferred to P2.**

| Field | Currency | Note |
|-------|----------|------|
| `notional` | USD | All calculations assume USD base |
| `saved_exposure` | USD | USD aggregate |
| `projected_exposure` | USD | USD aggregate |

**Rationale:**
- Simplifies P1 scope significantly
- FX conversion adds reconciliation complexity (P2 scope)
- Most platform orders are USD-denominated initially
- Currency field included for future-proofing

### Decision 3: Saved Exposure Definition

**Question:** Full notional vs breach-delta only?

**Decision:** **Full notional** — when order is BLOCKED, `saved_exposure = full order notional`.

| Decision | Saved Exposure |
|----------|----------------|
| BLOCK (any reason) | `qty × price` |
| ALLOW → AUTHORIZED | 0 |

**Rationale:**
- Simpler to explain: "We prevented $X of exposure from entering the system"
- Breach-delta requires knowing which limit would have been breached (more complex)
- Auditors prefer conservative/simple definitions
- Dashboard shows "Total Blocked Notional" clearly

---

## P1 Canonical Snapshot Fields

Every decision MUST compute a `SnapshotEconomics` object:

```typescript
interface SnapshotEconomics {
  // Core fields (always present if price available)
  decision_time: string;           // ISO-8601 timestamp
  decision_time_price: number | null;
  qty: number;
  notional: number | null;         // qty × decision_time_price (null if no price)
  
  // Exposure impact
  projected_exposure_delta: number | null;  // notional (for AUTHORIZED)
  saved_exposure: number | null;            // notional (for BLOCKED)
  
  // Price provenance
  price_source: 'FIRM' | 'INDICATIVE' | 'REFERENCE' | 'UNAVAILABLE';
  price_unavailable: boolean;
  
  // Shadow ledger coupling (if applicable)
  exposure_pre: number | null;     // exposure before this decision
  exposure_post: number | null;    // exposure after this decision
  
  // Currency
  currency: 'USD';
}
```

---

## Evidence Pack Economics Component (P1 Upgrade)

The `EconomicsComponent` in Evidence Pack is upgraded to:

```typescript
interface EconomicsComponentV2 {
  version: "2.0";
  traceId: string;
  timestamp: string;
  
  // Snapshot economics (new)
  snapshot: SnapshotEconomics;
  
  // Policy context (new)
  policy_context?: {
    limit_type?: string;           // e.g., "GROSS_EXPOSURE", "QTY_LIMIT"
    limit_value?: number;          // The threshold that was checked
    current_value?: number;        // Value at decision time
  };
  
  // Legacy summary (for backward compat)
  summary?: {
    grossRevenue: number;
    fees: number;
    costs: number;
    estimatedLostRevenue: number;
    netImpact: number;
    currency: string;
  };
}
```

---

## Shadow Ledger Coupling (P1)

### On AUTHORIZED Decision

```
1. Compute notional = qty × decision_time_price
2. Get exposure_pre = current_exposure(clientId)
3. Record AUTHORIZED_HOLD with:
   - notional
   - expires_at = decision_time + TOKEN_TTL
4. Set exposure_post = exposure_pre + notional
5. Include in SnapshotEconomics: exposure_pre, exposure_post, projected_exposure_delta
```

### On BLOCKED Decision

```
1. Compute notional = qty × decision_time_price
2. DO NOT mutate exposure state
3. Set saved_exposure = notional
4. Include in SnapshotEconomics: saved_exposure, exposure_pre (for context)
```

---

## UI Requirements (P1)

### Global KPI Card: Saved Exposure

```
┌─────────────────────────────┐
│ SAVED EXPOSURE (BLOCKED)    │
│ $1,234,567                  │
│ ↑ 12.3% vs last 24h         │
└─────────────────────────────┘
```

- Definition: Sum of `saved_exposure` across all BLOCKED decisions
- Time window: Configurable (default: last 24h)
- Tooltip: "Total notional value of orders blocked by policy"

### Per-Trace Economics Display

When viewing a trace detail, show:

| Field | Value |
|-------|-------|
| Decision Price | $150.00 (FIRM) |
| Quantity | 100 |
| Notional | $15,000.00 |
| Exposure Pre | $50,000.00 |
| Exposure Post | $65,000.00 |
| Projected Δ | +$15,000.00 |

For BLOCKED traces, show `Saved Exposure` instead of `Projected Δ`.

---

## P1 Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Snapshot coverage | ≥99% | Decisions with `notional` OR `price_unavailable=true` |
| Determinism | 100% | Recompute `saved_exposure` from trace bundle matches stored |
| Evidence integrity | 100% | Economics component hash in manifest/packHash |

---

## P1 Acceptance Criteria

1. ✅ Every AUTHORIZED decision includes `SnapshotEconomics` with `projected_exposure_delta`
2. ✅ Every BLOCKED decision includes `SnapshotEconomics` with `saved_exposure`
3. ✅ Price source is explicitly encoded (`FIRM`, `INDICATIVE`, `UNAVAILABLE`)
4. ✅ Evidence Pack `EconomicsComponentV2` is hashable and in manifest
5. ✅ UI shows "Saved Exposure" KPI (sum of blocked notional)
6. ✅ Trace detail shows snapshot economics (price, notional, exposure delta)
7. ✅ Market orders (no price) set `price_unavailable=true`, `notional=null`

---

## What P1 Does NOT Include

- ❌ Reconciliation with fill events
- ❌ Realized P&L calculation
- ❌ Multi-currency support (USD only)
- ❌ BrokerOps-sourced reference prices (external lookup)
- ❌ Time-weighted exposure metrics
- ❌ Close-event ingestion

These are deferred to P2 (Reconciliation Economics).

---

## Appendix: Price Source Truth Table

| Order Type | `order.price` | Price Source | Confidence | Notional |
|------------|--------------|--------------|------------|----------|
| LIMIT | 150.00 | `FIRM` | High | qty × 150 |
| LIMIT | 0 | `UNAVAILABLE` | None | null |
| MARKET | null | `UNAVAILABLE` | None | null |
| MARKET + ref | null (ref=149.50) | `INDICATIVE` | Medium | qty × 149.50 |

---

**Approval:** Gate Contract P1 Snapshot Economics specification approved.
