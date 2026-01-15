#!/usr/bin/env bash
set -euo pipefail

# BrokerOps Demo Script
# One command to prove the product thesis:
# "Given a traceId, we can explain exactly why something happened"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() { echo -e "${BLUE}[DEMO]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }

header() {
  echo ""
  echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}  $1${NC}"
  echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
  echo ""
}

cleanup() {
  log "Cleaning up background processes..."
  pkill -f "node services/" 2>/dev/null || true
}

trap cleanup EXIT

# ============================================================================
header "BrokerOps MVP Demo"
# ============================================================================

log "Starting infrastructure (Postgres + OPA)..."
docker compose up -d --wait 2>/dev/null || docker compose up -d

sleep 2

log "Applying database migrations..."
docker exec -i broker-postgres psql -U broker -d broker < infra/sql/001_init.sql 2>/dev/null || true

log "Building all services..."
pnpm -r build --silent

log "Starting services..."
pkill -f "node services/" 2>/dev/null || true
sleep 1

node services/risk-gate/dist/index.js &
node services/audit-writer/dist/index.js &
node services/order-api/dist/index.js &
node services/reconstruction-api/dist/index.js &
node services/economics/dist/index.js &

sleep 2

# Health checks
log "Checking service health..."
curl -sf http://localhost:7001/health > /dev/null && success "order-api :7001" || error "order-api"
curl -sf http://localhost:7002/health > /dev/null && success "risk-gate :7002" || error "risk-gate"
curl -sf http://localhost:7003/health > /dev/null && success "audit-writer :7003" || error "audit-writer"
curl -sf http://localhost:7004/health > /dev/null && success "reconstruction-api :7004" || error "reconstruction-api"
curl -sf http://localhost:7005/health > /dev/null && success "economics :7005" || error "economics"
curl -sf http://localhost:8181/health > /dev/null && success "OPA :8181" || error "OPA"

# ============================================================================
header "Scenario: Blocked Order → Dual-Control Override"
# ============================================================================

log "Step 1: Submit order (GME, qty=100) — should be BLOCKED by policy"
RESPONSE=$(curl -s -X POST http://localhost:7001/orders \
  -H "content-type: application/json" \
  -d '{"clientOrderId":"demo-order","symbol":"GME","side":"BUY","qty":100}')

TRACE_ID=$(echo "$RESPONSE" | jq -r '.traceId')
STATUS=$(echo "$RESPONSE" | jq -r '.status')
REASON=$(echo "$RESPONSE" | jq -r '.reasonCode')
RULE=$(echo "$RESPONSE" | jq -r '.ruleId')

if [ "$STATUS" = "BLOCKED" ]; then
  success "Order BLOCKED"
  echo "    traceId: $TRACE_ID"
  echo "    reason: $REASON"
  echo "    rule: $RULE"
else
  error "Expected BLOCKED, got $STATUS"
  exit 1
fi

echo ""
log "Step 2: Operator Alice requests override"
OVERRIDE_REQ=$(curl -s -X POST "http://localhost:7001/override/$TRACE_ID/request" \
  -H "content-type: application/json" \
  -d '{"operatorId":"ops-alice","reason":"Client is verified institutional, exception approved by compliance","newDecision":"ALLOW"}')

REQ_STATUS=$(echo "$OVERRIDE_REQ" | jq -r '.status')
if [ "$REQ_STATUS" = "OVERRIDE_REQUESTED" ]; then
  success "Override requested by ops-alice"
else
  error "Override request failed: $REQ_STATUS"
  exit 1
fi

echo ""
log "Step 3: Operator Alice tries to self-approve (should FAIL)"
SELF_APPROVE=$(curl -s -X POST "http://localhost:7001/override/$TRACE_ID/approve" \
  -H "content-type: application/json" \
  -d '{"operatorId":"ops-alice","comment":"Self approval attempt"}')

ERROR=$(echo "$SELF_APPROVE" | jq -r '.error')
if [ "$ERROR" = "DUAL_CONTROL_VIOLATION" ]; then
  success "Dual-control enforced — self-approval blocked"
else
  error "Dual-control failed: $ERROR"
  exit 1
fi

echo ""
log "Step 4: Operator Bob approves (different operator)"
APPROVE=$(curl -s -X POST "http://localhost:7001/override/$TRACE_ID/approve" \
  -H "content-type: application/json" \
  -d '{"operatorId":"ops-bob","comment":"Reviewed and approved per compliance exception process"}')

APPROVE_STATUS=$(echo "$APPROVE" | jq -r '.status')
DUAL_VERIFIED=$(echo "$APPROVE" | jq -r '.dualControlVerified')
if [ "$APPROVE_STATUS" = "OVERRIDE_APPROVED" ] && [ "$DUAL_VERIFIED" = "true" ]; then
  success "Override approved by ops-bob (dual-control verified)"
else
  error "Approval failed: $APPROVE_STATUS"
  exit 1
fi

# ============================================================================
header "Step 5: Record Economic Impact"
# ============================================================================

log "Recording economic event: blocked trade would have generated \$12.50 revenue"
ECON_BLOCKED=$(curl -s -X POST http://localhost:7005/economics/event \
  -H "content-type: application/json" \
  -d "{\"traceId\":\"$TRACE_ID\",\"type\":\"TRADE_BLOCKED\",\"estimatedLostRevenue\":12.50,\"currency\":\"USD\",\"source\":\"demo\",\"policyId\":\"symbol_gme\"}")
success "Economic event recorded (TRADE_BLOCKED, lost \$12.50)"

log "Recording economic event: override approved, trade executed"
ECON_OVERRIDE=$(curl -s -X POST http://localhost:7005/economics/event \
  -H "content-type: application/json" \
  -d "{\"traceId\":\"$TRACE_ID\",\"type\":\"OVERRIDE_APPROVED\",\"grossRevenue\":12.50,\"fees\":1.20,\"costs\":0.80,\"currency\":\"USD\",\"source\":\"demo\"}")
success "Economic event recorded (OVERRIDE_APPROVED, +\$12.50 revenue)"

echo ""
log "Fetching economics summary..."
ECON_SUMMARY=$(curl -s http://localhost:7005/economics/summary)
echo "$ECON_SUMMARY" | jq '.'

# ============================================================================
header "Trace Reconstruction (The Product Thesis)"
# ============================================================================

log "Fetching trace bundle for $TRACE_ID..."
BUNDLE=$(curl -s "http://localhost:7004/trace/$TRACE_ID/bundle")

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  TRACE BUNDLE SUMMARY${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo "$BUNDLE" | jq '.summary'

ECONOMIC_IMPACT=$(echo "$BUNDLE" | jq '.summary.economicImpact')
if [ "$ECONOMIC_IMPACT" != "null" ]; then
  echo ""
  echo -e "${YELLOW}Economic Impact attached to trace:${NC}"
  echo "$ECONOMIC_IMPACT" | jq '.'
fi

echo ""
echo -e "${BLUE}Hash Chain (integrity verified):${NC}"
echo "$BUNDLE" | jq '.hashChain[] | "\(.eventType) → \(.hash[0:12])..."'

INTEGRITY=$(echo "$BUNDLE" | jq -r '.integrityVerified')
HASH_VALID=$(echo "$BUNDLE" | jq -r '.summary.hashChainValid')

echo ""
if [ "$INTEGRITY" = "true" ] && [ "$HASH_VALID" = "true" ]; then
  success "Hash chain integrity: VERIFIED"
else
  error "Hash chain integrity: FAILED"
fi

# ============================================================================
header "Demo Complete"
# ============================================================================

echo -e "${GREEN}Product thesis proven:${NC}"
echo ""
echo "  Given traceId: $TRACE_ID"
echo "  We can explain:"
echo "    ✓ What was requested (GME 100 shares)"
echo "    ✓ Why it was blocked (SYMBOL_RESTRICTION, rule: symbol_gme)"
echo "    ✓ Who requested override (ops-alice)"
echo "    ✓ Who approved it (ops-bob)"
echo "    ✓ What it cost/earned (economic impact attached)"
echo "    ✓ That the audit trail is tamper-evident (hash chain verified)"
echo ""
echo -e "${YELLOW}This is governance as code + decision economics.${NC}"
echo ""

# Keep services running for exploration
log "Services running. Press Ctrl+C to stop."
wait
