# BrokerOps

[![CI](https://github.com/YOUR_USERNAME/BrokerOps/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_USERNAME/BrokerOps/actions/workflows/ci.yml)

**Brokerage Operations Governance Platform**

> Given a traceId, we can explain exactly why something happened — what was requested, why it was blocked/allowed, who overrode it, and what economic impact resulted.

## 🎯 Product Thesis

BrokerOps provides **governance-as-code** for brokerage operations:

1. **Policy Engine** — OPA/Rego-based rules (qty limits, symbol restrictions)
2. **Tamper-Evident Audit** — SHA-256 hash-chained append-only log
3. **Dual-Control Override** — Human-in-the-loop with separation of duties
4. **Decision Economics** — Track P&L impact of every policy decision
5. **Trace Reconstruction** — Full explainability for any order decision

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           BrokerOps Governance                           │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   ┌─────────┐    ┌───────────┐    ┌──────────────┐    ┌──────────────┐  │
│   │ order   │───▶│ risk-gate │───▶│ audit-writer │───▶│   Postgres   │  │
│   │  :7001  │    │   :7002   │    │    :7003     │    │    :5434     │  │
│   └────┬────┘    └─────┬─────┘    └──────────────┘    └───────┬──────┘  │
│        │               │                                      │         │
│        │          ┌────┴────┐                                 │         │
│        │          │   OPA   │                                 │         │
│        │          │  :8181  │                                 │         │
│        │          └─────────┘                                 │         │
│        │                                                      │         │
│   ┌────┴────────────────────────────────────────────────┐    │         │
│   │                    webhooks :7006                    │    │         │
│   └─────────────────────────────────────────────────────┘    │         │
│        │                                                      │         │
│   ┌────┴─────────┐    ┌───────────────┐    ┌─────────────┐   │         │
│   │  economics   │    │ reconstruction│───▶│    UI       │   │         │
│   │    :7005     │    │     :7004     │    │   :3000     │   │         │
│   └──────────────┘    └───────────────┘    └─────────────┘   │         │
│                                                              │         │
└──────────────────────────────────────────────────────────────────────────┘
```

## 🚀 Quick Start

### Prerequisites
- Node.js 20+ (see `.nvmrc`)
- Docker + Docker Compose
- pnpm

### One-Command Demo

```bash
# Clone and run the full demo
git clone https://github.com/YOUR_USERNAME/BrokerOps.git
cd BrokerOps
pnpm install
./scripts/demo.sh
```

This will:
1. Start Postgres + OPA containers
2. Build all services
3. Run a complete governance scenario (block → override → approve)
4. Display the trace bundle with hash chain verification
5. Launch the UI dashboard

### Manual Setup

```bash
# 1. Start infrastructure
docker compose up -d

# 2. Apply migrations
docker exec -i broker-postgres psql -U broker -d broker < infra/sql/001_init.sql

# 3. Install and build
pnpm install
pnpm -r build

# 4. Start services (in separate terminals or background)
node services/risk-gate/dist/index.js &        # :7002
node services/audit-writer/dist/index.js &     # :7003
node services/order-api/dist/index.js &        # :7001
node services/reconstruction-api/dist/index.js & # :7004
node services/economics/dist/index.js &        # :7005
node services/webhooks/dist/index.js &         # :7006
node services/ui/server.js &                   # :3000
```

### Access Points

| Interface | URL | Description |
|-----------|-----|-------------|
| **UI Dashboard** | http://localhost:3000 | Governance dashboard (traces, bundles, webhooks) |
| **OpenAPI Spec** | [docs/openapi.yaml](docs/openapi.yaml) | Full API documentation |
| **OPA Playground** | http://localhost:8181 | Policy engine |

## 📡 Services

| Service | Port | Description |
|---------|------|-------------|
| `order-api` | 7001 | Order entry + dual-control override orchestration |
| `risk-gate` | 7002 | OPA-backed policy engine |
| `audit-writer` | 7003 | Hash-chained append-only audit log |
| `reconstruction-api` | 7004 | Trace bundles + recent traces API |
| `economics` | 7005 | Decision P&L tracking |
| `webhooks` | 7006 | Event notifications to external systems |
| `ui` | 3000 | Governance dashboard |

## 🛡️ Policy Engine (OPA/Rego)

Current policy rules (`policies/order.rego`):

| Rule ID | Condition | Action |
|---------|-----------|--------|
| `qty_limit` | qty > 1000 | BLOCK |
| `symbol_gme` | symbol = GME ∧ qty > 10 | BLOCK |
| `allow_default` | otherwise | ALLOW |

```rego
# Example: Block GME orders over 10 shares
block[decision] {
    input.symbol == "GME"
    input.qty > 10
    decision := {
        "reasonCode": "SYMBOL_RESTRICTION",
        "ruleId": "symbol_gme",
        "message": "GME restricted: qty exceeds threshold (10)"
    }
}
```

## 🔐 Dual-Control Override Flow

```
1. Order BLOCKED by policy
2. Operator A requests override → OVERRIDE_REQUESTED
3. Operator A tries to self-approve → DUAL_CONTROL_VIOLATION ❌
4. Operator B approves → OVERRIDE_APPROVED ✅
5. All steps recorded in hash-chained audit trail
```

## 📊 API Examples

### Submit Order
```bash
curl -X POST http://localhost:7001/orders \
  -H "content-type: application/json" \
  -d '{"clientOrderId":"abc-1","symbol":"AAPL","side":"BUY","qty":5,"price":187.2}'
```

### Get Trace Bundle
```bash
curl http://localhost:7004/trace/{traceId}/bundle
```

### Request Override
```bash
curl -X POST http://localhost:7001/override/{traceId}/request \
  -H "content-type: application/json" \
  -d '{"operatorId":"ops-alice","reason":"Client exception","newDecision":"ALLOW"}'
```

### Approve Override (different operator)
```bash
curl -X POST http://localhost:7001/override/{traceId}/approve \
  -H "content-type: application/json" \
  -d '{"operatorId":"ops-bob","comment":"Reviewed and approved"}'
```

## 📦 Evidence Pack

Generate a board-ready evidence pack for any trace:

```bash
./scripts/evidence_pack.sh <traceId>
```

Produces a ZIP with:
- `trace_bundle.json` — Full trace with hash chain
- `policy_version.txt` — Policy snapshot at decision time
- `economics/` — P&L impact data
- `manifest.json` — Pack metadata

## 🔗 Integrations

### Webhooks

Register webhooks to receive governance events:

```bash
curl -X POST http://localhost:7006/webhooks \
  -H "content-type: application/json" \
  -d '{"url":"https://your-system/webhook","events":["order.blocked","override.approved"]}'
```

### MetaTrader 5 Adapter

See `adapters/mt5/adapter.py` for broker integration skeleton.

### OpenAPI

Full API contract at [`docs/openapi.yaml`](docs/openapi.yaml) — vendor-neutral, ready for partner integration.

## 🧪 Testing

```bash
# Run policy tests (10 scenarios)
pnpm test

# Run CI locally
act -j test
```

## 📁 Project Structure

```
BrokerOps/
├── services/           # Microservices
│   ├── order-api/      # Order entry + override
│   ├── risk-gate/      # OPA policy gateway
│   ├── audit-writer/   # Hash-chained audit
│   ├── reconstruction-api/  # Trace bundles
│   ├── economics/      # Decision P&L
│   ├── webhooks/       # Event notifications
│   └── ui/             # Governance dashboard
├── packages/
│   └── common/         # Shared types + utilities
├── policies/           # OPA Rego policies
├── adapters/           # Broker integrations
├── docs/               # OpenAPI spec
├── scripts/            # Demo + evidence pack
├── tests/              # Policy tests
└── infra/              # SQL migrations
```

## 🎬 Demo Output

```
═══════════════════════════════════════════════════════════════
  TRACE BUNDLE SUMMARY
═══════════════════════════════════════════════════════════════
{
  "traceId": "trace-abc123",
  "originalDecision": "BLOCKED",
  "finalDecision": "ALLOW",
  "policyVersion": "policy.v0.2",
  "hashChainValid": true,
  "overrideApplied": true,
  "dualControlVerified": true
}

Hash Chain (integrity verified):
"ORDER_SUBMITTED → 7f83b165..."
"POLICY_DECISION → a591a6d4..."
"OVERRIDE_REQUESTED → 3c6e0b8a..."
"OVERRIDE_APPROVED → 2c26b46b..."

[✓] Hash chain integrity: VERIFIED
```

## 📋 License

MIT

---

**BrokerOps** — Governance as code. Every decision explained.
