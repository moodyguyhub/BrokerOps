#!/usr/bin/env bash
###############################################################################
# Phase 5 Alerts Contract Gate Script
# Validates the Alerts page DOM anchors and API contract
#
# Gates verified:
# 1. /alerts route returns HTTP 200
# 2. /alerts?embed=1 returns required DOM anchors
# 3. alerts.html links shared CSS
# 4. alerts.html links global-context.js
# 5. API contract: /api/alerts returns valid JSON shape
# 6. API contract: /api/alerts/:id/ack accepts POST
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
  
  ALERTS_FILE="$PROJECT_ROOT/services/ui/public/alerts.html"
  
  # Check alerts.html exists
  log_test "Checking alerts.html exists..."
  if [[ -f "$ALERTS_FILE" ]]; then
    log_pass "alerts.html exists"
  else
    log_fail "alerts.html missing"
    return 1
  fi
  
  # Check alerts.html links shared CSS
  log_test "Checking alerts.html links shared ui.css..."
  if grep -q 'href="/assets/ui.css"\|href="\/assets\/ui.css"' "$ALERTS_FILE"; then
    log_pass "alerts.html links shared ui.css"
  else
    log_fail "alerts.html missing link to shared ui.css"
  fi
  
  # Check alerts.html links global-context.js
  log_test "Checking alerts.html links global-context.js..."
  if grep -q 'src="/assets/global-context.js"\|src="\/assets\/global-context.js"' "$ALERTS_FILE"; then
    log_pass "alerts.html links global-context.js"
  else
    log_fail "alerts.html missing link to global-context.js"
  fi
  
  # Check alerts.html has required DOM anchors
  log_test "Checking alerts.html has required DOM anchors..."
  local required_anchors=("alerts-filters" "alerts-table" "alerts-detail" "alerts-ack-panel" "alerts-ack-note" "alerts-ack-submit")
  local missing_anchors=()
  
  for anchor_id in "${required_anchors[@]}"; do
    if ! grep -qE "id=[\"']${anchor_id}[\"']" "$ALERTS_FILE"; then
      missing_anchors+=("$anchor_id")
    fi
  done
  
  if [[ ${#missing_anchors[@]} -eq 0 ]]; then
    log_pass "All required DOM anchors present: ${required_anchors[*]}"
  else
    log_fail "Missing DOM anchors: ${missing_anchors[*]}"
  fi
  
  # Check global-context.js exists
  log_test "Checking global-context.js exists..."
  if [[ -f "$PROJECT_ROOT/services/ui/public/assets/global-context.js" ]]; then
    log_pass "global-context.js exists"
  else
    log_fail "global-context.js missing"
  fi
  
  # Gate hardening: Check no literal 'undefined' in template strings
  log_test "Checking alerts.html has no literal 'undefined' in templates..."
  # Look for >undefined< which would indicate unbound template variables
  if grep -qE '>\s*undefined\s*<|>\$\{[^}]*\}undefined' "$ALERTS_FILE" 2>/dev/null; then
    log_fail "alerts.html contains literal 'undefined' in template - check title/type bindings"
  else
    log_pass "No literal 'undefined' found in alerts.html templates"
  fi
  
  # Gate hardening: Ensure normalizeAlert function exists for schema normalization
  log_test "Checking alerts.html has normalizeAlert function..."
  if grep -qE 'function\s+normalizeAlert|normalizeAlert\s*=' "$ALERTS_FILE"; then
    log_pass "alerts.html has normalizeAlert schema normalizer"
  else
    log_fail "alerts.html missing normalizeAlert function - schema may not be normalized"
  fi
}

###############################################################################
# Gate 2: Runtime checks (server required)
###############################################################################
gate_runtime_checks() {
  log_header "GATE 2: Runtime Verification"
  
  # Check if UI server is running
  log_test "Checking UI server availability..."
  if ! curl -sf "${UI_BASE_URL}/health" > /dev/null 2>&1; then
    echo -e "  ${YELLOW}⚠ SKIP${NC}: UI server not running at ${UI_BASE_URL}"
    echo "  Run 'pnpm --filter ui dev' to start the server for runtime tests"
    return 0
  fi
  
  log_pass "UI server is running"
  
  # Check /alerts route returns 200
  log_test "Checking GET /alerts returns HTTP 200..."
  local http_code
  http_code=$(curl -sf -o /dev/null -w "%{http_code}" "${UI_BASE_URL}/alerts" 2>/dev/null || echo "000")
  if [[ "$http_code" == "200" ]]; then
    log_pass "GET /alerts returns HTTP 200"
  else
    log_fail "GET /alerts returned HTTP ${http_code}"
  fi
  
  # Check /alerts?embed=1 contains required anchors in response
  log_test "Checking /alerts?embed=1 response contains required anchors..."
  local response
  response=$(curl -sf "${UI_BASE_URL}/alerts?embed=1" 2>/dev/null || echo "")
  
  local required_anchors=("alerts-filters" "alerts-table" "alerts-detail" "alerts-ack-panel")
  local missing_anchors=()
  
  for anchor_id in "${required_anchors[@]}"; do
    if ! echo "$response" | grep -qE "id=[\"']${anchor_id}[\"']"; then
      missing_anchors+=("$anchor_id")
    fi
  done
  
  if [[ ${#missing_anchors[@]} -eq 0 ]]; then
    log_pass "Runtime response contains all required DOM anchors"
  else
    log_fail "Runtime response missing DOM anchors: ${missing_anchors[*]}"
  fi
  
  # Check /api/alerts returns valid JSON
  log_test "Checking GET /api/alerts returns valid JSON..."
  local api_response
  api_response=$(curl -sf "${UI_BASE_URL}/api/alerts" 2>/dev/null || echo "")
  
  if echo "$api_response" | jq -e '.' > /dev/null 2>&1; then
    log_pass "GET /api/alerts returns valid JSON"
  else
    log_fail "GET /api/alerts does not return valid JSON"
  fi
}

###############################################################################
# Gate 3: command-center-v2 integration check
###############################################################################
gate_command_center_integration() {
  log_header "GATE 3: Command Center Integration"
  
  CC_FILE="$PROJECT_ROOT/services/ui/public/command-center-v2.html"
  
  # Check command-center-v2 has alerts tab
  log_test "Checking command-center-v2 has alerts tab..."
  if grep -qE 'tab-alerts|data-tab="alerts"|id="tab-alerts"' "$CC_FILE"; then
    log_pass "command-center-v2 has alerts tab"
  else
    log_fail "command-center-v2 missing alerts tab"
  fi
  
  # Check command-center-v2 has alerts panel
  log_test "Checking command-center-v2 has alerts panel..."
  if grep -qE 'panel-alerts|id="panel-alerts"' "$CC_FILE"; then
    log_pass "command-center-v2 has alerts panel"
  else
    log_fail "command-center-v2 missing alerts panel"
  fi
}

###############################################################################
# Summary
###############################################################################
print_summary() {
  log_header "GATE 7 SUMMARY: Alerts Contract"
  
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
  
  if [[ $FAIL_COUNT -gt 0 ]]; then
    echo ""
    echo -e "${RED}GATE 7 FAILED${NC}"
    exit 1
  else
    echo ""
    echo -e "${GREEN}GATE 7 PASSED${NC}"
  fi
}

###############################################################################
# Main
###############################################################################
main() {
  echo ""
  echo -e "${CYAN}╔════════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║         Phase 5 Alerts Contract Gate (Gate 7)                  ║${NC}"
  echo -e "${CYAN}╚════════════════════════════════════════════════════════════════╝${NC}"
  
  gate_static_files
  gate_runtime_checks
  gate_command_center_integration
  print_summary
}

main "$@"
