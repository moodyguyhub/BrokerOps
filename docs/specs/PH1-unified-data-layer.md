# Phase 1 Unified Data Layer (Demo Mode)

**Version:** 0.1.0  
**Status:** Draft  
**Date:** 2026-01-16  
**Relates to:** [P2-event-contract-spec.md](../design/P2-event-contract-spec.md), [DEC-P2-LIFECYCLE-LINKAGE.md](../decisions/DEC-P2-LIFECYCLE-LINKAGE.md)

## Overview

This specification defines the **Unified Data Layer** event contract for Phase 1 Demo Build. It establishes a stable, versioned event structure that all LP order lifecycle and margin events must conform to, enabling:

1. **LP Order Lifecycle Tracking** (Feature 1.1)
2. **Rejection Reason Normalization** (Feature 1.2)
3. **Source Swap**: Simulator → MT5 Manager API → other LP/bridge sources

## Goal

Provide a single, versioned event contract that:

- Decouples the ingestion layer from specific LP implementations
- Guarantees deterministic timeline reconstruction
- Preserves raw provider data alongside normalized fields
- Supports cryptographic integrity verification (hash-chain)

## Non-Goals (Phase 1)

| Deferred | Rationale |
|----------|-----------|
| Multi-LP aggregation | Single-source demo first |
| P&L attribution | Covered by P2 event contract |
| Toxic flow detection | Requires historical data + ML |
| MT5 pre-trade enforcement | Post-Phase 1; requires bridge integration |

## Namespace Alignment

| Namespace | Scope | Defined In |
|-----------|-------|------------|
| `lp.order.*` | LP order lifecycle (this spec) | PH1-unified-data-layer |
| `lp.margin.*` | LP margin snapshots (this spec) | PH1-unified-data-layer |
| `execution.*` | Post-trade execution reports | P2-event-contract-spec |
| `position.*` | Position P&L closure | P2-event-contract-spec |
| `economics.*` | T+1 reconciliation | P2-event-contract-spec |

> **Invariant:** `lp.order.*` events flow from LP/Bridge → Unified Layer → Audit. `execution.*` events flow from Platform → Unified Layer → Shadow Ledger. They are complementary; both use `trace_id` for correlation.

---

## Canonical Event Envelope

Every event emitted into the unified layer MUST conform to this structure:

```json
{
  "event_id": "550e8400-e29b-41d4-a716-446655440000",
  "event_type": "lp.order.rejected",
  "event_version": 1,
  "source": {
    "kind": "SIM",
    "name": "truvesta-sim-v1",
    "adapter_version": "1.0.0",
    "server_id": "srv-1",
    "server_name": "Server 1"
  },
  "occurred_at": "2026-01-16T10:30:00.123Z",
  "ingested_at": "2026-01-16T10:30:00.456Z",
  "correlation": {
    "trace_id": "376c33cf-b54f-4c80-a940-45ae01653768",
    "client_order_id": "ORDER-001",
    "lp_order_id": "LP-12345",
    "order_digest": "a1b2c3d4e5f6...",
    "decision_token_id": "376c33cf-b54f-4c80-a940-45ae01653768"
  },
  "payload": {
    "symbol": "EURUSD",
    "side": "BUY",
    "qty": 100000,
    "price": 1.08542,
    "order_type": "LIMIT"
  },
  "normalization": {
    "status": "REJECTED",
    "reason": {
      "taxonomy_version": "2026-01-16.v1",
      "reason_code": "INSUFFICIENT_MARGIN",
      "reason_class": "MARGIN",
      "raw": {
        "provider_code": "10019",
        "provider_message": "Not enough money",
        "provider_fields": {
          "required_margin": 5000.00,
          "available_margin": 3200.50
        }
      }
    }
  },
  "integrity": {
    "payload_hash": "sha256:abc123...",
    "prev_event_hash": "sha256:def456...",
    "chain_id": "trace:376c33cf-b54f-4c80-a940-45ae01653768"
  }
}
```

---

## Field Specifications

### Envelope Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `event_id` | UUID v4 | ✅ | Globally unique event identifier |
| `event_type` | string | ✅ | Namespaced event type (e.g., `lp.order.rejected`) |
| `event_version` | integer | ✅ | Schema version for this event type |
| `source.kind` | enum | ✅ | `SIM`, `MT5_MANAGER`, `BRIDGE`, `LP` |
| `source.name` | string | ✅ | Human-readable source identifier |
| `source.adapter_version` | semver | ✅ | Adapter code version |
| `source.server_id` | string | ✅ | Server identity (proof-carrying) |
| `source.server_name` | string | ✅ | Server display name (proof-carrying) |
| `occurred_at` | RFC3339 | ✅ | When the event occurred at source |
| `ingested_at` | RFC3339 | ✅ | When the unified layer received the event |

### Correlation Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `trace_id` | string | ✅ | Links to BrokerOps authorization trace |
| `client_order_id` | string | ❓ | Client-assigned order ID (if available) |
| `lp_order_id` | string | ❓ | LP-assigned order ID (if available) |
| `order_digest` | hex | ❓ | SHA-256 digest per [ORDER_DIGEST.md](ORDER_DIGEST.md) |
| `decision_token_id` | string | ❓ | Decision token trace_id (same as trace_id if guardrailed) |

### Normalization Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | enum | ✅ | Normalized status (see [PH1-lp-lifecycle.md](PH1-lp-lifecycle.md)) |
| `reason.taxonomy_version` | string | ✅* | Version of reason taxonomy used |
| `reason.reason_code` | string | ✅* | Normalized reason code |
| `reason.reason_class` | string | ✅* | Coarse reason bucket |
| `reason.raw.provider_code` | string | ❓ | Raw provider error code |
| `reason.raw.provider_message` | string | ❓ | Raw provider error message |
| `reason.raw.provider_fields` | object | ❓ | Additional provider-specific fields |

*Required when `status` is `REJECTED` or event indicates a failure condition.

### Integrity Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `payload_hash` | string | ✅ | `sha256:{hex}` of canonical payload JSON |
| `prev_event_hash` | string | ❓ | Hash of previous event in chain (null for first) |
| `chain_id` | string | ✅ | Identifier for hash chain (typically `trace:{trace_id}`) |

---

## Event Types (Phase 1 Scope)

### LP Order Events

| Event Type | Description | Terminal? |
|------------|-------------|-----------|
| `lp.order.submitted` | Order submitted to LP/bridge | No |
| `lp.order.accepted` | LP acknowledged order | No |
| `lp.order.rejected` | LP rejected order | Yes |
| `lp.order.filled` | Order fully filled | Yes |
| `lp.order.partially_filled` | Partial fill received | No |
| `lp.order.canceled` | Order canceled | Yes |
| `lp.order.expired` | Order expired (e.g., GTC timeout) | Yes |
| `lp.order.status_snapshot` | Periodic status sync (optional) | No |

### LP Margin Events (Deferred)

| Event Type | Description | Phase |
|------------|-------------|-------|
| `lp.margin.snapshot` | Margin level point-in-time | 1.3 |
| `lp.margin.warning` | Margin warning threshold | 1.3 |
| `lp.margin.call` | Margin call event | 1.3 |

---

## Invariants

### INV-1: Event ID Uniqueness
```
∀ e1, e2 ∈ Events: e1.event_id = e2.event_id ⟹ e1 = e2
```

### INV-2: Schema Versioning
Breaking changes to event structure MUST increment `event_version`. Consumers MUST handle unknown versions gracefully (log + skip).

### INV-3: Trace ID Required
```
∀ e ∈ OrderEvents: e.correlation.trace_id ≠ null
```

### INV-4: Payload Hash Determinism
```
payload_hash = SHA256(canonicalize(event - integrity))
```
Where `canonicalize()` is JSON Canonicalization Scheme (JCS, RFC 8785).

> **Note:** `source.server_id` and `source.server_name` are part of the event payload and therefore MUST influence the computed hash.

### INV-5: Chain Integrity
```
∀ e ∈ Chain[n]: e.integrity.prev_event_hash = hash(Chain[n-1])
```

### INV-6: Rejection Reason Required
```
∀ e: e.normalization.status = "REJECTED" ⟹ e.normalization.reason ≠ null
```

---

## Payload Hash Computation

```typescript
import { canonicalize } from 'json-canonicalize'; // RFC 8785
import { createHash } from 'crypto';

function computePayloadHash(event: UnifiedEvent): string {
  // Exclude integrity fields from hash input
  const { integrity, ...hashableEvent } = event;
  const canonical = canonicalize(hashableEvent);
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `sha256:${hash}`;
}
```

---

## Source Adapter Contract

Each source adapter (SIM, MT5_MANAGER, BRIDGE) MUST:

1. **Emit valid envelope**: All required fields present
2. **Normalize status**: Map raw status to normalized status
3. **Normalize rejection reasons**: Map raw codes to taxonomy
4. **Preserve raw data**: Never discard provider fields
5. **Set adapter_version**: Semantic version of adapter code
6. **Maintain determinism**: Same input → same output (testable via fixtures)

### Adapter Registration

```yaml
adapters:
  - kind: SIM
    name: truvesta-sim-v1
    version: 1.0.0
    status_mapping: fixtures/sim-status-mapping.yaml
    reason_mapping: fixtures/sim-reason-mapping.yaml
    
  - kind: MT5_MANAGER
    name: mt5-manager-adapter
    version: 0.1.0
    status_mapping: fixtures/mt5-status-mapping.yaml
    reason_mapping: fixtures/mt5-reason-mapping.yaml
```

---

## Acceptance Criteria

| ID | Criterion | Verification |
|----|-----------|--------------|
| AC-1 | Simulator emits valid `lp.order.*` events | Fixture test |
| AC-2 | Audit trail persists events without schema drift | Schema validation on insert |
| AC-3 | Timeline reconstruction is deterministic | Golden-path replay test |
| AC-4 | Rejection events include normalized reason + raw fields | Fixture coverage |
| AC-5 | Hash chain is verifiable | Chain verification test |
| AC-6 | Adapter swap (SIM → MT5) requires no consumer changes | Integration test |

---

## Migration Notes

### From P2 Event Contract

The P2 event contract (`execution.reported`, `position.closed`) remains valid for post-trade economics. This spec **extends** the unified layer with pre-trade/LP-side events.

Correlation key remains `trace_id` per [DEC-P2-LIFECYCLE-LINKAGE.md](../decisions/DEC-P2-LIFECYCLE-LINKAGE.md).

### Versioning Strategy

- `event_version`: Integer, starts at 1
- `taxonomy_version`: Date-based (`YYYY-MM-DD.v{n}`)
- Breaking changes: New version + migration guide + 30-day dual-emit window

---

## References

- [PH1-lp-lifecycle.md](PH1-lp-lifecycle.md) - Status state machine
- [PH1-rejection-normalization.md](PH1-rejection-normalization.md) - Reason taxonomy
- [ORDER_DIGEST.md](ORDER_DIGEST.md) - Order digest specification
- [P2-event-contract-spec.md](../design/P2-event-contract-spec.md) - Post-trade events
- [DEC-P2-LIFECYCLE-LINKAGE.md](../decisions/DEC-P2-LIFECYCLE-LINKAGE.md) - Correlation strategy
