# DEC-P2-EVENT-GATEWAY

**Date:** 2026-01-15  
**Status:** Accepted  
**Context:** P2 Lifecycle Events  

## Decision

**Webhooks service is the lifecycle event gateway** for all inbound platform/back-office events.

## Rationale

Three architecture options were evaluated:

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **A: Webhooks as gateway** | All lifecycle events route through webhooks service | Single entry point, existing infra, audit-first logging | Single point of failure |
| B: Direct DB writes | Platform writes directly to lifecycle tables | Lower latency | No idempotency, no validation, audit gap |
| C: Message queue | Kafka/RabbitMQ intermediary | Decoupled, replay buffer | Infrastructure complexity, ordering harder |

**Chosen: Option A** - Webhooks service is already deployed, provides:
- Idempotency store integration (`checkAndReserve` pattern)
- Schema validation (Zod) at boundary
- AuthN enforcement (`X-Broker-API-Key` header)
- Clock skew protection (`asserted_at` + `received_at` timestamps)
- Audit trail via PostgreSQL persistence

## Endpoints

| Endpoint | Event Type | Idempotency Key |
|----------|------------|-----------------|
| `POST /events/execution` | `execution.reported` | `exec:{exec_id}` |
| `POST /events/position-closed` | `position.closed` | `close:{close_id}` |
| `POST /events/reconciliation` | `economics.reconciled` | `recon:{trade_date}:{symbol}:{account_id}` |

## Security Controls

1. **AuthN**: API key validation (`EVENT_API_KEY` env var)
2. **Schema validation**: Zod schemas reject malformed events
3. **Idempotency**: Duplicate events return 409 with `payload_mismatch` flag
4. **Timestamps**: Both source (`asserted_at`) and server (`received_at`) recorded

## Alternatives Rejected

- **Direct DB access**: Would bypass idempotency and validation
- **Separate gateway service**: Unnecessary given webhooks service exists
- **Client-side idempotency only**: Server must enforce to be authoritative

## References

- [P2-event-contract-spec.md](../design/P2-event-contract-spec.md)
- [webhooks/src/index.ts](../../services/webhooks/src/index.ts)
- [idempotency-store.ts](../../packages/common/src/idempotency-store.ts)
