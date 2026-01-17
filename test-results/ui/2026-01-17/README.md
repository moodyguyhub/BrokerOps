# UI Evidence Pack — 2026-01-17

## Summary

This evidence pack validates **P0 Alerts Coherence** and **Phase 4-6 UI Kit Integration**.

## Screenshots

| File | URL | Validates |
|------|-----|-----------|
| `command-center.png` | `/command-center-v2` | Shell coherence: Server=All Servers, badges=3, KPI=3, Active Alerts list=3 titled rows |
| `alerts.png` | `/alerts` | Standalone alerts: Total Active=3, Critical=1, Warning=1, table=3 rows |
| `alerts-embed.png` | `/alerts?embed=1` | Embedded alerts: same 3 rows, context chip "All Servers • 24h" |
| `lp-accounts.png` | `/lp-accounts` | LP Accounts with explicit empty/loading state |

## Gate Outputs

| Gate | File | Status |
|------|------|--------|
| Gate 4 (LP Accounts) | `ph4-lp-accounts-gate.txt` | PASSED |
| Gate 5 (Alerts) | `ph5-alerts-gate.txt` | PASSED |
| Gate 6 (Shell) | `ph6-shell-gate.txt` | PASSED |

## Verification Commands

```bash
# Run all UI gates
./scripts/ph4-lp-accounts-contract-gate.sh
./scripts/ph5-alerts-contract-gate.sh
./scripts/ph6-shell-contract-gate.sh

# Verify API coherence
curl -s http://localhost:3000/api/alerts | jq '.data | length'
# Expected: 3
```

## Coherence Proof

All of the following show **count = 3**:
- Shell header alert badge
- Shell sidebar alert badge
- Dashboard "Open Alerts" KPI
- Dashboard "Active Alerts" list
- Standalone `/alerts` Total Active
- Embedded `/alerts?embed=1` Total Active

## PR Acceptance Criteria

- [x] CI green with Gates 1-8
- [x] Evidence pack exists in-repo
- [x] LP Accounts shows non-blank state (empty/error/loading)
- [x] No `undefined` in any UI element
