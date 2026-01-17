# Decision Record: Gate 1 — Offline Replay Sync Protocol

**Decision ID:** DEC-G1-OFFLINE-REPLAY-SYNC  
**Status:** UNVERIFIED HYPOTHESIS  
**Date:** 2026-01-16  
**Author:** Principal  
**Related:** DEC-P3-SYSTEMS-ENGINEERING-PIVOT  

---

## Context

Gate 0 proved local authorization latency. Gate 1 must prove **offline buffering + cloud sync + deterministic replay** with integrity guarantees, **without broker dependencies**. This decision defines the **sync envelope**, **idempotency rules**, **ordering model**, and **fail-closed** behavior for replay verification.

---

## Decision

### 1) Decision Event Envelope (G1)

A **decision event** is derived from the Decision Token and a canonical order snapshot. The envelope is stored locally (spool) and later synced to the cloud.

```json
{
  "event_id": "uuid",
  "idempotency_key": "g1:<event_id>",
  "trace_id": "uuid",
  "captured_at": "2026-01-16T12:00:00Z",
  "decision_hash": "sha256(canonical_decision_fields)",
  "decision_payload": {
    "trace_id": "...",
    "decision": "AUTHORIZED|BLOCKED",
    "reason_code": "...",
    "rule_ids": ["..."],
    "policy_snapshot_hash": "...",
    "order_digest": "...",
    "order_digest_version": "v1",
    "order": {
      "client_order_id": "...",
      "symbol": "AAPL",
      "side": "BUY",
      "qty": 100,
      "price": 185.5
    },
    "subject": "client-id",
    "audience": "trading-platform"
  },
  "chain": {
    "prev_hash": "sha256(previous)",
    "hash": "sha256(prev_hash|event_id|decision_hash)"
  }
}
```

**Excluded from the canonical hash** (non-deterministic): `issued_at`, `expires_at`, `nonce`, `captured_at`, transport timing fields.

### 2) Idempotency

- **Idempotency key**: `g1:<event_id>` (UUID v4).
- **Cloud storage rule**: if an event with the same `event_id` already exists, the sync **must not** create a duplicate.

### 3) Ordering Model

- **Local ordering** is the spool append order.
- **Replay ordering** is the cloud store order **by first-seen sequence**.
- **Cross-event causal ordering** is not guaranteed; integrity is per-event + chain.

### 4) Integrity Chain

- Each spool event includes `chain.prev_hash` and `chain.hash`.
- `chain.hash = sha256(prev_hash|event_id|decision_hash)`
- Any tamper in `decision_hash` or ordering breaks the chain and must be detected.

### 5) Failure Semantics (Fail-Closed)

On any integrity violation (hash mismatch, chain break, or replay mismatch), the replay verifier returns:

- `status: "BLOCKED"`
- `reason_code: "REPLAY_INTEGRITY_FAILURE"`

No “best-effort” success is allowed.

---

## Evidence Artifacts (Gate 1)

Produced by `scripts/g1-offline-replay-acceptance-test.sh`:

- `evidence/g1-pack-<timestamp>/g1-sync-run.log`
- `evidence/g1-pack-<timestamp>/g1-replay-report.json`
- `evidence/g1-pack-<timestamp>/g1-invariants.json`
- `evidence/g1-pack-<timestamp>/CHECKSUMS.sha256`

---

## Exit Criteria

PASS if all are true (machine-verifiable):

1. **Idempotency**: duplicate_count = 0 after forced replay.
2. **Replay determinism**: decision_hash matches for all events.
3. **Integrity chain**: chain verifies end-to-end.
4. **Evidence pack checksums**: `sha256sum -c CHECKSUMS.sha256` passes.

FAIL if any invariant is false or integrity fails.

---

## Status

UNVERIFIED until a Gate 1 evidence pack is generated and validated.
