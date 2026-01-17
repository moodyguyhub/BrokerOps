# Phase 13: Policies Contract Gate — Evidence Pack

Generated: `<YYYY-MM-DD>` (replace with actual date)

## Overview

This folder captures evidence artifacts from running the `ph13-policies-contract-gate.sh` script, proving that the Policies UI contract (DOM anchors, API schema, shell integration) is satisfied.

## Required Artifacts

| File | Description | Command to Generate |
|------|-------------|---------------------|
| `gate-output.txt` | Full gate script output with pass/fail summary | `./scripts/ph13-policies-contract-gate.sh > test-results/ph13-policies/<DATE>/gate-output.txt 2>&1` |
| `api-policies-status.json` | Raw API response snapshot | `curl -s http://localhost:3000/api/policies/status \| jq . > test-results/ph13-policies/<DATE>/api-policies-status.json` |
| `dom-anchors.txt` | Grep proof of required DOM IDs | See commands below |

## Commands to Run

### 1. Create evidence directory

```bash
DATE=$(date +%Y-%m-%d)
mkdir -p test-results/ph13-policies/$DATE
```

### 2. Run contract gate and capture output

```bash
./scripts/ph13-policies-contract-gate.sh > test-results/ph13-policies/$DATE/gate-output.txt 2>&1
echo "Exit code: $?" >> test-results/ph13-policies/$DATE/gate-output.txt
```

### 3. Capture API response snapshot (requires UI server running)

```bash
curl -s http://localhost:3000/api/policies/status | jq . > test-results/ph13-policies/$DATE/api-policies-status.json
```

### 4. Capture DOM anchor proof

```bash
{
  echo "=== policies.html DOM anchors ==="
  grep -n 'id="policies-state-' services/ui/public/policies.html
  echo ""
  echo "=== command-center-v2.html shell integration ==="
  grep -n 'tab-policies\|panel-policies\|policies-badge' services/ui/public/command-center-v2.html
  echo ""
  echo "=== server.js route anchors ==="
  grep -n '/api/policies/status\|normalizePolicyStatus\|/policies' services/ui/server.js | head -20
} > test-results/ph13-policies/$DATE/dom-anchors.txt
```

### 5. Capture policy bundle metadata

```bash
{
  echo "=== Policy files ==="
  ls -la policies/*.rego
  echo ""
  echo "=== Policy version ==="
  grep 'policy_version' policies/order.rego
  echo ""
  echo "=== Bundle SHA256 ==="
  cat policies/*.rego | sha256sum
} > test-results/ph13-policies/$DATE/policy-bundle.txt
```

## Expected Gate Output

A successful gate run should end with:

```
GATE_SUMMARY gate=ph13-policies passed=<N> failed=0

✅ GATE PASSED: All <N> checks passed
```

## Contract Schema

The `/api/policies/status` endpoint must return JSON matching this schema:

```json
{
  "schema_version": "1.0.0",
  "status": "ready|loading|empty|error",
  "checked_at": "<ISO8601 timestamp>",
  "bundle": {
    "policy_version": "<string or null>",
    "sha256": "<64-char hex string or null>",
    "rules_count": <integer>,
    "files_count": <integer>
  },
  "compile": {
    "state": "ok|warn|error|unknown",
    "message": "<string or null>"
  },
  "rules": [
    { "id": "<string>", "condition": "<string>", "action": "BLOCK|ALLOW" }
  ],
  "error": "<string or null>"
}
```

## DOM Anchor IDs (required)

### policies.html

| ID | Purpose |
|----|---------|
| `policies-state-loading` | Loading state container |
| `policies-state-error` | Error state container |
| `policies-state-empty` | Empty state container |
| `policies-state-ready` | Ready state container (main content) |
| `policies-status-banner` | Status banner (ok/warn/error) |
| `policies-version` | Policy version display |
| `policies-bundle-sha` | Bundle SHA256 display |
| `policies-rules-count` | Rules count display |
| `policies-compile-state` | Compile state display |

### command-center-v2.html

| ID | Purpose |
|----|---------|
| `tab-policies` | Sidebar navigation button |
| `panel-policies` | Tab panel container |
| `policies-badge` | Badge indicator (optional warnings) |

## Verification Checklist

- [ ] Gate script exits with code 0
- [ ] All static checks pass (file existence, DOM anchors, route greps)
- [ ] API returns valid JSON with `schema_version`
- [ ] API `status` field is never `undefined`
- [ ] Bundle SHA256 is computed from actual policy files
- [ ] Compile state reflects OPA reachability

## CI Integration

This gate is wired into:

- `.github/workflows/ci.yml` — `ui-contract-gates` job, Gate 15
- `.github/workflows/ph1-rc-gate.yml` — Gate 15

## Related Files

- `scripts/ph13-policies-contract-gate.sh` — Gate script
- `services/ui/public/policies.html` — Policies page
- `services/ui/public/command-center-v2.html` — Shell with tab integration
- `services/ui/server.js` — API route and normalization boundary
- `policies/order.rego` — OPA policy file
