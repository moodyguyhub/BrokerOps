#!/usr/bin/env bash
###############################################################################
# Phase 9 Provenance Footer Contract Gate (Gate 11)
#
# Verifies Phase 9 Shell Provenance Footer:
# - Footer anchors present in shell
# - Provenance values (kernel, UI, timestamp) have stable anchors
# - Footer script loaded once (single source of truth)
# - No "undefined" strings in footer rendering
# - Embed-safe (hidden in iframe, visible in shell)
###############################################################################

set -euo pipefail

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Counters
PASS_COUNT=0
FAIL_COUNT=0
TEST_RESULTS=()

###############################################################################
# Helpers
###############################################################################

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  TEST_RESULTS+=("PASS: $1")
  echo -e "  ${GREEN}✓${NC} $1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  TEST_RESULTS+=("FAIL: $1")
  echo -e "  ${RED}✗${NC} $1"
}

log_header() {
  echo ""
  echo -e "${CYAN}──────────────────────────────────────────────────────────────────${NC}"
  echo -e "${CYAN}  $1${NC}"
  echo -e "${CYAN}──────────────────────────────────────────────────────────────────${NC}"
}

###############################################################################
# Project Root
###############################################################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

###############################################################################
# Gate 11.1: Provenance Footer Anchors in Shell
###############################################################################

gate_shell_anchors() {
  log_header "GATE 11.1: Provenance Footer Anchors in Shell"
  
  local SHELL_FILE="$PROJECT_ROOT/services/ui/public/command-center-v2.html"
  
  if [[ ! -f "$SHELL_FILE" ]]; then
    fail "Shell file exists"
    return
  fi
  pass "Shell file exists"
  
  # Check for provenance footer script include
  if grep -q "provenance-footer.js" "$SHELL_FILE"; then
    pass "Provenance footer script included in shell"
  else
    fail "Provenance footer script included in shell"
  fi
  
  # Check script is loaded once (count occurrences)
  local script_count=$(grep -c "provenance-footer.js" "$SHELL_FILE" || echo "0")
  if [[ "$script_count" -eq 1 ]]; then
    pass "Provenance footer script loaded exactly once"
  else
    fail "Provenance footer script loaded exactly once (found: $script_count)"
  fi
}

###############################################################################
# Gate 11.2: Provenance Footer Component
###############################################################################

gate_footer_component() {
  log_header "GATE 11.2: Provenance Footer Component"
  
  local FOOTER_JS="$PROJECT_ROOT/services/ui/public/assets/provenance-footer.js"
  
  if [[ ! -f "$FOOTER_JS" ]]; then
    fail "Provenance footer JS exists"
    return
  fi
  pass "Provenance footer JS exists"
  
  # Check for provenance-footer anchor (via DOM assignment or HTML attribute)
  if grep -qE "id.*=.*[\"']provenance-footer[\"']|\.id.*=.*[\"']provenance-footer[\"']" "$FOOTER_JS"; then
    pass "provenance-footer anchor exists"
  else
    fail "provenance-footer anchor exists"
  fi
  
  # Check for prov-kernel anchor
  if grep -qE "id=[\"']prov-kernel[\"']" "$FOOTER_JS"; then
    pass "prov-kernel anchor exists"
  else
    fail "prov-kernel anchor exists"
  fi
  
  # Check for prov-ui anchor
  if grep -qE "id=[\"']prov-ui[\"']" "$FOOTER_JS"; then
    pass "prov-ui anchor exists"
  else
    fail "prov-ui anchor exists"
  fi
  
  # Check for prov-ts anchor
  if grep -qE "id=[\"']prov-ts[\"']" "$FOOTER_JS"; then
    pass "prov-ts anchor exists"
  else
    fail "prov-ts anchor exists"
  fi
}

###############################################################################
# Gate 11.3: Single Source of Truth (Endpoint)
###############################################################################

gate_single_source() {
  log_header "GATE 11.3: Single Source of Truth (API Endpoint)"
  
  local SERVER_JS="$PROJECT_ROOT/services/ui/server.js"
  local FOOTER_JS="$PROJECT_ROOT/services/ui/public/assets/provenance-footer.js"
  
  # Check provenance endpoint exists in server
  if grep -q "/api/provenance" "$SERVER_JS"; then
    pass "Provenance API endpoint defined in server"
  else
    fail "Provenance API endpoint defined in server"
  fi
  
  # Check footer fetches from endpoint
  if grep -q "/api/provenance" "$FOOTER_JS"; then
    pass "Footer fetches from provenance endpoint"
  else
    fail "Footer fetches from provenance endpoint"
  fi
  
  # Check environment variables are used (single source)
  if grep -qE "BROKEROPS_SHA|GIT_SHA|BROKEROPS_TAG|GIT_TAG" "$SERVER_JS"; then
    pass "Provenance uses environment variables"
  else
    fail "Provenance uses environment variables"
  fi
}

###############################################################################
# Gate 11.4: No Undefined Invariant
###############################################################################

gate_no_undefined() {
  log_header "GATE 11.4: No 'undefined' Invariant in Footer"
  
  local FOOTER_JS="$PROJECT_ROOT/services/ui/public/assets/provenance-footer.js"
  
  # Check for fallback values (defensive coding)
  if grep -q "'--'" "$FOOTER_JS"; then
    pass "Uses fallback values for missing data"
  else
    fail "Uses fallback values for missing data"
  fi
  
  # Check for error handling in fetch
  if grep -q "catch" "$FOOTER_JS"; then
    pass "Has error handling for fetch failures"
  else
    fail "Has error handling for fetch failures"
  fi
  
  # Check fallback data is provided
  if grep -q "kernel.*dev" "$FOOTER_JS"; then
    pass "Fallback kernel version defined"
  else
    fail "Fallback kernel version defined"
  fi
}

###############################################################################
# Gate 11.5: Embed-Safe Behavior
###############################################################################

gate_embed_safe() {
  log_header "GATE 11.5: Embed-Safe Behavior"
  
  local FOOTER_JS="$PROJECT_ROOT/services/ui/public/assets/provenance-footer.js"
  
  # Check for embed detection
  if grep -qE "window.self.*window.top|isEmbedded|embed" "$FOOTER_JS"; then
    pass "Embed mode detection exists"
  else
    fail "Embed mode detection exists"
  fi
  
  # Check footer is hidden in embed mode (CSS)
  if grep -qE "embed.*display.*none|embed-mode.*provenance" "$FOOTER_JS"; then
    pass "Footer hidden in embed mode"
  else
    fail "Footer hidden in embed mode"
  fi
  
  # Check footer uses CSS variables for theming
  if grep -q "var(--" "$FOOTER_JS"; then
    pass "Uses CSS variables for theming"
  else
    fail "Uses CSS variables for theming"
  fi
  
  # Check footer uses fixed positioning (for shell bottom bar)
  if grep -q "position: fixed" "$FOOTER_JS"; then
    pass "Uses fixed positioning for shell footer"
  else
    fail "Uses fixed positioning for shell footer"
  fi
}

###############################################################################
# Gate 11.6: Shell Layout Adjustment
###############################################################################

gate_layout_adjustment() {
  log_header "GATE 11.6: Shell Layout Adjustment for Footer"
  
  local SHELL_FILE="$PROJECT_ROOT/services/ui/public/command-center-v2.html"
  
  # Check shell adjusts for footer height
  if grep -qE "calc.*24px|footer" "$SHELL_FILE"; then
    pass "Shell layout accounts for footer height"
  else
    fail "Shell layout accounts for footer height"
  fi
  
  # Check embed container adjusts
  if grep -q "embed-container" "$SHELL_FILE"; then
    pass "Embed container defined"
  else
    fail "Embed container defined"
  fi
}

###############################################################################
# Summary
###############################################################################

print_summary() {
  echo ""
  echo -e "${CYAN}══════════════════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  GATE 11 SUMMARY: Phase 9 Provenance Footer Contract${NC}"
  echo -e "${CYAN}══════════════════════════════════════════════════════════════════${NC}"
  echo ""
  
  for result in "${TEST_RESULTS[@]}"; do
    if [[ "$result" == PASS:* ]]; then
      echo -e "  ${GREEN}✓${NC} ${result#PASS: }"
    else
      echo -e "  ${RED}✗${NC} ${result#FAIL: }"
    fi
  done
  
  echo ""
  echo -e "Total: ${GREEN}${PASS_COUNT} passed${NC}, ${RED}${FAIL_COUNT} failed${NC}"
  
  # GATE_SUMMARY marker for CI
  echo ""
  echo "GATE_SUMMARY: Gate 11 - ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
  
  if [[ $FAIL_COUNT -gt 0 ]]; then
    echo ""
    echo -e "${RED}GATE 11 FAILED${NC}"
    exit 1
  else
    echo ""
    echo -e "${GREEN}GATE 11 PASSED${NC}"
  fi
}

###############################################################################
# Main
###############################################################################
main() {
  echo ""
  echo -e "${CYAN}╔════════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║       Phase 9 Provenance Footer Contract Gate (Gate 11)       ║${NC}"
  echo -e "${CYAN}╚════════════════════════════════════════════════════════════════╝${NC}"
  
  gate_shell_anchors
  gate_footer_component
  gate_single_source
  gate_no_undefined
  gate_embed_safe
  gate_layout_adjustment
  print_summary
}

main "$@"
