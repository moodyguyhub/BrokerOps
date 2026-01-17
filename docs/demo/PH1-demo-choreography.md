# PH1 Demo Choreography

**Duration:** 6–8 minutes  
**Audience:** Chief Dealer / Operations Lead with multi-server pain

---

## Pre-Demo Setup (before meeting)

```bash
./scripts/ph1-demo-run.sh
```

Output pack location: `test-results/demo-pack-<timestamp>/SUMMARY.md`

---

## Step-by-Step Flow

### Step 1: Context Setting (30 sec)

**Open:** Terminal showing the SUMMARY.md from the demo pack.

**Say:**
- "We've built the governance layer that sits between your trading servers and LP execution."
- "Today I'll show you how it captures every order decision with cryptographic proof—across multiple servers."

---

### Step 2: Run the Demo Pipeline (1 min)

**Action:** If not already run, execute:
```bash
./scripts/ph1-demo-run.sh
```

**Say:**
- "One command starts the full pipeline: simulator, audit writer, and reconstruction API."
- "This simulates order flow from two MT5 servers—Server 1 and Server 2."

**Clarify:** _"The order events are simulated today. In Phase 2, these come live from your MT5 Manager API."_

---

### Step 3: Show the UI – All Servers View (1.5 min)

**Open:** http://localhost:3000/?server_id=all&policy_scope=all

**Say:**
- "This is the unified dashboard. You see order flow from both servers in one place."
- "The 'Total exposure across servers' card shows aggregated volume—labeled DEMO because it's derived from simulated events."

**Clarify:** _"Truvesta has decision authority—we record and analyze. Execution authority stays with your MT5 servers."_

---

### Step 4: Filter to Server 1 (1 min)

**Open:** http://localhost:3000/?server_id=srv-1&policy_scope=srv-1

**Say:**
- "Here's Server 1 only. Each order shows its origin server."
- "The LP timeline below lists every lifecycle event: sent, ack, fill, reject."

**Clarify:** _"This filtering is real. Multi-server policy enforcement is Phase 2."_

---

### Step 5: Filter to Server 2 (1 min)

**Open:** http://localhost:3000/?server_id=srv-2&policy_scope=srv-2

**Say:**
- "Same view, different server. Notice the server tag in each row."
- "Rejection reasons are normalized—'PRICE_SLIPPAGE', 'RISK_LIMIT'—so you can aggregate across LPs."

---

### Step 6: Show Evidence Pack (1 min)

**Action:** Open the evidence JSON path from SUMMARY.md (e.g., `test-results/golden-path-<ts>/tc006-evidence.json`).

**Say:**
- "Every decision is hash-chained. This evidence pack proves the audit trail is tamper-evident."
- "If regulators ask 'show me the order history for Server 2 on this date,' we export this."

**Clarify:** _"Hash chain integrity is real and verified. This is production-grade audit infrastructure."_

---

### Step 7: Show Golden Path Receipt (30 sec)

**Action:** Show `test-results/ph1-golden-path-latest.json`.

**Say:**
- "Automated tests verify the pipeline: full fills, rejections, partial fills, multi-server identity."
- "7 out of 7 tests passed. Determinism verified—same inputs, same outputs, every time."

---

### Step 8: Close + Ask (1 min)

**Say:**
- "Phase 1 proves the data layer works. Phase 2 adds real MT5 integration and consolidated exposure."
- "To proceed, we need: (1) MT5 Manager API access to your test server, (2) confirmation of your Phase 2 timeline."

---

## NOT IN SCOPE TODAY

| Capability | Status |
|------------|--------|
| Real multi-server enforcement | Phase 2 |
| Real consolidated exposure ledger | Phase 2 (Shadow Ledger must be proven) |
| MT5 pre-trade enforcement | Phase 2 |
| Live LP connectivity | Phase 2 |

---

## UI URLs Reference

| View | URL |
|------|-----|
| All Servers | http://localhost:3000/?server_id=all&policy_scope=all |
| Server 1 | http://localhost:3000/?server_id=srv-1&policy_scope=srv-1 |
| Server 2 | http://localhost:3000/?server_id=srv-2&policy_scope=srv-2 |

---

## Artifact Locations

- Demo pack: `test-results/demo-pack-<timestamp>/SUMMARY.md`
- Receipt: `test-results/ph1-golden-path-latest.json`
- Run log: `test-results/ph1-golden-path-run.log`
- UI checklist: `test-results/ui-proof-latest/UI-CHECKLIST.md`
