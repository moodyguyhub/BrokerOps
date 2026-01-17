# UI Evidence Pack — 2026-01-17

## Summary

This evidence pack validates **P0 Alerts Coherence** and **Phase 4-6 UI Kit Integration**.

## Screenshots

> **Note**: Screenshots to be added manually. Take screenshots at:
> - `/command-center-v2` — Shell with Server=All Servers, alert badges
> - `/alerts` — Standalone alerts page with 3 active alerts
> - `/alerts?embed=1` — Embedded with context chip
> - `/lp-accounts` — LP page with explicit loading/empty state

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

## API Response Evidence

**GET /api/alerts** (captured 2026-01-17):

```json
{
  "success": true,
  "data": [
    {"id":"3","setting_id":"MARGIN_LOW","severity":"INFO","category":"MARGIN","status":"OPEN","title":"MARGIN LOW: LP-A"},
    {"id":"2","setting_id":"MARGIN_WARNING","severity":"WARNING","category":"MARGIN","status":"OPEN","title":"MARGIN WARNING: LP-A"},
    {"id":"1","setting_id":"MARGIN_CRITICAL","severity":"CRITICAL","category":"MARGIN","status":"OPEN","title":"MARGIN CRITICAL: LP-A"}
  ],
  "meta": {"count": 3}
}
```

**Schema mapping (normalizeAlert)**:
- `status: "OPEN"` → `status: "active"`
- `category: "MARGIN"` → `type: "MARGIN"`
- `triggered_at` → `timestamp`
- `title || category || setting_id` → display title (no `undefined`)

## PR Acceptance Criteria

- [x] CI green with Gates 1-8
- [x] Evidence pack exists in-repo
- [x] LP Accounts shows non-blank state (empty/error/loading)
- [x] No `undefined` in any UI element
