#!/usr/bin/env bash
###############################################################################
# Phase 4 LP Accounts Contract Gate Script
# Validates the LP Accounts page DOM anchors and API contract
#
# Gates verified:
# 1. /lp-accounts route returns HTTP 200
# 2. /lp-accounts?embed=1 returns required DOM anchors
# 3. command-center-v2 LPs tab uses /lp-accounts?embed=1
# 4. lp-accounts.html links shared CSS
# 5. API contract: /api/lp-accounts returns valid JSON shape
# 6. API contract: /api/lp-accounts/:id returns valid JSON shape
# 7. API contract: /api/lp-accounts/:id/history returns valid JSON shape
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
ORDER_API_PORT="${ORDER_API_PORT:-7001}"
ORDER_API_URL="http://localhost:${ORDER_API_PORT}"

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
  
  LP_FILE="$PROJECT_ROOT/services/ui/public/lp-accounts.html"
  
  # Check lp-accounts.html exists
  log_test "Checking lp-accounts.html exists..."
  if [[ -f "$LP_FILE" ]]; then
    log_pass "lp-accounts.html exists"
  else
    log_fail "lp-accounts.html missing"
    return 1
  fi
  
  # Check lp-accounts.html links shared CSS
  log_test "Checking lp-accounts.html links shared ui.css..."
  if grep -q 'href="/assets/ui.css"\|href="\/assets\/ui.css"' "$LP_FILE"; then
    log_pass "lp-accounts.html links shared ui.css"
  else
    log_fail "lp-accounts.html missing link to shared ui.css"
  fi
  
  # Check lp-accounts.html has required DOM anchors
  log_test "Checking lp-accounts.html has required DOM anchors..."
  local required_anchors=("lp-table" "lp-filters" "lp-detail" "lp-summary" "lp-export-snapshot" "lp-view-history")
  local missing_anchors=()
  
  for anchor_id in "${required_anchors[@]}"; do
    if ! grep -qE "id=[\"']${anchor_id}[\"']" "$LP_FILE"; then
      missing_anchors+=("$anchor_id")
    fi
  done
  
  if [[ ${#missing_anchors[@]} -eq 0 ]]; then
    log_pass "All required DOM anchors present: ${required_anchors[*]}"
  else
    log_fail "Missing DOM anchors: ${missing_anchors[*]}"
  fi
  
  # Gate hardening: Non-blank invariant anchors (loading/empty/error states)
  log_test "Checking lp-accounts.html has non-blank invariant anchors..."
  local state_anchors=("lp-loading" "lp-empty-state" "lp-error-banner")
  local missing_states=()
  
  for anchor_id in "${state_anchors[@]}"; do
    if ! grep -qE "id=[\"']${anchor_id}[\"']" "$LP_FILE"; then
      missing_states+=("$anchor_id")
    fi
  done
  
  if [[ ${#missing_states[@]} -eq 0 ]]; then
    log_pass "Non-blank invariant anchors present: ${state_anchors[*]}"
  else
    log_fail "Missing non-blank invariant anchors: ${missing_states[*]} (blank screen bug risk)"
  fi
  
  # Check lp-accounts.html has embed mode support
  log_test "Checking lp-accounts.html has embed mode support..."
  if grep -q 'body.embed-mode' "$LP_FILE"; then
    log_pass "lp-accounts.html has embed mode CSS"
  else
    log_fail "lp-accounts.html missing embed mode CSS"
  fi
  
  # Check command-center-v2 uses /lp-accounts?embed=1
  SHELL_FILE="$PROJECT_ROOT/services/ui/public/command-center-v2.html"
  log_test "Checking command-center-v2 LPs tab uses /lp-accounts?embed=1..."
  if grep -q '/lp-accounts?embed=1' "$SHELL_FILE"; then
    log_pass "command-center-v2 LPs tab uses /lp-accounts?embed=1"
  else
    log_fail "command-center-v2 LPs tab not using /lp-accounts?embed=1"
  fi
}

###############################################################################
# Gate 2: Route definition check
###############################################################################
gate_route_definition() {
  log_header "GATE 2: Route Definition Check"
  
  SERVER_FILE="$PROJECT_ROOT/services/ui/server.js"
  
  log_test "Checking server.js has /lp-accounts route..."
  if grep -q 'app.get.*"/lp-accounts"' "$SERVER_FILE"; then
    log_pass "server.js has /lp-accounts route defined"
  else
    log_fail "server.js missing /lp-accounts route definition"
    return 1
  fi
  
  log_test "Checking route serves lp-accounts.html..."
  if grep -q 'lp-accounts.html' "$SERVER_FILE"; then
    log_pass "Route correctly references lp-accounts.html"
  else
    log_fail "Route does not reference lp-accounts.html"
    return 1
  fi
}

###############################################################################
# Gate 3: Proxy ownership verification
###############################################################################
gate_proxy_ownership() {
  log_header "GATE 3: Proxy Ownership Verification"
  
  SERVER_FILE="$PROJECT_ROOT/services/ui/server.js"
  
  # Check that LP account proxies point to orderApi (not reconstruction or other)
  log_test "Checking /api/lp-accounts proxy targets orderApi..."
  
  # Extract the proxy definition for lp-accounts
  if grep -A5 'app.get.*"/api/lp-accounts"' "$SERVER_FILE" | grep -q 'API_URLS.orderApi'; then
    log_pass "/api/lp-accounts proxy targets orderApi"
  else
    log_fail "/api/lp-accounts proxy does NOT target orderApi"
  fi
  
  log_test "Checking /api/lp-accounts/:id proxy targets orderApi..."
  if grep -A5 'app.get.*"/api/lp-accounts/:id"' "$SERVER_FILE" | head -10 | grep -q 'API_URLS.orderApi'; then
    log_pass "/api/lp-accounts/:id proxy targets orderApi"
  else
    log_fail "/api/lp-accounts/:id proxy does NOT target orderApi"
  fi
  
  log_test "Checking /api/lp-accounts/:id/history proxy targets orderApi..."
  if grep -A5 'app.get.*"/api/lp-accounts/:id/history"' "$SERVER_FILE" | grep -q 'API_URLS.orderApi'; then
    log_pass "/api/lp-accounts/:id/history proxy targets orderApi"
  else
    log_fail "/api/lp-accounts/:id/history proxy does NOT target orderApi"
  fi
}

###############################################################################
# Gate 4: Server route checks (requires running server)
###############################################################################
gate_server_routes() {
  log_header "GATE 4: Server Route Verification"
  
  # In CI mode, server MUST be running (no silent skips)
  CI_MODE="${CI:-false}"
  
  # Check if UI server is running
  if ! curl -sf "${UI_BASE_URL}/health" > /dev/null 2>&1; then
    if [[ "$CI_MODE" == "true" ]]; then
      log_fail "UI server not running at ${UI_BASE_URL} (required in CI mode)"
      return 1
    else
      echo -e "  ${YELLOW}⚠ SKIP${NC}: UI server not running (set CI=true to fail on this)"
      return 0
    fi
  fi
  
  # Check /lp-accounts returns 200
  log_test "Checking /lp-accounts returns HTTP 200..."
  HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" "${UI_BASE_URL}/lp-accounts" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" == "200" ]]; then
    log_pass "/lp-accounts returns HTTP 200"
  else
    log_fail "/lp-accounts returns HTTP $HTTP_CODE (expected 200)"
  fi
  
  # Check /lp-accounts?embed=1 returns valid HTML with anchors
  log_test "Checking /lp-accounts?embed=1 contains required anchors..."
  EMBED_CONTENT=$(curl -sf "${UI_BASE_URL}/lp-accounts?embed=1" 2>/dev/null || echo "")
  if [[ -n "$EMBED_CONTENT" ]]; then
    ANCHOR_CHECK=true
    for anchor in "lp-table" "lp-filters" "lp-detail"; do
      if ! echo "$EMBED_CONTENT" | grep -q "id=\"$anchor\""; then
        log_fail "Embed mode missing anchor: $anchor"
        ANCHOR_CHECK=false
      fi
    done
    if $ANCHOR_CHECK; then
      log_pass "/lp-accounts?embed=1 contains all required anchors"
    fi
  else
    log_fail "Failed to fetch /lp-accounts?embed=1"
  fi
}

###############################################################################
# Gate 5: API contract verification (requires running backend)
###############################################################################
gate_api_contract() {
  log_header "GATE 5: API Contract Verification"
  
  CI_MODE="${CI:-false}"
  
  # Check if order-api is running
  if ! curl -sf "${ORDER_API_URL}/health" > /dev/null 2>&1; then
    if [[ "$CI_MODE" == "true" ]]; then
      log_fail "order-api not running at ${ORDER_API_URL} (required in CI mode)"
      return 1
    else
      echo -e "  ${YELLOW}⚠ SKIP${NC}: order-api not running (set CI=true to fail on this)"
      return 0
    fi
  fi
  
  # Check /api/lp-accounts returns valid JSON with expected shape
  log_test "Checking /api/lp-accounts returns valid JSON shape..."
  LP_LIST=$(curl -sf "${ORDER_API_URL}/api/lp-accounts" 2>/dev/null || echo "")
  if [[ -n "$LP_LIST" ]]; then
    # Check for success field
    if echo "$LP_LIST" | jq -e '.success' > /dev/null 2>&1; then
      log_pass "/api/lp-accounts returns JSON with success field"
      
      # If there's data, check the shape
      if echo "$LP_LIST" | jq -e '.data | type == "array"' > /dev/null 2>&1; then
        LP_COUNT=$(echo "$LP_LIST" | jq '.data | length')
        log_pass "/api/lp-accounts.data is an array (${LP_COUNT} items)"
        
        # If we have at least one LP, check its shape and use it for subsequent tests
        if [[ "$LP_COUNT" -gt 0 ]]; then
          FIRST_LP_ID=$(echo "$LP_LIST" | jq -r '.data[0].id')
          
          # Check /api/lp-accounts/:id
          log_test "Checking /api/lp-accounts/${FIRST_LP_ID} returns valid JSON..."
          LP_SINGLE=$(curl -sf "${ORDER_API_URL}/api/lp-accounts/${FIRST_LP_ID}" 2>/dev/null || echo "")
          if echo "$LP_SINGLE" | jq -e '.success and .data.id' > /dev/null 2>&1; then
            log_pass "/api/lp-accounts/:id returns valid single LP"
          else
            log_fail "/api/lp-accounts/:id response invalid"
          fi
          
          # Check /api/lp-accounts/:id/history
          log_test "Checking /api/lp-accounts/${FIRST_LP_ID}/history returns valid JSON..."
          LP_HISTORY=$(curl -sf "${ORDER_API_URL}/api/lp-accounts/${FIRST_LP_ID}/history?limit=5" 2>/dev/null || echo "")
          if echo "$LP_HISTORY" | jq -e '.success and (.data | type == "array")' > /dev/null 2>&1; then
            HIST_COUNT=$(echo "$LP_HISTORY" | jq '.data | length')
            log_pass "/api/lp-accounts/:id/history returns valid array (${HIST_COUNT} items)"
          else
            log_fail "/api/lp-accounts/:id/history response invalid"
          fi
        else
          log_pass "No LP accounts in database (seeding may be required for full test)"
        fi
      else
        log_fail "/api/lp-accounts.data is not an array"
      fi
    else
      log_fail "/api/lp-accounts response missing success field"
    fi
  else
    log_fail "Failed to fetch /api/lp-accounts"
  fi
}

###############################################################################
# Gate 6: UI Proxy contract verification (requires running UI + backend)
###############################################################################
gate_ui_proxy() {
  log_header "GATE 6: UI Proxy Contract Verification"
  
  CI_MODE="${CI:-false}"
  
  # Check if both UI and order-api are running
  if ! curl -sf "${UI_BASE_URL}/health" > /dev/null 2>&1; then
    if [[ "$CI_MODE" == "true" ]]; then
      log_fail "UI server not running (required in CI mode)"
      return 1
    else
      echo -e "  ${YELLOW}⚠ SKIP${NC}: UI server not running"
      return 0
    fi
  fi
  
  # Test UI proxy endpoints return valid responses
  log_test "Checking UI proxy /api/lp-accounts works..."
  UI_LP_LIST=$(curl -sf "${UI_BASE_URL}/api/lp-accounts" 2>/dev/null || echo "")
  if echo "$UI_LP_LIST" | jq -e '.success' > /dev/null 2>&1; then
    log_pass "UI proxy /api/lp-accounts returns valid response"
  else
    # Check if it's a proxy error vs backend down
    if echo "$UI_LP_LIST" | grep -q "error"; then
      log_fail "UI proxy /api/lp-accounts returned error (backend may be down)"
    else
      log_fail "UI proxy /api/lp-accounts returned invalid response"
    fi
  fi
}

###############################################################################
# Summary
###############################################################################
print_summary() {
  log_header "GATE 6 SUMMARY: LP Accounts Contract"
  
  echo ""
  echo "Results:"
  for result in "${RESULTS[@]}"; do
    if [[ "$result" == PASS:* ]]; then
      echo -e "  ${GREEN}✓${NC} ${result#PASS: }"
    else
      echo -e "  ${RED}✗${NC} ${result#FAIL: }"
    fi
  done
  
  echo ""
  echo -e "Total: ${GREEN}${PASS_COUNT} passed${NC}, ${RED}${FAIL_COUNT} failed${NC}"
  echo ""
  
  if [[ $FAIL_COUNT -gt 0 ]]; then
    echo -e "${RED}Gate 6 FAILED${NC}"
    return 1
  else
    echo -e "${GREEN}Gate 6 PASSED${NC}"
    return 0
  fi
}

###############################################################################
# Main
###############################################################################
main() {
  echo ""
  echo -e "${CYAN}╔══════════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║   Phase 4 LP Accounts Contract Gate                              ║${NC}"
  echo -e "${CYAN}╚══════════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo "UI Base URL: ${UI_BASE_URL}"
  echo "Order API URL: ${ORDER_API_URL}"
  echo "CI Mode: ${CI:-false}"
  
  gate_static_files
  gate_route_definition
  gate_proxy_ownership
  gate_server_routes
  gate_api_contract
  gate_ui_proxy
  
  print_summary
}

main "$@"
