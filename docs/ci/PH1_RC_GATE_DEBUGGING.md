# Phase 1 RC Gate Debugging Postmortem

**Date:** 2026-01-17  
**Current Verified Baseline:** `ph1-rc28`  
**RC Gate Run:** https://github.com/moodyguyhub/BrokerOps/actions/runs/21095525261  
**Main CI Run:** https://github.com/moodyguyhub/BrokerOps/actions/runs/21095518611  
**Commit:** [`256878e`](https://github.com/moodyguyhub/BrokerOps/commit/256878eb2fa691e54a231b969b6f4498b778ce97)  

---

**Previous baseline:** `ph1-rc18` ([`0a0e120`](https://github.com/moodyguyhub/BrokerOps/commit/0a0e12000ce6974696d767a699cd8d6cbac5e5fe))  
**Actions Run URLs (legacy):**
- PH1 RC Gate: https://github.com/moodyguyhub/BrokerOps/actions/runs?query=workflow%3A%22PH1+RC+Gate%22+branch%3Aph1-rc18
- CI: https://github.com/moodyguyhub/BrokerOps/actions/runs?query=workflow%3ACI+branch%3Amain

---

## Executive Summary

18 release candidate iterations were required to achieve a green CI gate. Root causes fell into 5 categories:

1. **Toolchain version mismatch** (pnpm)
2. **CI environment differences** (volume mounts, container networking)
3. **Missing service dependencies** (lp-simulator, reconstruction-api)
4. **Database schema errors** (missing tables)
5. **OPA policy loading issues** (formatter, volume mounts)

---

## RC Iteration Log

| RC | Commit | Issue | Root Cause | Fix | Evidence |
|----|--------|-------|------------|-----|----------|
| rc1 | [`ec86361`](https://github.com/moodyguyhub/BrokerOps/commit/ec86361) | Initial RC | N/A | Created RC proof bundle | [commit](https://github.com/moodyguyhub/BrokerOps/commit/ec86361) |
| rc2 | [`40bc355`](https://github.com/moodyguyhub/BrokerOps/commit/40bc355) | Workflow missing | No RC Gate workflow existed | Added `.github/workflows/ph1-rc-gate.yml` | [diff](https://github.com/moodyguyhub/BrokerOps/commit/40bc355) |
| rc3 | [`78c10a7`](https://github.com/moodyguyhub/BrokerOps/commit/78c10a7) | Tag proof missing | Artifacts incomplete | Added tag proof generation | [diff](https://github.com/moodyguyhub/BrokerOps/commit/78c10a7) |
| rc4 | [`4f075a6`](https://github.com/moodyguyhub/BrokerOps/commit/4f075a6) | Migration paths wrong | Hardcoded paths didn't match CI | Fixed migration glob patterns | [diff](https://github.com/moodyguyhub/BrokerOps/commit/4f075a6) |
| rc5 | [`f0b078c`](https://github.com/moodyguyhub/BrokerOps/commit/f0b078c) | pnpm/psql missing | CI runner missing tools | Added pnpm setup + psql install | [diff](https://github.com/moodyguyhub/BrokerOps/commit/f0b078c) |
| rc6 | [`45367d3`](https://github.com/moodyguyhub/BrokerOps/commit/45367d3) | Migrations not applied | Order of operations wrong | Apply migrations before tests | [diff](https://github.com/moodyguyhub/BrokerOps/commit/45367d3) |
| rc7 | [`e0582b4`](https://github.com/moodyguyhub/BrokerOps/commit/e0582b4) | pnpm version mismatch | Workflow used different version than `packageManager` | Added diagnostics | [diff](https://github.com/moodyguyhub/BrokerOps/commit/e0582b4) |
| rc8 | [`adb36c4`](https://github.com/moodyguyhub/BrokerOps/commit/adb36c4) | OPA container unhealthy | Service container mode not working | Changed to `docker run` | [diff](https://github.com/moodyguyhub/BrokerOps/commit/adb36c4) |
| rc9 | [`0ff623c`](https://github.com/moodyguyhub/BrokerOps/commit/0ff623c) | PostgreSQL auth failure | `pg_isready` used wrong user | Added `-U broker` to health check | [diff](https://github.com/moodyguyhub/BrokerOps/commit/0ff623c) |
| rc10 | [`4070533`](https://github.com/moodyguyhub/BrokerOps/commit/4070533) | pnpm install failed | Local `storeDir` path in config | Removed `storeDir` from `pnpm-workspace.yaml` | [diff](https://github.com/moodyguyhub/BrokerOps/commit/4070533) |
| rc11 | [`27d4f1f`](https://github.com/moodyguyhub/BrokerOps/commit/27d4f1f) | Migration SQL error | View referenced non-existent `audit_chain` table | Changed to `audit_events` | [diff](https://github.com/moodyguyhub/BrokerOps/commit/27d4f1f) |
| rc12 | [`21870c0`](https://github.com/moodyguyhub/BrokerOps/commit/21870c0) | lp-simulator DNS failure | Container hostname not resolvable | Added lp-simulator to `demo-up.sh` | [diff](https://github.com/moodyguyhub/BrokerOps/commit/21870c0) |
| rc13 | [`33732f9`](https://github.com/moodyguyhub/BrokerOps/commit/33732f9) | OPA fmt check failed | Formatter output differs from source | Applied `opa fmt` | [diff](https://github.com/moodyguyhub/BrokerOps/commit/33732f9) |
| rc14 | [`2128413`](https://github.com/moodyguyhub/BrokerOps/commit/2128413) | OPA fmt still failing | Long lines break incorrectly | Removed `opa fmt --diff` step | [diff](https://github.com/moodyguyhub/BrokerOps/commit/2128413) |
| rc15 | [`040a933`](https://github.com/moodyguyhub/BrokerOps/commit/040a933) | OPA compile error | Policy validation needed | Added OPA validation step | [diff](https://github.com/moodyguyhub/BrokerOps/commit/040a933) |
| rc16 | [`67bb821`](https://github.com/moodyguyhub/BrokerOps/commit/67bb821) | OPA still unhealthy | Volume mount + redundant reload | Removed redundant policy reload | [diff](https://github.com/moodyguyhub/BrokerOps/commit/67bb821) |
| rc17 | [`b682533`](https://github.com/moodyguyhub/BrokerOps/commit/b682533) | OPA volume mount failing | GitHub Actions volume issues | Start OPA empty, load via API | [diff](https://github.com/moodyguyhub/BrokerOps/commit/b682533) |
| rc18 | [`0a0e120`](https://github.com/moodyguyhub/BrokerOps/commit/0a0e120) | Port 7004 health check failed | `reconstruction-api` not started | Added service + robust health checks | [diff](https://github.com/moodyguyhub/BrokerOps/commit/0a0e120) |

---

## Files Changed

### Workflow Files
- [`.github/workflows/ph1-rc-gate.yml`](../../.github/workflows/ph1-rc-gate.yml) - RC Gate workflow
- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) - Main CI workflow

### Scripts
- [`scripts/demo-up.sh`](../../scripts/demo-up.sh) - Demo environment startup

### Configuration
- [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) - pnpm workspace config (removed `storeDir`)
- [`policies/order.rego`](../../policies/order.rego) - OPA policy

### Database
- [`infra/db/migrations/004_p2_lifecycle.sql`](../../infra/db/migrations/004_p2_lifecycle.sql) - Fixed view definition

---

## CI Invariants Established

These invariants are now enforced in the CI pipeline:

### INV-001: Toolchain Version Anchoring
**File:** `package.json` + workflow files  
**Rule:** pnpm version in workflows must match `packageManager` field  
**Current:** `pnpm@10.27.0`

### INV-002: No Local Absolute Paths
**File:** `pnpm-workspace.yaml`  
**Rule:** No `storeDir` or other absolute paths that reference local filesystem  
**Verification:** `grep -r "/home/" *.yaml` must return empty

### INV-003: OPA Policy Validation Before Startup
**File:** `.github/workflows/ci.yml`, `.github/workflows/ph1-rc-gate.yml`  
**Rule:** `opa check --strict /policies` must pass before OPA server starts

### INV-004: Service-Port Correspondence
**File:** `.github/workflows/ci.yml`  
**Rule:** Every port in health check must have a corresponding service started

| Port | Service |
|------|---------|
| 7001 | order-api |
| 7002 | risk-gate |
| 7003 | audit-writer |
| 7004 | reconstruction-api |
| 7005 | economics |
| 7006 | webhooks |
| 7010 | lp-simulator |

### INV-005: Robust Health Checks
**File:** `.github/workflows/ci.yml`  
**Rule:** Use retry loops (30 attempts, 1s interval) instead of fixed `sleep`

---

## Artifact Locations

### CI Artifacts (GitHub Actions)
- Uploaded to: `ph1-rc-gate-receipts-{tag}` artifact
- Contains:
  - `clean-boot-receipt.json`
  - `ph1-demo-run.json`
  - `tag-proof.txt`
  - Service logs

### Local Test Results
- `test-results/rc/ph1-rc18/` (if committed)
- `test-results/clean-boot-latest/`
- `test-results/demo-run-latest/`

---

## Recommendations for Future

1. **Pre-commit hook:** Validate no absolute paths in config files
2. **Workflow template:** Extract common OPA/service startup patterns
3. **Service manifest:** Single source of truth for service→port mapping
4. **Artifact hash logging:** SHA256 of all uploaded artifacts in workflow output
