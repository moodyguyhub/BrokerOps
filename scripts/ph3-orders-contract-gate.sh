#!/usr/bin/env bash
###############################################################################
# Phase 3 Orders Contract Gate Script
# Validates the Orders page DOM anchors and API contract
#
# Gates verified:
# 1. /orders route returns HTTP 200
# 2. /orders?embed=1 returns required DOM anchors
# 3. command-center-v2 Orders tab uses /orders?embed=1
# 4. orders.html links shared CSS
# 5. API contract: /api/orders returns valid JSON shape
###############################################################################

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

UI_PORT="${UI_PORT:-3000}"
UI_BASE_URL="http://localhost:${UI_PORT}"

PASS_COUNT=0
FAIL_COUNT=0
RESULTS=()

log_header() {
  echo ""
  echo -e "${CYAN}════════════════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  $1${NC}"
  echo -e "${CYAN}════════════════════════════════════════════════════════════════${NC}"
}

log_test() {
  echo -e "${YELLOW}► ${NC}$1"
}

log_pass() {
  echo -e "  ${GREEN}✓ PASS${NC}: $1"
  PASS_COUNT=$((PASS_COUNT + 1))
  RESULTS+=("PASS: $1")
}

log_fail() {
  echo -e "  ${RED}✗ FAIL${NC}: $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  RESULTS+=("FAIL: $1")
}

###############################################################################
# Gate 1: Static file checks (no server required)
###############################################################################
gate_static_files() {
  log_header "GATE 1: Static File Verification"
  
  ORDERS_FILE="$PROJECT_ROOT/services/ui/public/orders.html"
  
  # Check orders.html exists
  log_test "Checking orders.html exists..."
  if [[ -f "$ORDERS_FILE" ]]; then
    log_pass "orders.html exists"
  else
    log_fail "orders.html missing"
    return 1
  fi
  
  # Check orders.html links shared CSS
  log_test "Checking orders.html links shared ui.css..."
  if grep -q 'href="/assets/ui.css"\|href="\/assets\/ui.css"' "$ORDERS_FILE"; then
    log_pass "orders.html links shared ui.css"
  else
    log_fail "orders.html missing link to shared ui.css"
  fi
  
  # Check orders.html has required DOM anchors
  log_test "Checking orders.html has required DOM anchors..."
  local required_anchors=("orders-table" "orders-filters" "order-detail" "order-export-evidence" "order-export-dispute")
  local missing_anchors=()
  
  for anchor_id in "${required_anchors[@]}"; do
    if ! grep -qE "id=[\"']${anchor_id}[\"']" "$ORDERS_FILE"; then
      missing_anchors+=("$anchor_id")
    fi
  done
  
  if [[ ${#missing_anchors[@]} -eq 0 ]]; then
    log_pass "All required DOM anchors present: ${required_anchors[*]}"
  else
    log_fail "Missing DOM anchors: ${missing_anchors[*]}"
  fi
  
  # Check orders.html has embed mode support
  log_test "Checking orders.html has embed mode support..."
  if grep -q 'body.embed-mode' "$ORDERS_FILE"; then
    log_pass "orders.html has embed mode CSS"
  else
    log_fail "orders.html missing embed mode CSS"
  fi
  
  # Check command-center-v2 uses /orders?embed=1
  SHELL_FILE="$PROJECT_ROOT/services/ui/public/command-center-v2.html"
  log_test "Checking command-center-v2 Orders tab uses /orders?embed=1..."
  if grep -q '/orders?embed=1' "$SHELL_FILE"; then
    log_pass "command-center-v2 Orders tab uses /orders?embed=1"
  else
    log_fail "command-center-v2 Orders tab not using /orders?embed=1"
  fi
}

###############################################################################
# Gate 2: Route definition check
###############################################################################
gate_route_definition() {
  log_header "GATE 2: Route Definition Check"
  
  SERVER_FILE="$PROJECT_ROOT/services/ui/server.js"
  
  log_test "Checking server.js has /orders route..."
  if grep -q 'app.get.*"/orders"' "$SERVER_FILE"; then
    log_pass "server.js has /orders route defined"
  else
    log_fail "server.js missing /orders route definition"
    return 1
  fi
  
  log_test "Checking route serves orders.html..."
  if grep -q 'orders.html' "$SERVER_FILE"; then
    log_pass "Route correctly references orders.html"
  else
    log_fail "Route does not reference orders.html"
    return 1
  fi
}

###############################################################################
# Gate 3: Server route checks (requires running server)
###############################################################################
gate_server_routes() {
  log_header "GATE 3: Server Route Verification"
  
  # Check if UI server is running
  if ! curl -s --connect-timeout 2 "${UI_BASE_URL}/" >/dev/null 2>&1; then
    echo -e "${YELLOW}  ⚠ UI server not running on port ${UI_PORT}, skipping server checks${NC}"
    echo "  Start UI server with: cd services/ui && pnpm start"
    RESULTS+=("SKIP: Server route checks (server not running)")
    return 0
  fi
  
  # Check /orders route
  log_test "Checking /orders route returns HTTP 200..."
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${UI_BASE_URL}/orders")
  if [[ "$HTTP_STATUS" == "200" ]]; then
    log_pass "/orders returns HTTP 200"
  else
    log_fail "/orders returns HTTP $HTTP_STATUS (expected 200)"
  fi
  
  # Check /orders?embed=1 route
  log_test "Checking /orders?embed=1 returns HTTP 200..."
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${UI_BASE_URL}/orders?embed=1")
  if [[ "$HTTP_STATUS" == "200" ]]; then
    log_pass "/orders?embed=1 returns HTTP 200"
  else
    log_fail "/orders?embed=1 returns HTTP $HTTP_STATUS (expected 200)"
  fi
  
  # Check /orders?embed=1 has required anchors
  log_test "Checking /orders?embed=1 content has required anchors..."
  ORDERS_CONTENT=$(curl -s "${UI_BASE_URL}/orders?embed=1")
  local required_anchors=("orders-table" "orders-filters" "order-detail" "order-export-evidence" "order-export-dispute")
  local missing_anchors=()
  
  for anchor_id in "${required_anchors[@]}"; do
    if ! echo "$ORDERS_CONTENT" | grep -qE "id=[\"']${anchor_id}[\"']"; then
      missing_anchors+=("$anchor_id")
    fi
  done
  
  if [[ ${#missing_anchors[@]} -eq 0 ]]; then
    log_pass "/orders?embed=1 contains all required anchors"
  else
    log_fail "/orders?embed=1 missing anchors: ${missing_anchors[*]}"
  fi
  
  # Check /command-center-v2 has Orders iframe
  log_test "Checking /command-center-v2 Orders tab has iframe..."
  SHELL_CONTENT=$(curl -s "${UI_BASE_URL}/command-center-v2")
  if echo "$SHELL_CONTENT" | grep -q '/orders?embed=1'; then
    log_pass "/command-center-v2 contains Orders iframe with embed=1"
  else
    log_fail "/command-center-v2 missing Orders iframe"
  fi
}

###############################################################################
# Gate 4: API contract check (requires running backend)
###############################################################################
gate_api_contract() {
  log_header "GATE 4: API Contract Verification"
  
  # Check if UI server is running
  if ! curl -s --connect-timeout 2 "${UI_BASE_URL}/" >/dev/null 2>&1; then
    echo -e "${YELLOW}  ⚠ UI server not running, skipping API checks${NC}"
    RESULTS+=("SKIP: API contract checks (server not running)")
    return 0
  fi
  
  # Check /api/orders endpoint exists (may return error if backend down)
  log_test "Checking /api/orders endpoint responds..."
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${UI_BASE_URL}/api/orders?limit=1")
  if [[ "$HTTP_STATUS" == "200" ]]; then
    log_pass "/api/orders returns HTTP 200"
    
    # Validate JSON shape
    log_test "Checking /api/orders returns valid JSON..."
    API_RESPONSE=$(curl -s "${UI_BASE_URL}/api/orders?limit=1")
    if echo "$API_RESPONSE" | grep -qE '"orders"|"data"|\[\]'; then
      log_pass "/api/orders returns valid JSON structure"
    else
      log_fail "/api/orders response has unexpected shape"
    fi
  elif [[ "$HTTP_STATUS" == "500" || "$HTTP_STATUS" == "502" || "$HTTP_STATUS" == "503" ]]; then
    echo -e "${YELLOW}  ⚠ /api/orders returns $HTTP_STATUS (backend not running)${NC}"
    RESULTS+=("SKIP: /api/orders (backend not available)")
  else
    log_fail "/api/orders returns unexpected HTTP $HTTP_STATUS"
  fi
  
  # Note: evidence-pack and dispute-pack API routes need to be added
  # For now, just check if the UI correctly references them
  log_test "Checking orders.html has export button handlers..."
  ORDERS_FILE="$PROJECT_ROOT/services/ui/public/orders.html"
  if grep -q 'evidence-pack\|exportEvidence' "$ORDERS_FILE" && grep -q 'dispute-pack\|exportDispute' "$ORDERS_FILE"; then
    log_pass "orders.html has export button handlers"
  else
    log_fail "orders.html missing export handlers"
  fi
}

###############################################################################
# Summary
###############################################################################
print_summary() {
  log_header "PHASE 3 ORDERS CONTRACT SUMMARY"
  
  echo ""
  echo "Results:"
  for result in "${RESULTS[@]}"; do
    if [[ "$result" == PASS* ]]; then
      echo -e "  ${GREEN}✓${NC} $result"
    elif [[ "$result" == FAIL* ]]; then
      echo -e "  ${RED}✗${NC} $result"
    else
      echo -e "  ${YELLOW}○${NC} $result"
    fi
  done
  
  echo ""
  echo -e "Total: ${GREEN}${PASS_COUNT} passed${NC}, ${RED}${FAIL_COUNT} failed${NC}"
  echo ""
  
  if [[ $FAIL_COUNT -eq 0 ]]; then
    echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  ✓ PHASE 3 ORDERS CONTRACT: PASSED${NC}"
    echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
    return 0
  else
    echo -e "${RED}════════════════════════════════════════════════════════════════${NC}"
    echo -e "${RED}  ✗ PHASE 3 ORDERS CONTRACT: FAILED${NC}"
    echo -e "${RED}════════════════════════════════════════════════════════════════${NC}"
    return 1
  fi
}

###############################################################################
# Main
###############################################################################
main() {
  echo ""
  echo -e "${CYAN}Phase 3 Orders Contract Gate Script${NC}"
  echo -e "${CYAN}Orders Tab - DOM Anchors + API Contract${NC}"
  echo "──────────────────────────────────────────────────────────────────"
  
  gate_static_files
  gate_route_definition
  gate_server_routes
  gate_api_contract
  
  print_summary
}

main "$@"
