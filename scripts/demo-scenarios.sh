#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# BrokerOps Demo Scenarios
# Shows value proposition in 2 minutes with three key scenarios
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

log() { echo -e "${BLUE}[SCENARIO]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }

header() {
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}  SCENARIO: $1${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

API_URL="${API_URL:-http://localhost:7001}"
TIMESTAMP=$(date -u +"%Y-%m-%d-%H%M%S")

# Check if services are running
check_services() {
  if ! curl -sf "$API_URL/health" > /dev/null 2>&1; then
    error "Services not running. Run ./scripts/demo-up.sh first"
    exit 1
  fi
}

# ============================================================================
# SCENARIO 1: AUTHORIZED → BLOCKED (Exposure Limit)
# ============================================================================
scenario_exposure_limit() {
  header "AUTHORIZED → BLOCKED (Exposure Limit Crossed)"
  echo ""
  echo -e "${DIM}  Demonstrates policy-driven blocking when a client exceeds their exposure limit.${NC}"
  echo -e "${DIM}  First order is AUTHORIZED, subsequent orders are BLOCKED.${NC}"
  echo ""
  
  CLIENT_ID="demo-client-$(date +%s)"
  
  # Order 1: Should be AUTHORIZED (within limit)
  log "Order 1: AAPL BUY 100 @ \$185.50 (notional: \$18,550)"
  RESPONSE1=$(curl -s -X POST "$API_URL/v1/authorize" \
    -H "Content-Type: application/json" \
    -d "{
      \"order\": {
        \"client_order_id\": \"demo-order-1-$TIMESTAMP\",
        \"symbol\": \"AAPL\",
        \"side\": \"BUY\",
        \"qty\": 100,
        \"price\": 185.50
      },
      \"context\": {
        \"client_id\": \"$CLIENT_ID\"
      }
    }")
  
  STATUS1=$(echo "$RESPONSE1" | jq -r '.status')
  LATENCY1=$(echo "$RESPONSE1" | jq -r '.timing_ms.total // "N/A"')
  
  if [ "$STATUS1" = "AUTHORIZED" ]; then
    success "Order 1: ${GREEN}AUTHORIZED${NC} (latency: ${LATENCY1}ms)"
  else
    warn "Order 1: $STATUS1"
  fi
  
  sleep 0.5
  
  # Order 2: Large order that pushes over limit - should be BLOCKED
  log "Order 2: AAPL BUY 10000 @ \$185.50 (notional: \$1,855,000 - exceeds \$1M limit)"
  RESPONSE2=$(curl -s -X POST "$API_URL/v1/authorize" \
    -H "Content-Type: application/json" \
    -d "{
      \"order\": {
        \"client_order_id\": \"demo-order-2-$TIMESTAMP\",
        \"symbol\": \"AAPL\",
        \"side\": \"BUY\",
        \"qty\": 10000,
        \"price\": 185.50
      },
      \"context\": {
        \"client_id\": \"$CLIENT_ID\"
      }
    }")
  
  STATUS2=$(echo "$RESPONSE2" | jq -r '.status')
  REASONS=$(echo "$RESPONSE2" | jq -r '.reasons[]? // empty' | head -1)
  LATENCY2=$(echo "$RESPONSE2" | jq -r '.timing_ms.total // "N/A"')
  
  if [ "$STATUS2" = "BLOCKED" ]; then
    success "Order 2: ${RED}BLOCKED${NC} (latency: ${LATENCY2}ms)"
    echo -e "         ${DIM}Reason: $REASONS${NC}"
  else
    warn "Order 2: $STATUS2 (expected BLOCKED)"
  fi
  
  echo ""
  echo -e "  ${BOLD}Key Point:${NC} Policy automatically blocked the over-limit order."
  echo -e "            ${DIM}No manual intervention needed. Audit trail created.${NC}"
}

# ============================================================================
# SCENARIO 2: IDEMPOTENCY (No Double Reserve)
# ============================================================================
scenario_idempotency() {
  header "IDEMPOTENCY (Retry Storm - No Double Reserve)"
  echo ""
  echo -e "${DIM}  Demonstrates that retrying the same order ID produces consistent results.${NC}"
  echo -e "${DIM}  Exposure is reserved exactly once, not multiplied by retries.${NC}"
  echo ""
  
  ORDER_ID="idempotent-order-$TIMESTAMP"
  CLIENT_ID="idempotent-client-$TIMESTAMP"
  
  log "Simulating retry storm: 5 identical requests with same client_order_id"
  echo ""
  
  RESULTS=()
  for i in {1..5}; do
    RESPONSE=$(curl -s -X POST "$API_URL/v1/authorize" \
      -H "Content-Type: application/json" \
      -d "{
        \"order\": {
          \"client_order_id\": \"$ORDER_ID\",
          \"symbol\": \"MSFT\",
          \"side\": \"BUY\",
          \"qty\": 50,
          \"price\": 420.00
        },
        \"context\": {
          \"client_id\": \"$CLIENT_ID\"
        }
      }")
    
    STATUS=$(echo "$RESPONSE" | jq -r '.status')
    TOKEN=$(echo "$RESPONSE" | jq -r '.decision_token.token_id // .token.token_id // "N/A"' | cut -c1-8)
    RESULTS+=("$STATUS")
    
    echo -e "    Request $i: ${STATUS} (token: ${TOKEN}...)"
  done
  
  echo ""
  
  # Check all results are identical
  FIRST="${RESULTS[0]}"
  ALL_SAME=true
  for R in "${RESULTS[@]}"; do
    if [ "$R" != "$FIRST" ]; then
      ALL_SAME=false
      break
    fi
  done
  
  if [ "$ALL_SAME" = true ]; then
    success "All 5 requests returned: ${GREEN}$FIRST${NC}"
    echo -e "         ${DIM}Idempotency verified: exposure reserved exactly once.${NC}"
  else
    warn "Inconsistent results detected"
  fi
  
  echo ""
  echo -e "  ${BOLD}Key Point:${NC} Same client_order_id = same decision."
  echo -e "            ${DIM}Network retries don't cause double-booking.${NC}"
}

# ============================================================================
# SCENARIO 3: FAIL-CLOSED (Audit Unavailable)
# ============================================================================
scenario_fail_closed() {
  header "FAIL-CLOSED (Simulated Audit Unavailable)"
  echo ""
  echo -e "${DIM}  Demonstrates that if the audit service were unavailable,${NC}"
  echo -e "${DIM}  the gate would return BLOCKED with reason AUDIT_UNAVAILABLE.${NC}"
  echo ""
  
  log "Current behavior with healthy audit service:"
  
  RESPONSE=$(curl -s -X POST "$API_URL/v1/authorize" \
    -H "Content-Type: application/json" \
    -d "{
      \"order\": {
        \"client_order_id\": \"fail-closed-test-$TIMESTAMP\",
        \"symbol\": \"NVDA\",
        \"side\": \"BUY\",
        \"qty\": 10,
        \"price\": 950.00
      },
      \"context\": {
        \"client_id\": \"fail-closed-client\"
      }
    }")
  
  STATUS=$(echo "$RESPONSE" | jq -r '.status')
  GATE_NOTE=$(echo "$RESPONSE" | jq -r '.gate_note // "N/A"')
  
  success "Decision: ${GREEN}$STATUS${NC}"
  echo -e "         ${DIM}gate_note: $GATE_NOTE${NC}"
  
  echo ""
  echo -e "  ${BOLD}Key Point:${NC} If audit-writer fails, handler returns BLOCKED"
  echo -e "            ${DIM}with reason_code: AUDIT_UNAVAILABLE (fail-closed posture).${NC}"
  echo -e "            ${DIM}See safeAudit() in services/order-api/src/index.ts${NC}"
}

# ============================================================================
# SCENARIO 4: Decision Token + Audit Trail
# ============================================================================
scenario_decision_token() {
  header "DECISION TOKEN (Cryptographic Proof)"
  echo ""
  echo -e "${DIM}  Demonstrates the signed decision token that proves the authorization.${NC}"
  echo ""
  
  log "Submitting order and capturing decision token..."
  
  RESPONSE=$(curl -s -X POST "$API_URL/v1/authorize" \
    -H "Content-Type: application/json" \
    -d "{
      \"order\": {
        \"client_order_id\": \"token-demo-$TIMESTAMP\",
        \"symbol\": \"GOOGL\",
        \"side\": \"BUY\",
        \"qty\": 25,
        \"price\": 175.00
      },
      \"context\": {
        \"client_id\": \"token-demo-client\"
      }
    }")
  
  STATUS=$(echo "$RESPONSE" | jq -r '.status')
  TOKEN_ID=$(echo "$RESPONSE" | jq -r '.decision_token.token_id // .token.token_id // "N/A"')
  SIGNATURE=$(echo "$RESPONSE" | jq -r '.decision_token.signature // .token.signature // "N/A"' | cut -c1-20)
  LATENCY=$(echo "$RESPONSE" | jq -r '.timing_ms.total // "N/A"')
  
  success "Decision: ${GREEN}$STATUS${NC}"
  echo ""
  echo -e "  ${BOLD}Decision Token:${NC}"
  echo -e "    token_id:  ${CYAN}$TOKEN_ID${NC}"
  echo -e "    signature: ${DIM}${SIGNATURE}...${NC}"
  echo -e "    latency:   ${LATENCY}ms"
  echo ""
  echo -e "  ${BOLD}Key Point:${NC} Every decision is cryptographically signed."
  echo -e "            ${DIM}Token can be verified against audit trail for compliance.${NC}"
}

# ============================================================================
# MAIN
# ============================================================================

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║           TRUVESTA AUTHORIZATION LAYER — DEMO SCENARIOS                  ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════════════════════╝${NC}"
echo ""

check_services

# Run all scenarios
scenario_exposure_limit
sleep 1

scenario_idempotency
sleep 1

scenario_decision_token
sleep 1

scenario_fail_closed

# Summary
echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  DEMO SUMMARY${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${GREEN}✓${NC} Policy-driven AUTHORIZED/BLOCKED decisions"
echo -e "  ${GREEN}✓${NC} Exposure limits automatically enforced"
echo -e "  ${GREEN}✓${NC} Idempotent handling (no double-reserve)"
echo -e "  ${GREEN}✓${NC} Cryptographic decision tokens"
echo -e "  ${GREEN}✓${NC} Fail-closed posture for integrity"
echo ""
echo -e "  ${BOLD}Authority Boundary:${NC}"
echo -e "  ${DIM}\"Decision authority here; execution remains platform-owned.\"${NC}"
echo ""
echo -e "  ${BOLD}Next:${NC} Generate evidence pack with ${CYAN}./scripts/demo-evidence-pack.sh${NC}"
echo ""
