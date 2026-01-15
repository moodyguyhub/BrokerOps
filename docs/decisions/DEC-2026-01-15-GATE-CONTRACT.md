# Decision Record: Gate Contract Specification

**Decision ID:** DEC-2026-01-15-GATE-CONTRACT  
**Status:** RATIFIED  
**Date:** 2026-01-15  
**Author:** Principal  

---

## Context

BrokerOps operates as a **blocking gate/sidecar** between trading clients and execution venues. The gate must provide cryptographically verifiable proof of authorization decisions.

## Decisions

### 1. Signing Method (P0-R2)

**Decision:** HMAC-SHA256 for v0.x, Ed25519 scheduled for v1.0

| Version | Method | Key Distribution | Use Case |
|---------|--------|------------------|----------|
| v0.x    | HMAC-SHA256 | Shared secret via env/Vault | Internal verification, demo |
| v1.0    | Ed25519 | JWKS endpoint + key rotation | Auditor-grade, multi-party verification |

**Key Rotation Schedule:**
- Development: Static key in `DECISION_TOKEN_KEY` env var
- Production v0.x: Rotate quarterly, version keys as `v1-Q1-2026`, `v1-Q2-2026`
- Production v1.0: 90-day rotation, JWKS distribution, previous key valid for 30 days overlap

**Verification Procedure:**
```
1. Extract payload from token
2. Canonicalize: JSON.stringify(payload, Object.keys(payload).sort())
3. HMAC-SHA256(canonical, signing_key)
4. Compare to token.signature
```

### 2. Gate Outage Behavior

**Decision:** FAIL-CLOSED with circuit breaker

| Scenario | Behavior | Audit Event |
|----------|----------|-------------|
| OPA unreachable | BLOCK with reason `GATE_UNAVAILABLE` | `gate.circuit_open` |
| Audit writer down | BLOCK with reason `AUDIT_UNAVAILABLE` | Best-effort log to stderr |
| Database unavailable | BLOCK with reason `STATE_UNAVAILABLE` | `gate.state_failure` |
| Signing key missing | BLOCK with reason `SIGNING_UNAVAILABLE` | `gate.key_missing` |

**Circuit Breaker Settings:**
- Threshold: 5 failures in 30 seconds
- Reset: 60 seconds half-open, 3 successes to close
- All circuit events emitted as webhook `gate.health_change`

### 3. Shadow Ledger Lifecycle (P0-R1)

**Decision:** Three-state lifecycle with automatic expiry

```
             AUTHORIZED_HOLD
                   │
         ┌─────────┼─────────┐
         │         │         │
         ▼         ▼         ▼
     EXECUTED   EXPIRED   CANCELED
         │
         ▼
      CLOSED
```

**State Transitions:**

| From | To | Trigger | Exposure Effect |
|------|----|---------|-----------------|
| (none) | AUTHORIZED_HOLD | Decision Token issued | +projected_exposure to pending |
| AUTHORIZED_HOLD | EXECUTED | Fill confirmation received | Move from pending to gross |
| AUTHORIZED_HOLD | EXPIRED | token.expires_at reached | -projected_exposure from pending |
| AUTHORIZED_HOLD | CANCELED | Cancel received before expiry | -projected_exposure from pending |
| EXECUTED | CLOSED | Position closed | -realized_exposure from gross |

**Expiry Enforcement:**
- Background job runs every 60 seconds
- Scans `exposure_events` for `AUTHORIZED_HOLD` older than `expires_at`
- Emits `exposure.hold_expired` event with reversal
- Updates `shadow_ledger.pending_exposure` -= hold amount

### 4. Evidence Pack Policy Snapshot (P0-R3)

**Decision:** Evidence Pack MUST include policy content matching Decision Token hash

**Integrity Chain:**
```
Decision Token                Evidence Pack
─────────────                 ─────────────
policy_snapshot_hash    ==    SHA256(policy_snapshot.policyContent)
```

**Verification Procedure:**
1. Extract `policy_snapshot_hash` from Decision Token in audit chain
2. Hash `evidence_pack.components.policySnapshot.policyContent`
3. Assert equality
4. If mismatch: Evidence Pack is INVALID, cannot be used for compliance

**Policy Persistence Strategy:**
- At decision time, risk-gate persists policy content hash to audit event
- reconstruction-api fetches policy content from OPA bundle API
- If bundle unavailable, evidence pack marked `policy_snapshot: "UNAVAILABLE"`

---

## Acceptance Criteria (P0 "Done" Definition)

| # | Criterion | Verification Method |
|---|-----------|---------------------|
| 1 | Decision Token verification | Unit test: recompute signature from payload + key |
| 2 | Hold expiry correctness | Integration test: AUTHORIZED + no fill → exposure returns to 0 after TTL |
| 3 | Evidence Pack integrity | Unit test: manifest hashes match component bytes |
| 4 | Policy snapshot consistency | Integration test: evidence pack policy hash == decision token hash |
| 5 | UI semantics | Grep: no "Released", "Accepted", "Auto-Approved" strings in UI |

---

## Truth Tables

### Decision Token Truth Table

| OPA Decision | Internal State | Token Decision | Status Code |
|--------------|----------------|----------------|-------------|
| ALLOW | - | AUTHORIZED | 200 |
| BLOCK | - | BLOCKED | 200 |
| ERROR | fail-closed | BLOCKED | 503 |
| TIMEOUT | fail-closed | BLOCKED | 504 |

### Exposure Lifecycle Truth Table

| Event | pending_exposure | gross_exposure | net_exposure |
|-------|------------------|----------------|--------------|
| AUTHORIZED (BUY) | +notional | 0 | 0 |
| EXECUTED (BUY fill) | -notional | +notional | +notional |
| EXPIRED | -notional | 0 | 0 |
| CANCELED | -notional | 0 | 0 |
| CLOSED (sell) | 0 | -notional | -notional |

---

## P1 Scope (Snapshot Economics)

**Fields Required:**
```typescript
interface SnapshotEconomics {
  decision_time_price: number;      // Mark price at decision
  qty: number;                       // Order quantity
  notional: number;                  // qty * decision_time_price
  limit: number;                     // Applicable limit value
  current_shadow_exposure: number;   // Pre-order exposure
  projected_shadow_exposure: number; // Post-order exposure if authorized
  saved_exposure?: number;           // For BLOCKED: projected breach amount
}
```

**Saved Exposure KPI:**
- For BLOCKED decisions where `projected_shadow_exposure > limit`:
  - `saved_exposure = projected_shadow_exposure - limit`
- For BLOCKED decisions within limits (policy block):
  - `saved_exposure = notional` (full order blocked)

---

## Changelog

| Date | Change |
|------|--------|
| 2026-01-15 | Initial ratification |
