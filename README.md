# BrokerOps MVP v0

**Order → Risk Policy → Audit Append-Only → Trace Reconstruction**

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│  order-api  │────▶│ risk-gate   │     │ audit-writer │
│   :7001     │     │   :7002     │     │    :7003     │
└──────┬──────┘     └─────────────┘     └──────────────┘
       │                                       ▲
       └───────────────────────────────────────┘
                                               │
                                        ┌──────┴──────┐
                                        │  Postgres   │
                                        │   :5434     │
                                        └──────┬──────┘
                                               │
                                    ┌──────────┴──────────┐
                                    │ reconstruction-api  │
                                    │       :7004         │
                                    └─────────────────────┘
```

## Quick Start

### Prerequisites
- Node.js 20+
- Docker + docker compose
- pnpm

### Start Infrastructure
```bash
docker compose up -d
```

### Apply DB Migrations
```bash
docker exec -i broker-postgres psql -U broker -d broker < infra/sql/001_init.sql
```

### Install & Build
```bash
pnpm -r install
pnpm -r build
```

### Run Services
```bash
node services/risk-gate/dist/index.js &        # :7002
node services/audit-writer/dist/index.js &     # :7003
node services/order-api/dist/index.js &        # :7001
node services/reconstruction-api/dist/index.js & # :7004
```

## API Examples

### Submit Order (ACCEPT)
```bash
curl -X POST http://localhost:7001/orders \
  -H "content-type: application/json" \
  -d '{"clientOrderId":"abc-1","symbol":"AAPL","side":"BUY","qty":5,"price":187.2}'
```

### Submit Order (BLOCK - qty limit)
```bash
curl -X POST http://localhost:7001/orders \
  -H "content-type: application/json" \
  -d '{"clientOrderId":"abc-2","symbol":"AAPL","side":"BUY","qty":50000}'
```

### Submit Order (BLOCK - symbol restriction)
```bash
curl -X POST http://localhost:7001/orders \
  -H "content-type: application/json" \
  -d '{"clientOrderId":"gme-1","symbol":"GME","side":"BUY","qty":20}'
```

### Reconstruct Trace
```bash
curl http://localhost:7004/trace/{traceId}
```

## Services

| Service | Port | Description |
|---------|------|-------------|
| order-api | 7001 | Order entry, orchestrates risk check + audit |
| risk-gate | 7002 | Policy engine (code-based for v0) |
| audit-writer | 7003 | Append-only audit log with hash chain |
| reconstruction-api | 7004 | Trace reconstruction from audit log |

## Risk Policy (v0.1)

- **QTY_LIMIT_EXCEEDED**: qty > 1000
- **SYMBOL_RESTRICTION**: GME with qty > 10

## P0 Success Condition ✅

Given a `traceId`, we can reconstruct:
- ✅ The order request
- ✅ The policy decision (allow/block + reason code + policy version)
- ✅ The audit log record (immutable append-only with hash chain)

## Phase 2 (Day 2+)
- [ ] OPA integration for policy engine
- [ ] Kafka event streaming
- [ ] Command Center UI
