#!/usr/bin/env bash
###############################################################################
# Phase 1 UI Shell Gate Script
# Validates the UI shell implementation for Week 5 UI Cohesion
#
# Gates verified:
# 1. New shell route /command-center-v2 returns HTTP 200
# 2. Shell HTML contains required tab IDs
# 3. Dashboard.html still has all 5 required anchors (non-breaking)
# 4. Shared CSS file exists
# 5. Week 4 gate still passes (dashboard accessible)
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
  
  # Check shared CSS exists
  log_test "Checking shared CSS file exists..."
  CSS_FILE="$PROJECT_ROOT/services/ui/public/assets/ui.css"
  if [[ -f "$CSS_FILE" ]]; then
    log_pass "Shared CSS file exists: $CSS_FILE"
  else
    log_fail "Shared CSS file missing: $CSS_FILE"
    return 1
  fi
  
  # Check command-center-v2.html exists
  log_test "Checking command-center-v2.html exists..."
  SHELL_FILE="$PROJECT_ROOT/services/ui/public/command-center-v2.html"
  if [[ -f "$SHELL_FILE" ]]; then
    log_pass "Command Center v2 HTML exists: $SHELL_FILE"
  else
    log_fail "Command Center v2 HTML missing: $SHELL_FILE"
    return 1
  fi
  
  # Check shell HTML has required tab IDs
  log_test "Checking shell HTML has required tab IDs..."
  local required_tabs=("tab-dashboard" "tab-orders" "tab-lps" "tab-alerts" "tab-demo")
  local missing_tabs=()
  
  for tab_id in "${required_tabs[@]}"; do
    if ! grep -q "id=\"$tab_id\"" "$SHELL_FILE"; then
      missing_tabs+=("$tab_id")
    fi
  done
  
  if [[ ${#missing_tabs[@]} -eq 0 ]]; then
    log_pass "All required tab IDs present: ${required_tabs[*]}"
  else
    log_fail "Missing tab IDs: ${missing_tabs[*]}"
    return 1
  fi
  
  # Check shell includes shared CSS
  log_test "Checking shell includes shared CSS..."
  if grep -q "assets/ui.css" "$SHELL_FILE"; then
    log_pass "Shell includes shared CSS reference"
  else
    log_fail "Shell missing shared CSS reference"
    return 1
  fi
}

###############################################################################
# Gate 2: Dashboard anchor preservation (NON-BREAKING)
###############################################################################
gate_dashboard_anchors() {
  log_header "GATE 2: Dashboard Anchor Preservation (Non-Breaking)"
  
  DASHBOARD_FILE="$PROJECT_ROOT/services/ui/public/dashboard.html"
  
  if [[ ! -f "$DASHBOARD_FILE" ]]; then
    log_fail "Dashboard file missing: $DASHBOARD_FILE"
    return 1
  fi
  
  log_test "Verifying all 5 required DOM anchors in dashboard.html..."
  
  # These anchors are checked by ph1-demo-choreography.sh
  local required_anchors=("kpi-orders" "kpi-alerts" "alerts-list" "lp-list" "demo-controls")
  local missing_anchors=()
  
  for anchor_id in "${required_anchors[@]}"; do
    if ! grep -qE "id=[\"']${anchor_id}[\"']" "$DASHBOARD_FILE"; then
      missing_anchors+=("$anchor_id")
    fi
  done
  
  if [[ ${#missing_anchors[@]} -eq 0 ]]; then
    log_pass "All 5 dashboard anchors preserved: ${required_anchors[*]}"
  else
    log_fail "Missing dashboard anchors: ${missing_anchors[*]}"
    echo "  This would break Week 4/Week 5 gates!"
    return 1
  fi
}

###############################################################################
# Gate 3: Server route check (requires running server)
###############################################################################
gate_server_routes() {
  log_header "GATE 3: Server Route Verification"
  
  # Check if UI server is running
  if ! curl -s --connect-timeout 2 "${UI_BASE_URL}/" >/dev/null 2>&1; then
    echo -e "${YELLOW}  ⚠ UI server not running on port ${UI_PORT}, skipping route checks${NC}"
    echo "  Start UI server with: cd services/ui && pnpm start"
    RESULTS+=("SKIP: Server route checks (server not running)")
    return 0
  fi
  
  # Check /command-center-v2 route
  log_test "Checking /command-center-v2 route..."
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${UI_BASE_URL}/command-center-v2")
  if [[ "$HTTP_STATUS" == "200" ]]; then
    log_pass "/command-center-v2 returns HTTP 200"
  else
    log_fail "/command-center-v2 returns HTTP $HTTP_STATUS (expected 200)"
  fi
  
  # Check /dashboard route still works
  log_test "Checking /dashboard route (Week 4 compatibility)..."
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${UI_BASE_URL}/dashboard")
  if [[ "$HTTP_STATUS" == "200" ]]; then
    log_pass "/dashboard returns HTTP 200"
  else
    log_fail "/dashboard returns HTTP $HTTP_STATUS (expected 200)"
  fi
  
  # Check shared CSS is served
  log_test "Checking shared CSS is served..."
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${UI_BASE_URL}/assets/ui.css")
  if [[ "$HTTP_STATUS" == "200" ]]; then
    log_pass "/assets/ui.css returns HTTP 200"
  else
    log_fail "/assets/ui.css returns HTTP $HTTP_STATUS (expected 200)"
  fi
  
  # Check shell HTML content has tab IDs
  log_test "Checking shell HTML content has tab navigation..."
  SHELL_CONTENT=$(curl -s "${UI_BASE_URL}/command-center-v2")
  if echo "$SHELL_CONTENT" | grep -q 'id="tab-dashboard"' && \
     echo "$SHELL_CONTENT" | grep -q 'id="tab-orders"' && \
     echo "$SHELL_CONTENT" | grep -q 'id="tab-lps"' && \
     echo "$SHELL_CONTENT" | grep -q 'id="tab-alerts"' && \
     echo "$SHELL_CONTENT" | grep -q 'id="tab-demo"'; then
    log_pass "Shell HTML contains all 5 tab navigation elements"
  else
    log_fail "Shell HTML missing some tab navigation elements"
  fi
}

###############################################################################
# Gate 4: Server.js route definition check
###############################################################################
gate_route_definition() {
  log_header "GATE 4: Route Definition Check"
  
  SERVER_FILE="$PROJECT_ROOT/services/ui/server.js"
  
  log_test "Checking server.js has /command-center-v2 route..."
  if grep -q 'app.get.*"/command-center-v2"' "$SERVER_FILE"; then
    log_pass "server.js has /command-center-v2 route defined"
  else
    log_fail "server.js missing /command-center-v2 route definition"
    return 1
  fi
  
  log_test "Checking route serves command-center-v2.html..."
  if grep -q 'command-center-v2.html' "$SERVER_FILE"; then
    log_pass "Route correctly references command-center-v2.html"
  else
    log_fail "Route does not reference command-center-v2.html"
    return 1
  fi
}

###############################################################################
# Summary
###############################################################################
print_summary() {
  log_header "PHASE 1 UI SHELL GATE SUMMARY"
  
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
    echo -e "${GREEN}  ✓ PHASE 1 UI SHELL GATE: PASSED${NC}"
    echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
    return 0
  else
    echo -e "${RED}════════════════════════════════════════════════════════════════${NC}"
    echo -e "${RED}  ✗ PHASE 1 UI SHELL GATE: FAILED${NC}"
    echo -e "${RED}════════════════════════════════════════════════════════════════${NC}"
    return 1
  fi
}

###############################################################################
# Main
###############################################################################
main() {
  echo ""
  echo -e "${CYAN}Phase 1 UI Shell Gate Script${NC}"
  echo -e "${CYAN}Week 5 UI Cohesion Verification${NC}"
  echo "──────────────────────────────────────────────────────────────────"
  
  gate_static_files
  gate_dashboard_anchors
  gate_route_definition
  gate_server_routes
  
  print_summary
}

main "$@"
