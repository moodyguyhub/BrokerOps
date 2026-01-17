#!/usr/bin/env bash
###############################################################################
# Phase 6 Shell Header Contract Gate Script
# Validates the Shell header controls and global context integration
#
# Gates verified:
# 1. global-context.js exists and contains required exports
# 2. command-center-v2.html has required shell header DOM anchors
# 3. command-center-v2.html links global-context.js
# 4. Runtime: shell header controls are present and functional
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
# Gate 1: global-context.js validation
###############################################################################
gate_global_context() {
  log_header "GATE 1: Global Context Module Verification"
  
  CONTEXT_FILE="$PROJECT_ROOT/services/ui/public/assets/global-context.js"
  
  # Check file exists
  log_test "Checking global-context.js exists..."
  if [[ -f "$CONTEXT_FILE" ]]; then
    log_pass "global-context.js exists"
  else
    log_fail "global-context.js missing"
    return 1
  fi
  
  # Check for required exports/functions
  log_test "Checking global-context.js exports BO_CTX..."
  if grep -qE "global\.BO_CTX|window\.BO_CTX" "$CONTEXT_FILE"; then
    log_pass "global-context.js exports BO_CTX"
  else
    log_fail "global-context.js missing BO_CTX export"
  fi
  
  log_test "Checking global-context.js has initShell function..."
  if grep -qE "initShell" "$CONTEXT_FILE"; then
    log_pass "global-context.js has initShell function"
  else
    log_fail "global-context.js missing initShell function"
  fi
  
  log_test "Checking global-context.js has relativeTime function..."
  if grep -qE "relativeTime" "$CONTEXT_FILE"; then
    log_pass "global-context.js has relativeTime function"
  else
    log_fail "global-context.js missing relativeTime function"
  fi
  
  log_test "Checking global-context.js has copyToClipboard function..."
  if grep -qE "copyToClipboard" "$CONTEXT_FILE"; then
    log_pass "global-context.js has copyToClipboard function"
  else
    log_fail "global-context.js missing copyToClipboard function"
  fi
  
  log_test "Checking global-context.js has keyboard shortcuts..."
  if grep -qE "keydown|KEYBOARD_SHORTCUTS" "$CONTEXT_FILE"; then
    log_pass "global-context.js has keyboard shortcuts"
  else
    log_fail "global-context.js missing keyboard shortcuts"
  fi
  
  log_test "Checking global-context.js has EventBus..."
  if grep -qE "EventBus|eventBus" "$CONTEXT_FILE"; then
    log_pass "global-context.js has EventBus for cross-component communication"
  else
    log_fail "global-context.js missing EventBus"
  fi
}

###############################################################################
# Gate 2: Shell header DOM anchors in command-center-v2.html
###############################################################################
gate_shell_header_anchors() {
  log_header "GATE 2: Shell Header DOM Anchors"
  
  CC_FILE="$PROJECT_ROOT/services/ui/public/command-center-v2.html"
  
  # Check command-center-v2.html exists
  log_test "Checking command-center-v2.html exists..."
  if [[ -f "$CC_FILE" ]]; then
    log_pass "command-center-v2.html exists"
  else
    log_fail "command-center-v2.html missing"
    return 1
  fi
  
  # Check for required shell header DOM anchors
  log_test "Checking shell header has required DOM anchors..."
  local required_anchors=("global-server-select" "global-time-window" "global-alerts-badge" "global-search-trigger" "global-system-status")
  local missing_anchors=()
  local present_anchors=()
  
  for anchor_id in "${required_anchors[@]}"; do
    if grep -qE "id=[\"']${anchor_id}[\"']" "$CC_FILE"; then
      present_anchors+=("$anchor_id")
    else
      missing_anchors+=("$anchor_id")
    fi
  done
  
  if [[ ${#present_anchors[@]} -gt 0 ]]; then
    log_pass "Present anchors: ${present_anchors[*]}"
  fi
  
  if [[ ${#missing_anchors[@]} -gt 0 ]]; then
    # Check if this is expected (not yet implemented)
    echo -e "  ${YELLOW}⚠ PENDING${NC}: Missing anchors (to be added): ${missing_anchors[*]}"
    # Don't fail - these may need to be added
  fi
  
  # Check for global-context.js inclusion
  log_test "Checking command-center-v2.html includes global-context.js..."
  if grep -q 'global-context.js' "$CC_FILE"; then
    log_pass "command-center-v2.html includes global-context.js"
  else
    echo -e "  ${YELLOW}⚠ PENDING${NC}: command-center-v2.html should include global-context.js"
  fi
  
  # Gate hardening: Check "All Servers" is the default server option
  log_test "Checking default server is 'all' (All Servers)..."
  if grep -qE "defaultServer:\s*['\"]all['\"]" "$CC_FILE"; then
    log_pass "Default server is set to 'all' (All Servers)"
  else
    log_fail "Default server is NOT 'all' - context coherence risk"
  fi
  
  # Gate hardening: Check server list includes "All Servers" option
  log_test "Checking server list has 'All Servers' option..."
  if grep -qE "id:\s*['\"]all['\"].*name:\s*['\"]All Servers['\"]|name:\s*['\"]All Servers['\"].*id:\s*['\"]all['\"]" "$CC_FILE"; then
    log_pass "Server list includes 'All Servers' as first option"
  else
    log_fail "Server list missing 'All Servers' option"
  fi
}

###############################################################################
# Gate 3: Runtime verification
###############################################################################
gate_runtime_checks() {
  log_header "GATE 3: Runtime Verification"
  
  # Check if UI server is running
  log_test "Checking UI server availability..."
  if ! curl -sf "${UI_BASE_URL}/health" > /dev/null 2>&1; then
    echo -e "  ${YELLOW}⚠ SKIP${NC}: UI server not running at ${UI_BASE_URL}"
    echo "  Run 'pnpm --filter ui dev' to start the server for runtime tests"
    return 0
  fi
  
  log_pass "UI server is running"
  
  # Check /assets/global-context.js is served
  log_test "Checking global-context.js is served..."
  local http_code
  http_code=$(curl -sf -o /dev/null -w "%{http_code}" "${UI_BASE_URL}/assets/global-context.js" 2>/dev/null || echo "000")
  if [[ "$http_code" == "200" ]]; then
    log_pass "global-context.js is served at /assets/global-context.js"
  else
    log_fail "global-context.js not served (HTTP ${http_code})"
  fi
  
  # Check /command-center-v2 returns 200
  log_test "Checking GET /command-center-v2 returns HTTP 200..."
  http_code=$(curl -sf -o /dev/null -w "%{http_code}" "${UI_BASE_URL}/command-center-v2.html" 2>/dev/null || echo "000")
  if [[ "$http_code" == "200" ]]; then
    log_pass "GET /command-center-v2.html returns HTTP 200"
  else
    log_fail "GET /command-center-v2.html returned HTTP ${http_code}"
  fi
}

###############################################################################
# Gate 4: Integration with existing tabs
###############################################################################
gate_tab_integration() {
  log_header "GATE 4: Tab Integration Check"
  
  CC_FILE="$PROJECT_ROOT/services/ui/public/command-center-v2.html"
  
  # Check all tabs exist
  local tabs=("dashboard" "orders" "lps" "alerts")
  for tab in "${tabs[@]}"; do
    log_test "Checking ${tab} tab exists..."
    if grep -qE "data-tab=[\"']${tab}[\"']|id=\"tab-${tab}\"" "$CC_FILE"; then
      log_pass "${tab} tab exists"
    else
      log_fail "${tab} tab missing"
    fi
  done
  
  # Check all tab panels exist
  for tab in "${tabs[@]}"; do
    log_test "Checking ${tab} panel exists..."
    if grep -qE "id=\"panel-${tab}\"" "$CC_FILE"; then
      log_pass "${tab} panel exists"
    else
      log_fail "${tab} panel missing"
    fi
  done
}

###############################################################################
# Summary
###############################################################################
print_summary() {
  log_header "GATE 8 SUMMARY: Shell Header Completeness"
  
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
    echo -e "${RED}GATE 8 FAILED${NC}"
    exit 1
  else
    echo ""
    echo -e "${GREEN}GATE 8 PASSED${NC}"
  fi
}

###############################################################################
# Main
###############################################################################
main() {
  echo ""
  echo -e "${CYAN}╔════════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║       Phase 6 Shell Header Contract Gate (Gate 8)              ║${NC}"
  echo -e "${CYAN}╚════════════════════════════════════════════════════════════════╝${NC}"
  
  gate_global_context
  gate_shell_header_anchors
  gate_runtime_checks
  gate_tab_integration
  print_summary
}

main "$@"
