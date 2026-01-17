# Phase 1 LP Order Lifecycle

**Version:** 0.1.0  
**Status:** Draft  
**Date:** 2026-01-16  
**Relates to:** [PH1-unified-data-layer.md](PH1-unified-data-layer.md)

## Overview

This specification defines the **normalized order lifecycle state machine** for LP orders. It establishes:

1. Canonical status values for UI/API display
2. Valid state transitions (guards against invalid sequences)
3. Mapping rules from raw LP/bridge statuses
4. Timeline reconstruction logic

## Normalized Statuses

All LP order events carry a `normalization.status` field with one of these values:

| Status | Description | Terminal? |
|--------|-------------|-----------|
| `SUBMITTED` | Order sent to LP/bridge, awaiting acknowledgment | No |
| `ACCEPTED` | LP acknowledged receipt, order is active | No |
| `REJECTED` | LP rejected the order | Yes |
| `PARTIALLY_FILLED` | Some quantity filled, remainder active | No |
| `FILLED` | Order fully filled | Yes |
| `CANCELED` | Order canceled by user or system | Yes |
| `EXPIRED` | Order expired (e.g., end of day, GTC timeout) | Yes |
| `UNKNOWN` | Raw status could not be mapped | No |

### Status Semantics

```
SUBMITTED   → Order left our system toward LP
ACCEPTED    → LP has the order, can execute
REJECTED    → LP refused the order (see reason_code)
PARTIAL     → Fills received, more expected
FILLED      → No remaining quantity
CANCELED    → Order removed before full fill
EXPIRED     → Time-based removal
UNKNOWN     → Mapping failed (requires investigation)
```

---

## State Transition Graph

```
                    ┌─────────────┐
                    │  SUBMITTED  │
                    └──────┬──────┘
                           │
            ┌──────────────┼──────────────┬─────────────┐
            ▼              ▼              ▼             ▼
      ┌─────────┐    ┌──────────┐   ┌──────────┐  ┌──────────┐
      │ACCEPTED │    │ REJECTED │   │ CANCELED │  │ EXPIRED  │
      └────┬────┘    └──────────┘   └──────────┘  └──────────┘
           │              ▲              ▲             ▲
           │              │              │             │
      ┌────┴────────┬─────┴──────────────┴─────────────┤
      ▼             ▼                                  │
┌───────────┐  ┌────────┐                              │
│PART_FILLED│  │ FILLED │                              │
└─────┬─────┘  └────────┘                              │
      │                                                │
      ├──────────────────────────────────────────────┘
      │
      ▼
┌───────────┐    ┌────────┐
│PART_FILLED│───▶│ FILLED │
└───────────┘    └────────┘
      │
      └──────────────────────────────────────────────┐
                                                      ▼
                                              ┌──────────┐
                                              │ CANCELED │
                                              └──────────┘
```

---

## Allowed Transitions

### Transition Matrix

| From \ To | SUBMITTED | ACCEPTED | REJECTED | PARTIAL | FILLED | CANCELED | EXPIRED | UNKNOWN |
|-----------|:---------:|:--------:|:--------:|:-------:|:------:|:--------:|:-------:|:-------:|
| SUBMITTED | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ |
| ACCEPTED | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| REJECTED | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| PARTIAL | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| FILLED | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| CANCELED | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| EXPIRED | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| UNKNOWN | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### Transition Rules (Code)

```typescript
const TERMINAL_STATUSES = new Set(['REJECTED', 'FILLED', 'CANCELED', 'EXPIRED']);

const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
  'SUBMITTED': new Set(['ACCEPTED', 'REJECTED', 'CANCELED', 'EXPIRED', 'UNKNOWN']),
  'ACCEPTED': new Set(['PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED', 'UNKNOWN']),
  'PARTIALLY_FILLED': new Set(['PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED', 'UNKNOWN']),
  'REJECTED': new Set([]),  // Terminal
  'FILLED': new Set([]),    // Terminal
  'CANCELED': new Set([]),  // Terminal
  'EXPIRED': new Set([]),   // Terminal
  'UNKNOWN': new Set(['SUBMITTED', 'ACCEPTED', 'REJECTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED', 'UNKNOWN']),
};

function isValidTransition(from: string, to: string): boolean {
  if (TERMINAL_STATUSES.has(from)) return false;
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}
```

---

## Status Mapping

### Mapping Contract

Each adapter MUST provide a deterministic mapping function:

```typescript
interface StatusMappingInput {
  source_kind: 'SIM' | 'MT5_MANAGER' | 'BRIDGE' | 'LP';
  raw_status: string;
  raw_fields?: Record<string, unknown>;
}

interface StatusMappingOutput {
  normalized_status: NormalizedStatus;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  mapping_version: string;
}

type StatusMapper = (input: StatusMappingInput) => StatusMappingOutput;
```

### Simulator Status Mapping (Example)

```yaml
# fixtures/sim-status-mapping.yaml
version: "2026-01-16.v1"
source_kind: SIM
mappings:
  - raw_status: "new"
    normalized_status: SUBMITTED
    confidence: HIGH
    
  - raw_status: "pending"
    normalized_status: SUBMITTED
    confidence: HIGH
    
  - raw_status: "open"
    normalized_status: ACCEPTED
    confidence: HIGH
    
  - raw_status: "partial"
    normalized_status: PARTIALLY_FILLED
    confidence: HIGH
    
  - raw_status: "filled"
    normalized_status: FILLED
    confidence: HIGH
    
  - raw_status: "rejected"
    normalized_status: REJECTED
    confidence: HIGH
    
  - raw_status: "cancelled"
    normalized_status: CANCELED
    confidence: HIGH
    
  - raw_status: "canceled"
    normalized_status: CANCELED
    confidence: HIGH
    
  - raw_status: "expired"
    normalized_status: EXPIRED
    confidence: HIGH

default:
  normalized_status: UNKNOWN
  confidence: LOW
```

### MT5 Status Mapping (Example)

```yaml
# fixtures/mt5-status-mapping.yaml
version: "2026-01-16.v1"
source_kind: MT5_MANAGER
mappings:
  # MT5 ORDER_STATE values
  - raw_status: "ORDER_STATE_STARTED"
    normalized_status: SUBMITTED
    confidence: HIGH
    
  - raw_status: "ORDER_STATE_PLACED"
    normalized_status: ACCEPTED
    confidence: HIGH
    
  - raw_status: "ORDER_STATE_CANCELED"
    normalized_status: CANCELED
    confidence: HIGH
    
  - raw_status: "ORDER_STATE_PARTIAL"
    normalized_status: PARTIALLY_FILLED
    confidence: HIGH
    
  - raw_status: "ORDER_STATE_FILLED"
    normalized_status: FILLED
    confidence: HIGH
    
  - raw_status: "ORDER_STATE_REJECTED"
    normalized_status: REJECTED
    confidence: HIGH
    
  - raw_status: "ORDER_STATE_EXPIRED"
    normalized_status: EXPIRED
    confidence: HIGH

default:
  normalized_status: UNKNOWN
  confidence: LOW
```

---

## Timeline Reconstruction

### Algorithm

Given all events for a `trace_id`:

```typescript
interface TimelineEvent {
  event_id: string;
  event_type: string;
  occurred_at: Date;
  ingested_at: Date;
  status: NormalizedStatus;
  reason?: ReasonNormalization;
  payload: Record<string, unknown>;
  integrity_valid: boolean;
}

interface Timeline {
  trace_id: string;
  events: TimelineEvent[];
  current_status: NormalizedStatus;
  is_terminal: boolean;
  has_violations: boolean;
  violations: TransitionViolation[];
  integrity_status: 'VALID' | 'INVALID' | 'TAMPER_SUSPECTED';
}

function reconstructTimeline(traceId: string, events: UnifiedEvent[]): Timeline {
  // 1. Sort by occurred_at, then ingested_at, then event_id (deterministic)
  const sorted = events.sort((a, b) => {
    const tA = new Date(a.occurred_at).getTime();
    const tB = new Date(b.occurred_at).getTime();
    if (tA !== tB) return tA - tB;
    
    const iA = new Date(a.ingested_at).getTime();
    const iB = new Date(b.ingested_at).getTime();
    if (iA !== iB) return iA - iB;
    
    return a.event_id.localeCompare(b.event_id);
  });
  
  // 2. Validate transitions
  const violations: TransitionViolation[] = [];
  let prevStatus: NormalizedStatus | null = null;
  
  for (const event of sorted) {
    const currentStatus = event.normalization.status;
    
    if (prevStatus !== null && !isValidTransition(prevStatus, currentStatus)) {
      violations.push({
        from_status: prevStatus,
        to_status: currentStatus,
        event_id: event.event_id,
        reason_code: 'INVALID_TRANSITION',
      });
    }
    
    prevStatus = currentStatus;
  }
  
  // 3. Verify hash chain
  const integrityStatus = verifyHashChain(sorted);
  
  // 4. Build timeline
  return {
    trace_id: traceId,
    events: sorted.map(e => ({
      event_id: e.event_id,
      event_type: e.event_type,
      occurred_at: new Date(e.occurred_at),
      ingested_at: new Date(e.ingested_at),
      status: e.normalization.status,
      reason: e.normalization.reason,
      payload: e.payload,
      integrity_valid: true, // per-event validation
    })),
    current_status: prevStatus ?? 'UNKNOWN',
    is_terminal: TERMINAL_STATUSES.has(prevStatus ?? ''),
    has_violations: violations.length > 0,
    violations,
    integrity_status: integrityStatus,
  };
}
```

### Violation Handling

When a transition violation is detected:

1. **Log with severity=WARN**: `INVALID_TRANSITION from={from} to={to} event_id={id}`
2. **Include in timeline**: Mark `has_violations=true`, list in `violations[]`
3. **Do NOT drop the event**: Preserve for audit investigation
4. **Evidence pack**: Include violation details with `TAMPER_SUSPECTED` flag

---

## Fill Aggregation

For orders with multiple partial fills:

```typescript
interface FillSummary {
  total_qty: number;
  filled_qty: number;
  remaining_qty: number;
  fill_count: number;
  avg_fill_price: number;
  first_fill_at: Date;
  last_fill_at: Date;
}

function aggregateFills(events: UnifiedEvent[]): FillSummary {
  const fills = events.filter(e => 
    e.event_type === 'lp.order.filled' || 
    e.event_type === 'lp.order.partially_filled'
  );
  
  let totalQty = 0;
  let totalValue = 0;
  
  for (const fill of fills) {
    const qty = fill.payload.fill_qty ?? 0;
    const price = fill.payload.fill_price ?? 0;
    totalQty += qty;
    totalValue += qty * price;
  }
  
  return {
    total_qty: events[0]?.payload.qty ?? 0,
    filled_qty: totalQty,
    remaining_qty: Math.max(0, (events[0]?.payload.qty ?? 0) - totalQty),
    fill_count: fills.length,
    avg_fill_price: totalQty > 0 ? totalValue / totalQty : 0,
    first_fill_at: fills.length > 0 ? new Date(fills[0].occurred_at) : new Date(),
    last_fill_at: fills.length > 0 ? new Date(fills[fills.length - 1].occurred_at) : new Date(),
  };
}
```

---

## Acceptance Criteria

| ID | Criterion | Verification |
|----|-----------|--------------|
| AC-1 | All `lp.order.*` events have a valid `normalization.status` | Schema validation |
| AC-2 | Status values are from the defined enum | Enum check on ingestion |
| AC-3 | Timeline reconstruction is deterministic | Same events → same timeline |
| AC-4 | Transition violations are detected and flagged | Violation test fixtures |
| AC-5 | Terminal status events cannot have successors | Transition matrix test |
| AC-6 | `UNKNOWN` status triggers investigation alert | Alert rule test |
| AC-7 | Fill aggregation is mathematically correct | Arithmetic fixtures |

---

## Test Fixtures

### Valid Sequence

```json
{
  "fixture_id": "valid-full-fill",
  "events": [
    {"event_type": "lp.order.submitted", "status": "SUBMITTED", "occurred_at": "T+0ms"},
    {"event_type": "lp.order.accepted", "status": "ACCEPTED", "occurred_at": "T+50ms"},
    {"event_type": "lp.order.filled", "status": "FILLED", "occurred_at": "T+200ms"}
  ],
  "expected": {
    "current_status": "FILLED",
    "is_terminal": true,
    "has_violations": false
  }
}
```

### Valid Partial Fill Sequence

```json
{
  "fixture_id": "valid-partial-fills",
  "events": [
    {"event_type": "lp.order.submitted", "status": "SUBMITTED", "occurred_at": "T+0ms"},
    {"event_type": "lp.order.accepted", "status": "ACCEPTED", "occurred_at": "T+50ms"},
    {"event_type": "lp.order.partially_filled", "status": "PARTIALLY_FILLED", "occurred_at": "T+100ms", "fill_qty": 50},
    {"event_type": "lp.order.partially_filled", "status": "PARTIALLY_FILLED", "occurred_at": "T+150ms", "fill_qty": 30},
    {"event_type": "lp.order.filled", "status": "FILLED", "occurred_at": "T+200ms", "fill_qty": 20}
  ],
  "expected": {
    "current_status": "FILLED",
    "is_terminal": true,
    "has_violations": false,
    "fill_count": 3,
    "filled_qty": 100
  }
}
```

### Invalid Transition (Violation)

```json
{
  "fixture_id": "invalid-rejected-then-filled",
  "events": [
    {"event_type": "lp.order.submitted", "status": "SUBMITTED", "occurred_at": "T+0ms"},
    {"event_type": "lp.order.rejected", "status": "REJECTED", "occurred_at": "T+50ms"},
    {"event_type": "lp.order.filled", "status": "FILLED", "occurred_at": "T+100ms"}
  ],
  "expected": {
    "current_status": "FILLED",
    "is_terminal": true,
    "has_violations": true,
    "violations": [
      {"from_status": "REJECTED", "to_status": "FILLED", "reason_code": "INVALID_TRANSITION"}
    ]
  }
}
```

---

## References

- [PH1-unified-data-layer.md](PH1-unified-data-layer.md) - Event envelope spec
- [PH1-rejection-normalization.md](PH1-rejection-normalization.md) - Rejection reason taxonomy
- [ORDER_DIGEST.md](ORDER_DIGEST.md) - Order digest computation
