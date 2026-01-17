#!/usr/bin/env bash
###############################################################################
# Phase 7 Dashboard Contract Gate (Gate 9)
# 
# Verifies Phase 7 dashboard enhancements:
# - KPI cards with sparklines
# - Governance funnel section
# - LP health strip
# - Timeline API integration
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
# Gate 9.1: KPI Cards with Sparklines
###############################################################################

gate_kpi_sparklines() {
  log_header "GATE 9.1: KPI Cards with Sparklines"
  
  local DASHBOARD_FILE="$PROJECT_ROOT/services/ui/public/dashboard.html"
  
  if [[ ! -f "$DASHBOARD_FILE" ]]; then
    fail "Dashboard file exists"
    return
  fi
  pass "Dashboard file exists"
  
  # Check for sparkline containers
  local sparkline_anchors=("sparkline-orders" "sparkline-fill-rate" "sparkline-rejections" "sparkline-alerts")
  
  for anchor in "${sparkline_anchors[@]}"; do
    if grep -qE "id=[\"']${anchor}[\"']" "$DASHBOARD_FILE"; then
      pass "Sparkline anchor: ${anchor}"
    else
      fail "Sparkline anchor: ${anchor}"
    fi
  done
  
  # Check for sparkline CSS
  if grep -q "sparkline-container" "$DASHBOARD_FILE"; then
    pass "Sparkline CSS class defined"
  else
    fail "Sparkline CSS class defined"
  fi
  
  if grep -q "sparkline-bar" "$DASHBOARD_FILE"; then
    pass "Sparkline bar CSS class defined"
  else
    fail "Sparkline bar CSS class defined"
  fi
  
  # Check for fetchTimeline function
  if grep -q "fetchTimeline" "$DASHBOARD_FILE"; then
    pass "fetchTimeline function exists"
  else
    fail "fetchTimeline function exists"
  fi
  
  # Check for renderSparklines function
  if grep -q "renderSparklines" "$DASHBOARD_FILE"; then
    pass "renderSparklines function exists"
  else
    fail "renderSparklines function exists"
  fi
}

###############################################################################
# Gate 9.2: Governance Funnel Section
###############################################################################

gate_governance_funnel() {
  log_header "GATE 9.2: Governance Funnel Section"
  
  local DASHBOARD_FILE="$PROJECT_ROOT/services/ui/public/dashboard.html"
  
  # Check for governance funnel anchor
  if grep -qE "id=[\"']governance-funnel[\"']" "$DASHBOARD_FILE"; then
    pass "Governance funnel anchor exists"
  else
    fail "Governance funnel anchor exists"
  fi
  
  # Check for funnel stage elements
  local funnel_stages=("funnel-inbound" "funnel-authorized" "funnel-pending" "funnel-blocked")
  
  for stage in "${funnel_stages[@]}"; do
    if grep -qE "id=[\"']${stage}[\"']" "$DASHBOARD_FILE"; then
      pass "Funnel stage anchor: ${stage}"
    else
      fail "Funnel stage anchor: ${stage}"
    fi
  done
  
  # Check for funnel bar segments
  local bar_segments=("funnel-bar-authorized" "funnel-bar-pending" "funnel-bar-blocked")
  
  for segment in "${bar_segments[@]}"; do
    if grep -qE "id=[\"']${segment}[\"']" "$DASHBOARD_FILE"; then
      pass "Funnel bar segment: ${segment}"
    else
      fail "Funnel bar segment: ${segment}"
    fi
  done
  
  # Check for updateGovernanceFunnel function
  if grep -q "updateGovernanceFunnel" "$DASHBOARD_FILE"; then
    pass "updateGovernanceFunnel function exists"
  else
    fail "updateGovernanceFunnel function exists"
  fi
  
  # Check for governance funnel CSS
  if grep -q "governance-funnel" "$DASHBOARD_FILE"; then
    pass "Governance funnel CSS defined"
  else
    fail "Governance funnel CSS defined"
  fi
  
  if grep -q "funnel-stages" "$DASHBOARD_FILE"; then
    pass "Funnel stages CSS defined"
  else
    fail "Funnel stages CSS defined"
  fi
}

###############################################################################
# Gate 9.3: LP Health Strip
###############################################################################

gate_lp_health_strip() {
  log_header "GATE 9.3: LP Health Strip"
  
  local DASHBOARD_FILE="$PROJECT_ROOT/services/ui/public/dashboard.html"
  
  # Check for LP health strip anchor
  if grep -qE "id=[\"']lp-health-strip[\"']" "$DASHBOARD_FILE"; then
    pass "LP health strip anchor exists"
  else
    fail "LP health strip anchor exists"
  fi
  
  # Check for health row anchor
  if grep -qE "id=[\"']lp-health-row[\"']" "$DASHBOARD_FILE"; then
    pass "LP health row anchor exists"
  else
    fail "LP health row anchor exists"
  fi
  
  # Check for renderLPHealthStrip function
  if grep -q "renderLPHealthStrip" "$DASHBOARD_FILE"; then
    pass "renderLPHealthStrip function exists"
  else
    fail "renderLPHealthStrip function exists"
  fi
  
  # Check for health chip CSS classes
  if grep -q "health-chip" "$DASHBOARD_FILE"; then
    pass "Health chip CSS defined"
  else
    fail "Health chip CSS defined"
  fi
  
  # Check for traffic light states
  if grep -q "health-chip.healthy" "$DASHBOARD_FILE"; then
    pass "Healthy state CSS defined"
  else
    fail "Healthy state CSS defined"
  fi
  
  if grep -q "health-chip.warning" "$DASHBOARD_FILE"; then
    pass "Warning state CSS defined"
  else
    fail "Warning state CSS defined"
  fi
  
  if grep -q "health-chip.critical" "$DASHBOARD_FILE"; then
    pass "Critical state CSS defined"
  else
    fail "Critical state CSS defined"
  fi
}

###############################################################################
# Gate 9.4: Timeline API Integration
###############################################################################

gate_timeline_integration() {
  log_header "GATE 9.4: Timeline API Integration"
  
  local DASHBOARD_FILE="$PROJECT_ROOT/services/ui/public/dashboard.html"
  
  # Check for timeline API call
  if grep -q "/api/dashboard/timeline" "$DASHBOARD_FILE"; then
    pass "Timeline API endpoint referenced"
  else
    fail "Timeline API endpoint referenced"
  fi
  
  # Check fetchTimeline is called in refreshAll
  if grep -A10 "refreshAll" "$DASHBOARD_FILE" | grep -q "fetchTimeline"; then
    pass "fetchTimeline called in refreshAll"
  else
    fail "fetchTimeline called in refreshAll"
  fi
  
  # Check that LP accounts triggers health strip render
  if grep -A10 "async function fetchLPAccounts" "$DASHBOARD_FILE" | grep -q "renderLPHealthStrip"; then
    pass "renderLPHealthStrip called from fetchLPAccounts"
  else
    fail "renderLPHealthStrip called from fetchLPAccounts"
  fi
  
  # Check for funnel update in fetchKPIs
  if grep -A40 "fetchKPIs" "$DASHBOARD_FILE" | grep -q "updateGovernanceFunnel"; then
    pass "updateGovernanceFunnel called from fetchKPIs"
  else
    fail "updateGovernanceFunnel called from fetchKPIs"
  fi
}

###############################################################################
# Gate 9.5: KPI Grid Anchor (for embed coherence)
###############################################################################

gate_kpi_grid_anchor() {
  log_header "GATE 9.5: KPI Grid Anchor"
  
  local DASHBOARD_FILE="$PROJECT_ROOT/services/ui/public/dashboard.html"
  
  # Check for kpi-grid anchor ID
  if grep -qE "id=[\"']kpi-grid[\"']" "$DASHBOARD_FILE"; then
    pass "kpi-grid anchor exists"
  else
    fail "kpi-grid anchor exists"
  fi
}

###############################################################################
# Summary
###############################################################################

print_summary() {
  echo ""
  echo -e "${CYAN}══════════════════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  GATE 9 SUMMARY: Phase 7 Dashboard Contract${NC}"
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
  echo "GATE_SUMMARY: Gate 9 - ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
  
  if [[ $FAIL_COUNT -gt 0 ]]; then
    echo ""
    echo -e "${RED}GATE 9 FAILED${NC}"
    exit 1
  else
    echo ""
    echo -e "${GREEN}GATE 9 PASSED${NC}"
  fi
}

###############################################################################
# Main
###############################################################################
main() {
  echo ""
  echo -e "${CYAN}╔════════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║         Phase 7 Dashboard Contract Gate (Gate 9)              ║${NC}"
  echo -e "${CYAN}╚════════════════════════════════════════════════════════════════╝${NC}"
  
  gate_kpi_sparklines
  gate_governance_funnel
  gate_lp_health_strip
  gate_timeline_integration
  gate_kpi_grid_anchor
  print_summary
}

main "$@"
