#!/usr/bin/env bash
###############################################################################
# Phase 8 Orders Decision Proof Contract Gate (Gate 10)
# 
# Verifies Phase 8 Orders page enhancements:
# - Decision Proof panel with required anchors
# - Copy-to-clipboard actions for token and digest
# - No "undefined" strings in template
# - Embed-safe styling (no fixed background bleed)
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
# Gate 10.1: Decision Proof Panel Anchors
###############################################################################

gate_decision_proof_anchors() {
  log_header "GATE 10.1: Decision Proof Panel Anchors"
  
  local ORDERS_FILE="$PROJECT_ROOT/services/ui/public/orders.html"
  
  if [[ ! -f "$ORDERS_FILE" ]]; then
    fail "Orders file exists"
    return
  fi
  pass "Orders file exists"
  
  # Check for decision proof panel anchor
  if grep -qE "id=[\"']decision-proof-panel[\"']" "$ORDERS_FILE"; then
    pass "Decision proof panel anchor exists"
  else
    fail "Decision proof panel anchor exists"
  fi
  
  # Check for proof token anchor
  if grep -qE "id=[\"']proof-decision-token[\"']" "$ORDERS_FILE"; then
    pass "Proof decision token anchor exists"
  else
    fail "Proof decision token anchor exists"
  fi
  
  # Check for proof digest anchor
  if grep -qE "id=[\"']proof-order-digest[\"']" "$ORDERS_FILE"; then
    pass "Proof order digest anchor exists"
  else
    fail "Proof order digest anchor exists"
  fi
  
  # Check for audit chain list anchor
  if grep -qE "id=[\"']audit-chain-list[\"']" "$ORDERS_FILE"; then
    pass "Audit chain list anchor exists"
  else
    fail "Audit chain list anchor exists"
  fi
  
  # Check for verdict badge
  if grep -q "proof-verdict-badge" "$ORDERS_FILE"; then
    pass "Proof verdict badge class exists"
  else
    fail "Proof verdict badge class exists"
  fi
}

###############################################################################
# Gate 10.2: Copy Actions
###############################################################################

gate_copy_actions() {
  log_header "GATE 10.2: Copy-to-Clipboard Actions"
  
  local ORDERS_FILE="$PROJECT_ROOT/services/ui/public/orders.html"
  
  # Check for copy button for decision token
  if grep -qE "id=[\"']copy-decision-token[\"']" "$ORDERS_FILE"; then
    pass "Copy decision token button anchor exists"
  else
    fail "Copy decision token button anchor exists"
  fi
  
  # Check for copy button for order digest
  if grep -qE "id=[\"']copy-order-digest[\"']" "$ORDERS_FILE"; then
    pass "Copy order digest button anchor exists"
  else
    fail "Copy order digest button anchor exists"
  fi
  
  # Check for copyToClipboard function
  if grep -q "copyToClipboard" "$ORDERS_FILE"; then
    pass "copyToClipboard function exists"
  else
    fail "copyToClipboard function exists"
  fi
  
  # Check for navigator.clipboard usage
  if grep -q "navigator.clipboard" "$ORDERS_FILE"; then
    pass "Uses navigator.clipboard API"
  else
    fail "Uses navigator.clipboard API"
  fi
  
  # Check for copy confirmation visual feedback
  if grep -q "\.copied" "$ORDERS_FILE"; then
    pass "Copy confirmation CSS class exists"
  else
    fail "Copy confirmation CSS class exists"
  fi
}

###############################################################################
# Gate 10.3: No Undefined Strings in Template
###############################################################################

gate_no_undefined() {
  log_header "GATE 10.3: No 'undefined' Strings in Template"
  
  local ORDERS_FILE="$PROJECT_ROOT/services/ui/public/orders.html"
  
  # Check for defensive fallbacks (|| '--') pattern
  local fallback_count=$(grep -c "|| '--'" "$ORDERS_FILE" || echo "0")
  
  if [[ "$fallback_count" -ge 10 ]]; then
    pass "Has $fallback_count defensive fallbacks (|| '--')"
  else
    fail "Insufficient defensive fallbacks: $fallback_count (expected >= 10)"
  fi
  
  # Check for null-safe access patterns
  if grep -qE "\?\." "$ORDERS_FILE"; then
    pass "Uses optional chaining (?.) for null safety"
  else
    fail "Uses optional chaining (?.) for null safety"
  fi
  
  # Check that template doesn't have literal 'undefined' as output
  # This checks for patterns like: `${undefined}` or similar
  if ! grep -qE '`[^`]*\$\{undefined\}[^`]*`' "$ORDERS_FILE"; then
    pass "No literal undefined in template strings"
  else
    fail "Found literal undefined in template strings"
  fi
}

###############################################################################
# Gate 10.4: Embed-Safe Styling
###############################################################################

gate_embed_safe() {
  log_header "GATE 10.4: Embed-Safe Styling"
  
  local ORDERS_FILE="$PROJECT_ROOT/services/ui/public/orders.html"
  
  # Check for embed mode class handling
  if grep -q "embed-mode" "$ORDERS_FILE"; then
    pass "Embed mode class handling exists"
  else
    fail "Embed mode class handling exists"
  fi
  
  # Check for CSS variable usage (theme-safe)
  if grep -q "var(--" "$ORDERS_FILE"; then
    pass "Uses CSS variables for theming"
  else
    fail "Uses CSS variables for theming"
  fi
  
  # Decision proof section should not have fixed positioning
  if ! grep -qE "decision-proof.*position:\s*fixed" "$ORDERS_FILE"; then
    pass "Decision proof panel not using fixed positioning"
  else
    fail "Decision proof panel using fixed positioning (breaks embed)"
  fi
  
  # Check decision proof section uses relative units or variables
  if grep -q "decision-proof-section" "$ORDERS_FILE"; then
    pass "Decision proof section CSS class defined"
  else
    fail "Decision proof section CSS class defined"
  fi
}

###############################################################################
# Gate 10.5: Lifecycle Integration
###############################################################################

gate_lifecycle_integration() {
  log_header "GATE 10.5: Lifecycle Data Integration"
  
  local ORDERS_FILE="$PROJECT_ROOT/services/ui/public/orders.html"
  
  # Check for lifecycle API call
  if grep -q "/api/orders/.*/lifecycle" "$ORDERS_FILE"; then
    pass "Lifecycle API endpoint referenced"
  else
    fail "Lifecycle API endpoint referenced"
  fi
  
  # Check renderDetail accepts lifecycle parameter
  if grep -q "renderDetail(order, lifecycle)" "$ORDERS_FILE"; then
    pass "renderDetail accepts lifecycle parameter"
  else
    fail "renderDetail accepts lifecycle parameter"
  fi
  
  # Check for computeOrderDigest function
  if grep -q "computeOrderDigest" "$ORDERS_FILE"; then
    pass "computeOrderDigest function exists"
  else
    fail "computeOrderDigest function exists"
  fi
}

###############################################################################
# Gate 10.6: Export Actions Preserved
###############################################################################

gate_export_actions() {
  log_header "GATE 10.6: Export Actions Preserved"
  
  local ORDERS_FILE="$PROJECT_ROOT/services/ui/public/orders.html"
  
  # Check evidence pack export still exists
  if grep -qE "id=[\"']order-export-evidence[\"']" "$ORDERS_FILE"; then
    pass "Evidence pack export button preserved"
  else
    fail "Evidence pack export button preserved"
  fi
  
  # Check dispute pack export still exists
  if grep -qE "id=[\"']order-export-dispute[\"']" "$ORDERS_FILE"; then
    pass "Dispute pack export button preserved"
  else
    fail "Dispute pack export button preserved"
  fi
  
  # Check exportEvidence function exists
  if grep -q "exportEvidence" "$ORDERS_FILE"; then
    pass "exportEvidence function exists"
  else
    fail "exportEvidence function exists"
  fi
  
  # Check exportDispute function exists
  if grep -q "exportDispute" "$ORDERS_FILE"; then
    pass "exportDispute function exists"
  else
    fail "exportDispute function exists"
  fi
}

###############################################################################
# Summary
###############################################################################

print_summary() {
  echo ""
  echo -e "${CYAN}══════════════════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  GATE 10 SUMMARY: Phase 8 Orders Decision Proof Contract${NC}"
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
  echo "GATE_SUMMARY: Gate 10 - ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
  
  if [[ $FAIL_COUNT -gt 0 ]]; then
    echo ""
    echo -e "${RED}GATE 10 FAILED${NC}"
    exit 1
  else
    echo ""
    echo -e "${GREEN}GATE 10 PASSED${NC}"
  fi
}

###############################################################################
# Main
###############################################################################
main() {
  echo ""
  echo -e "${CYAN}╔════════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║      Phase 8 Orders Decision Proof Contract Gate (Gate 10)    ║${NC}"
  echo -e "${CYAN}╚════════════════════════════════════════════════════════════════╝${NC}"
  
  gate_decision_proof_anchors
  gate_copy_actions
  gate_no_undefined
  gate_embed_safe
  gate_lifecycle_integration
  gate_export_actions
  print_summary
}

main "$@"
