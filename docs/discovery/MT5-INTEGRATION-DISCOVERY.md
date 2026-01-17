# MT5 Integration Discovery (Gate 2 v0)

**Status:** UNVERIFIED HYPOTHESIS (evidence-backed for EA localhost advisory path only)  
**Date:** 2026-01-16  
**Owner:** Principal  

---

## Scope

This document separates what is **provable without broker cooperation** from what **requires broker access**. Every claim is tied to a local evidence file in [docs/discovery/mt5-evidence/](docs/discovery/mt5-evidence/).

---

## Evidence Pack (Gate 2 v0)

Evidence folder: [docs/discovery/mt5-evidence](docs/discovery/mt5-evidence)

Files:
- [docs/discovery/mt5-evidence/ea-http-bridge-log.txt](docs/discovery/mt5-evidence/ea-http-bridge-log.txt)
- [docs/discovery/mt5-evidence/mt5-terminal-config.txt](docs/discovery/mt5-evidence/mt5-terminal-config.txt)
- [docs/discovery/mt5-evidence/latency-sample.csv](docs/discovery/mt5-evidence/latency-sample.csv)
- [docs/discovery/mt5-evidence/CHECKSUMS.sha256](docs/discovery/mt5-evidence/CHECKSUMS.sha256)

Checksum verification:
```
cd docs/discovery/mt5-evidence
sha256sum -c CHECKSUMS.sha256
```

---

## What is Provable Without a Broker

### 1) EA → HTTP Bridge (localhost advisory)

**Claim:** An EA-style HTTP bridge can call BrokerOps `/v1/authorize` locally and receive a signed decision token.  
**Evidence:**
- [docs/discovery/mt5-evidence/ea-http-bridge-log.txt](docs/discovery/mt5-evidence/ea-http-bridge-log.txt)
- [docs/discovery/mt5-evidence/latency-sample.csv](docs/discovery/mt5-evidence/latency-sample.csv)

**Interpretation:** Advisory only. No broker enforcement is proven.

### 2) Local environment snapshot

**Claim:** The current host has no broker-configured MT5 terminal; evidence records that state.  
**Evidence:** [docs/discovery/mt5-evidence/mt5-terminal-config.txt](docs/discovery/mt5-evidence/mt5-terminal-config.txt)

---

## What Requires Broker Cooperation (Blocked)

### Manager API feasibility
- **Needed:** Manager API endpoint + credentials, permitted method list/scope, and test environment.
- **Status:** BLOCKED (no broker inputs).

### MT5 server plugin feasibility
- **Needed:** Plugin SDK availability/terms, broker approval window, install + test access.
- **Status:** BLOCKED (no broker inputs).

### Dealer-grade enforcement claims
- **Needed:** Proof of broker-side enforcement point (dealer/plugin/bridge) and logs from broker environment.
- **Status:** BLOCKED (no broker inputs).

---

## Broker Input Checklist (Exact Asks)

1. **Manager API**
   - Endpoint URL
   - Auth method + credentials
   - Allowed method list + rate limits
   - Sandbox/test account

2. **Server Plugin / Dealer API**
   - SDK access/terms
   - Supported hook points
   - Installation/test window

3. **Operational Constraints**
   - Latency constraints
   - Environment topology
   - Logging/trace export requirements

---

## Harness

Run the evidence harness to regenerate the pack:

```
./scripts/g2-mt5-ea-bridge-sample.sh
```

---

## Claims Table (Gate 2 v0)

| Capability | Provable without broker? | Evidence | Status |
| --- | --- | --- | --- |
| EA HTTP bridge to `/v1/authorize` | Yes (advisory) | ea-http-bridge-log.txt, latency-sample.csv | PROVEN (local only) |
| MT5 terminal configured with broker | No | mt5-terminal-config.txt (shows unavailable) | UNVERIFIED |
| Manager API capabilities | No | None | UNVERIFIED |
| MT5 server plugin feasibility | No | None | UNVERIFIED |

---

## Notes

This is a **v0 discovery pack**. It proves a local advisory path only. Any execution-grade or broker-claimable statements remain **UNVERIFIED** until broker evidence is captured.
