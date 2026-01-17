#!/usr/bin/env bash
###############################################################################
# Phase 2 Dashboard Embed Contract Gate Script
# Validates the embed mode and UI cohesion for Week 5
#
# Gates verified:
# 1. /command-center-v2 returns 5 required tab IDs
# 2. /dashboard?embed=1 returns all 5 required anchors
# 3. /assets/ui.css is served (HTTP 200)
# 4. dashboard.html links shared CSS
# 5. dashboard.html has embed mode styles
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
  
  DASHBOARD_FILE="$PROJECT_ROOT/services/ui/public/dashboard.html"
  
  # Check dashboard.html links shared CSS
  log_test "Checking dashboard.html links shared ui.css..."
  if grep -q 'href="/assets/ui.css"\|href="\/assets\/ui.css"' "$DASHBOARD_FILE"; then
    log_pass "dashboard.html links shared ui.css"
  else
    log_fail "dashboard.html missing link to shared ui.css"
  fi
  
  # Check dashboard.html has embed mode styles
  log_test "Checking dashboard.html has embed mode CSS..."
  if grep -q 'body.embed-mode' "$DASHBOARD_FILE"; then
    log_pass "dashboard.html has embed mode CSS selectors"
  else
    log_fail "dashboard.html missing embed mode CSS"
  fi
  
  # Check dashboard.html has embed detection script
  log_test "Checking dashboard.html has embed detection script..."
  if grep -q "embed.*=.*'1'\|embed.*===.*1\|#embed" "$DASHBOARD_FILE"; then
    log_pass "dashboard.html has embed mode detection"
  else
    log_fail "dashboard.html missing embed mode detection script"
  fi
  
  # Check command-center-v2 uses embed=1 in iframe
  SHELL_FILE="$PROJECT_ROOT/services/ui/public/command-center-v2.html"
  log_test "Checking command-center-v2 iframe uses embed=1..."
  if grep -q '/dashboard?embed=1' "$SHELL_FILE"; then
    log_pass "command-center-v2 iframe uses /dashboard?embed=1"
  else
    log_fail "command-center-v2 iframe not using ?embed=1 parameter"
  fi
}

###############################################################################
# Gate 2: Dashboard anchor preservation in embed mode
###############################################################################
gate_dashboard_anchors() {
  log_header "GATE 2: Dashboard Anchor Contract (embed mode)"
  
  DASHBOARD_FILE="$PROJECT_ROOT/services/ui/public/dashboard.html"
  
  log_test "Verifying all 5 required DOM anchors remain in dashboard.html..."
  
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
    echo "  This would break Week 4/demo choreography gates!"
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
  
  # Check /dashboard?embed=1 route
  log_test "Checking /dashboard?embed=1 returns HTTP 200..."
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${UI_BASE_URL}/dashboard?embed=1")
  if [[ "$HTTP_STATUS" == "200" ]]; then
    log_pass "/dashboard?embed=1 returns HTTP 200"
  else
    log_fail "/dashboard?embed=1 returns HTTP $HTTP_STATUS (expected 200)"
  fi
  
  # Check /dashboard?embed=1 still has required anchors
  log_test "Checking /dashboard?embed=1 content has required anchors..."
  EMBED_CONTENT=$(curl -s "${UI_BASE_URL}/dashboard?embed=1")
  local required_anchors=("kpi-orders" "kpi-alerts" "alerts-list" "lp-list" "demo-controls")
  local missing_anchors=()
  
  for anchor_id in "${required_anchors[@]}"; do
    if ! echo "$EMBED_CONTENT" | grep -qE "id=[\"']${anchor_id}[\"']"; then
      missing_anchors+=("$anchor_id")
    fi
  done
  
  if [[ ${#missing_anchors[@]} -eq 0 ]]; then
    log_pass "/dashboard?embed=1 contains all 5 required anchors"
  else
    log_fail "/dashboard?embed=1 missing anchors: ${missing_anchors[*]}"
  fi
  
  # Check shared CSS is served
  log_test "Checking /assets/ui.css is served..."
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${UI_BASE_URL}/assets/ui.css")
  if [[ "$HTTP_STATUS" == "200" ]]; then
    log_pass "/assets/ui.css returns HTTP 200"
  else
    log_fail "/assets/ui.css returns HTTP $HTTP_STATUS (expected 200)"
  fi
  
  # Check /command-center-v2 has tab IDs
  log_test "Checking /command-center-v2 has required tab IDs..."
  SHELL_CONTENT=$(curl -s "${UI_BASE_URL}/command-center-v2")
  local required_tabs=("tab-dashboard" "tab-orders" "tab-lps" "tab-alerts" "tab-demo")
  local missing_tabs=()
  
  for tab_id in "${required_tabs[@]}"; do
    if ! echo "$SHELL_CONTENT" | grep -q "id=\"$tab_id\""; then
      missing_tabs+=("$tab_id")
    fi
  done
  
  if [[ ${#missing_tabs[@]} -eq 0 ]]; then
    log_pass "/command-center-v2 contains all 5 tab IDs"
  else
    log_fail "/command-center-v2 missing tab IDs: ${missing_tabs[*]}"
  fi
  
  # Check /command-center-v2 iframe uses embed=1
  log_test "Checking /command-center-v2 iframe src uses embed parameter..."
  if echo "$SHELL_CONTENT" | grep -q '/dashboard?embed=1'; then
    log_pass "/command-center-v2 iframe uses /dashboard?embed=1"
  else
    log_fail "/command-center-v2 iframe not using ?embed=1 parameter"
  fi
}

###############################################################################
# Summary
###############################################################################
print_summary() {
  log_header "PHASE 2 DASHBOARD EMBED CONTRACT SUMMARY"
  
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
    echo -e "${GREEN}  ✓ PHASE 2 DASHBOARD EMBED CONTRACT: PASSED${NC}"
    echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
    return 0
  else
    echo -e "${RED}════════════════════════════════════════════════════════════════${NC}"
    echo -e "${RED}  ✗ PHASE 2 DASHBOARD EMBED CONTRACT: FAILED${NC}"
    echo -e "${RED}════════════════════════════════════════════════════════════════${NC}"
    return 1
  fi
}

###############################################################################
# Main
###############################################################################
main() {
  echo ""
  echo -e "${CYAN}Phase 2 Dashboard Embed Contract Gate Script${NC}"
  echo -e "${CYAN}Week 5 UI Cohesion - Embed Mode Verification${NC}"
  echo "──────────────────────────────────────────────────────────────────"
  
  gate_static_files
  gate_dashboard_anchors
  gate_server_routes
  
  print_summary
}

main "$@"
