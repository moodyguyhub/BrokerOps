# DEC-P2-LIFECYCLE-LINKAGE

**Date:** 2026-01-15  
**Status:** Accepted  
**Context:** P2 Lifecycle Event Correlation  

## Decision

**Lifecycle events use `trace_id` as the canonical correlation key** for linking execution/close events to their originating authorization decision.

## The Problem

When a platform posts `execution.reported` or `position.closed`, it must include a `decision_token` field. This field needs to correlate back to the original authorization trace for:

1. Evidence pack generation (include realized economics)
2. Shadow ledger state transitions
3. P&L accuracy tracking

Two linking strategies were considered:

| Strategy | Pros | Cons |
|----------|------|------|
| **A: Full decision token** | Cryptographically verifiable | Long string, harder to query, token structure may change |
| **B: trace_id only** | Simple, stable, human-readable | Requires platform to extract trace_id from token |

## Decision

**Use `trace_id` as the linkage key** with the following invariants:

### Invariant 1: Lifecycle events store trace_id
```sql
-- lifecycle_events.decision_token column contains the trace_id value
INSERT INTO lifecycle_events (decision_token, ...) 
VALUES ($trace_id, ...);  -- NOT the full JSON token
```

### Invariant 2: Evidence pack queries by trace_id
```typescript
// reconstruction-api/index.ts
const decisionToken = decisionEvent?.payload_json?.decisionToken?.trace_id ?? traceId;
// Falls back to request traceId if token structure unavailable
```

### Invariant 3: Platform posts trace_id in decision_token field
```json
{
  "event_type": "execution.reported",
  "decision_token": "376c33cf-b54f-4c80-a940-45ae01653768",  // trace_id, not full token
  ...
}
```

## Rationale

1. **Simplicity**: UUID is queryable without JSON parsing
2. **Stability**: trace_id format won't change even if token structure evolves
3. **Backward compatibility**: Works with existing audit_events queries
4. **Fallback safety**: If token unavailable, traceId from URL path works

## Migration Notes

- Existing lifecycle_events with test tokens (non-UUID) should be treated as test data
- Production integrations must extract and send `trace_id` from decision token payload
- No migration of existing data required (column is already TEXT type)

## Verification

```sql
-- Verify linkage: lifecycle events should join to audit_events on decision_token = trace_id
SELECT le.event_type, ae.event_type, le.decision_token
FROM lifecycle_events le
JOIN audit_events ae ON le.decision_token = ae.trace_id
WHERE le.event_type = 'execution.reported';
```

## References

- [reconstruction-api/src/index.ts](../../services/reconstruction-api/src/index.ts) - Evidence pack realized economics fetch
- [webhooks/src/index.ts](../../services/webhooks/src/index.ts) - Lifecycle event ingestion
- [DEC-P2-EVENT-GATEWAY.md](DEC-P2-EVENT-GATEWAY.md) - Event gateway architecture
