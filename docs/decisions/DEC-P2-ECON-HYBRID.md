# DEC-P2-ECON-HYBRID

**Date:** 2026-01-15  
**Status:** Accepted  
**Context:** P2 Realized Economics  

## Decision

**Platform provisional + back-office finalization is the truth model** for realized P&L.

## The Problem

After execution, there are two sources of P&L data:

1. **Platform (near real-time)**: Fills reported by broker/exchange, available within milliseconds
2. **Back-office (T+1)**: Settlement-confirmed P&L after reconciliation, authoritative for accounting

These can differ due to:
- Commission/fee adjustments
- Corporate actions
- Settlement failures
- Reconciliation breaks

## Decision

Use **hybrid model** with explicit status transitions:

```
PROJECTED → PROVISIONAL → FINAL
    │            │            │
    └── P1 ──────┘── P2 ─────┘
```

| Status | Source | When | Authority |
|--------|--------|------|-----------|
| `PROJECTED` | Snapshot Economics (P1) | Decision time | Pre-execution estimate |
| `PROVISIONAL` | Platform (`execution.reported`, `position.closed`) | Real-time | Operational use, not for books |
| `FINAL` | Back-office (`economics.reconciled`) | T+1 settlement | Books & records, regulatory |

## Implementation

### Storage

```sql
-- lifecycle_events table stores both platform and backoffice events
-- realized_economics tracks finalization
-- pnl_status column: 'PROJECTED' | 'PROVISIONAL' | 'FINAL'
```

### Evidence Pack

Both values preserved in evidence for audit:
```json
{
  "realized": {
    "pnl_status": "FINAL",
    "platform_pnl": 500,
    "final_pnl": 495,
    "discrepancy": -5,
    "discrepancy_percent": -1.0
  }
}
```

### UI Semantics

- Display `FINAL` when available (authoritative)
- Show `PROVISIONAL` with qualifier "pending settlement" 
- Show both if discrepancy > threshold (compliance flag)

## Rationale

1. **Regulatory requirement**: Books must match settlement, not real-time feeds
2. **Operational need**: Traders need real-time P&L for risk management
3. **Audit trail**: Must show what was known and when
4. **Discrepancy detection**: Catching breaks before T+3 reduces fails

## Alternatives Rejected

- **Platform-only**: Not acceptable for regulatory reporting
- **Back-office-only**: Too late for operational decisions
- **Reconciliation-first**: Would block operational flow

## Metrics

Track accuracy of platform provisional vs back-office final:
- `projection_accuracy`: How close was snapshot estimate?
- `discrepancy_percent`: Platform vs final variance
- `slippage_bps`: Execution price vs expected

## References

- [P2-event-contract-spec.md](../design/P2-event-contract-spec.md)
- [evidence-pack.ts](../../packages/common/src/evidence-pack.ts) - `EvidenceRealizedEconomics`
- [economics/src/index.ts](../../services/economics/src/index.ts) - `/economics/accuracy`
