#!/usr/bin/env bash
# Phase 10: Infrastructure Status Dashboard Contract Gate
# Static checks only - no runtime curl (services may not be running in CI)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

PASSED=0
FAILED=0
RESULTS=""

check() {
  local name="$1"
  local condition="$2"
  
  if eval "$condition"; then
    PASSED=$((PASSED + 1))
    RESULTS="${RESULTS}✓ ${name}\n"
  else
    FAILED=$((FAILED + 1))
    RESULTS="${RESULTS}✗ ${name}\n"
  fi
}

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║  Phase 10: Infrastructure Status Dashboard Contract Gate       ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# ============================================================================
# File existence checks
# ============================================================================
echo "📁 File Existence Checks"
echo "─────────────────────────────────────────────────────────────────"

check "infrastructure.html exists" \
  "[[ -f services/ui/public/infrastructure.html ]]"

check "server.js exists" \
  "[[ -f services/ui/server.js ]]"

check "command-center-v2.html exists" \
  "[[ -f services/ui/public/command-center-v2.html ]]"

echo ""

# ============================================================================
# Infrastructure page DOM anchors
# ============================================================================
echo "🔍 Infrastructure Page DOM Anchors"
echo "─────────────────────────────────────────────────────────────────"

check 'id="infra-status-banner" in infrastructure.html' \
  "grep -q 'id=\"infra-status-banner\"' services/ui/public/infrastructure.html"

check 'id="infra-last-check" in infrastructure.html' \
  "grep -q 'id=\"infra-last-check\"' services/ui/public/infrastructure.html"

check 'id="infra-sidecars" in infrastructure.html' \
  "grep -q 'id=\"infra-sidecars\"' services/ui/public/infrastructure.html"

check 'id="infra-services" in infrastructure.html' \
  "grep -q 'id=\"infra-services\"' services/ui/public/infrastructure.html"

check 'id="infra-metrics" in infrastructure.html' \
  "grep -q 'id=\"infra-metrics\"' services/ui/public/infrastructure.html"

echo ""

# ============================================================================
# Infrastructure page state containers
# ============================================================================
echo "🔄 State Container Anchors"
echo "─────────────────────────────────────────────────────────────────"

check 'id="infra-state-loading" in infrastructure.html' \
  "grep -q 'id=\"infra-state-loading\"' services/ui/public/infrastructure.html"

check 'id="infra-state-error" in infrastructure.html' \
  "grep -q 'id=\"infra-state-error\"' services/ui/public/infrastructure.html"

check 'id="infra-state-ready" in infrastructure.html' \
  "grep -q 'id=\"infra-state-ready\"' services/ui/public/infrastructure.html"

echo ""

# ============================================================================
# Server routes
# ============================================================================
echo "🌐 Server Route Checks"
echo "─────────────────────────────────────────────────────────────────"

check '/api/infrastructure/status endpoint in server.js' \
  "grep -q '/api/infrastructure/status' services/ui/server.js"

check '/infrastructure route in server.js' \
  "grep -q '\"/infrastructure\"' services/ui/server.js"

check 'INFRA_TARGETS defined in server.js' \
  "grep -q 'INFRA_TARGETS' services/ui/server.js"

check 'checkServiceHealth function in server.js' \
  "grep -q 'checkServiceHealth' services/ui/server.js"

echo ""

# ============================================================================
# Shell integration checks
# ============================================================================
echo "🐚 Shell Integration (command-center-v2.html)"
echo "─────────────────────────────────────────────────────────────────"

check 'id="tab-infra" in command-center-v2.html' \
  "grep -q 'id=\"tab-infra\"' services/ui/public/command-center-v2.html"

check 'id="panel-infra" in command-center-v2.html' \
  "grep -q 'id=\"panel-infra\"' services/ui/public/command-center-v2.html"

check 'id="infra-badge" in command-center-v2.html' \
  "grep -q 'id=\"infra-badge\"' services/ui/public/command-center-v2.html"

check 'validTabs includes infra' \
  "grep -q \"'infra'\" services/ui/public/command-center-v2.html"

check 'Infrastructure iframe embed in command-center-v2.html' \
  "grep -q '/infrastructure?embed=1' services/ui/public/command-center-v2.html"

echo ""

# ============================================================================
# Header connection indicator
# ============================================================================
echo "🔗 Header Connection Indicator"
echo "─────────────────────────────────────────────────────────────────"

check 'id="header-connection" in command-center-v2.html' \
  "grep -q 'id=\"header-connection\"' services/ui/public/command-center-v2.html"

check 'id="connection-shape" in command-center-v2.html' \
  "grep -q 'id=\"connection-shape\"' services/ui/public/command-center-v2.html"

check 'id="connection-text" in command-center-v2.html' \
  "grep -q 'id=\"connection-text\"' services/ui/public/command-center-v2.html"

check 'id="connection-latency" in command-center-v2.html' \
  "grep -q 'id=\"connection-latency\"' services/ui/public/command-center-v2.html"

echo ""

# ============================================================================
# Contract shape checks (API response)
# ============================================================================
echo "📋 API Contract Shape"
echo "─────────────────────────────────────────────────────────────────"

check 'schema_version in response' \
  "grep -q 'schema_version' services/ui/server.js"

check 'status field (ok|warn|error) in aggregator' \
  "grep -q 'aggregateStatus' services/ui/server.js"

check 'data.services array' \
  "grep -q 'services:' services/ui/server.js || grep -q 'services,' services/ui/server.js"

check 'data.sidecars array' \
  "grep -q 'sidecars:' services/ui/server.js"

check 'data.metrics object' \
  "grep -q 'metrics:' services/ui/server.js"

echo ""

# ============================================================================
# Hysteresis and freshness
# ============================================================================
echo "⏱️ Hysteresis & Freshness Checks"
echo "─────────────────────────────────────────────────────────────────"

check 'Hysteresis constant in infrastructure.html' \
  "grep -q 'HYSTERESIS' services/ui/public/infrastructure.html"

check 'Stale threshold in infrastructure.html' \
  "grep -q 'STALE' services/ui/public/infrastructure.html"

check 'Polling interval in infrastructure.html' \
  "grep -q 'POLL_INTERVAL' services/ui/public/infrastructure.html"

check 'Cache-Control header in server.js' \
  "grep -q 'Cache-Control' services/ui/server.js"

echo ""

# ============================================================================
# Summary
# ============================================================================
echo "═══════════════════════════════════════════════════════════════════"
echo ""
echo -e "$RESULTS"
echo "═══════════════════════════════════════════════════════════════════"
echo "GATE_SUMMARY gate=ph10-infrastructure passed=$PASSED failed=$FAILED"

TOTAL=$((PASSED + FAILED))
if [[ $FAILED -gt 0 ]]; then
  echo ""
  echo "❌ GATE FAILED: $FAILED/$TOTAL checks failed"
  exit 1
else
  echo ""
  echo "✅ GATE PASSED: All $TOTAL checks passed"
  exit 0
fi
