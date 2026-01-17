# Phase 14: Policies Dealer View — Evidence Pack

> Date: 2026-01-17  
> Contract: Additive to Phase 13 (policies contract floor)  
> Gate: `ph14-policies-dealer-view-contract-gate.sh`  
> Dependency: Phase 13 must remain green

## Summary

Phase 14 adds **read-only dealer visibility** features on top of the Phase 13 policy status contract:
- **List endpoint**: `GET /api/policies/list` — list all policy files with metadata
- **Detail endpoint**: `GET /api/policies/detail?file=<name>` — view source (fail-closed allowlist)
- **Dealer view UI**: Source viewer inside `policies-state-ready` with `policies-dealer-*` anchors

## Non-Negotiables

1. Phase 13 gate must pass (all 37 checks)
2. Phase 14 gate must pass (46 checks)
3. New DOM IDs use `policies-dealer-*` prefix
4. Detail endpoint enforces allowlist (fail-closed)
5. No synthetic/fabricated metrics (blocked/allowed counts) without explicit "demo" label

## Evidence Commands

```bash
# 1. Run Phase 13 gate (must remain green)
./scripts/ph13-policies-contract-gate.sh

# 2. Run Phase 14 gate
./scripts/ph14-policies-dealer-view-contract-gate.sh

# 3. Capture list endpoint
curl -s http://localhost:3000/api/policies/list | jq .

# 4. Capture detail endpoint
curl -s "http://localhost:3000/api/policies/detail?file=order.rego" | jq .

# 5. Verify allowlist enforcement (should return 404)
curl -s "http://localhost:3000/api/policies/detail?file=EVIL.rego" | jq .
```

## Evidence Files

| File | Description |
|------|-------------|
| `gate-output.txt` | Full Phase 14 gate output |
| `api-policies-list.json` | `/api/policies/list` response |
| `api-policies-detail.json` | `/api/policies/detail?file=order.rego` response |
| `api-policies-blocked.json` | Allowlist enforcement (404) response |

## Contract Surface

### DOM Anchors (policies.html)

| ID | Purpose |
|----|---------|
| `policies-dealer-section` | Dealer view container |
| `policies-dealer-file-count` | File count badge |
| `policies-dealer-file-list` | Clickable file list |
| `policies-dealer-source-viewer` | Source viewer panel |
| `policies-dealer-source-filename` | Current file name |
| `policies-dealer-source-meta` | File metadata (version, sha256) |
| `policies-dealer-source-content` | Rego source code |

### API Endpoints

| Endpoint | Schema Version | Key Fields |
|----------|---------------|------------|
| `GET /api/policies/list` | 1.0.0 | `files[]`, `total_count`, `fetched_at` |
| `GET /api/policies/detail` | 1.0.0 | `filename`, `content`, `sha256`, `policy_version` |

### CI/RC Wiring

| Workflow | Step |
|----------|------|
| `ci.yml` | Gate 16 — ph14 Policies Dealer View Contract |
| `ph1-rc-gate.yml` | Gate 16 — ph14 Policies Dealer View Contract |

## Verification Checklist

- [ ] Phase 13 gate passes (37/37)
- [ ] Phase 14 gate passes (46/46)
- [ ] `/api/policies/list` returns valid JSON
- [ ] `/api/policies/detail?file=order.rego` returns content
- [ ] `/api/policies/detail?file=EVIL.rego` returns 404 + allowlist hint
- [ ] Dealer view renders in browser (http://localhost:3000/policies)
- [ ] Click file to view source works
- [ ] CI workflow grep shows Gate 16
