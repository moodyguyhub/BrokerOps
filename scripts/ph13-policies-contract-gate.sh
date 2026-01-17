#!/usr/bin/env bash
# Phase 13: Policies Contract Gate
# Static checks + optional runtime validation for /api/policies/status

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
echo "║  Phase 13: Policies Contract Gate                              ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# ============================================================================
# File existence checks
# ============================================================================
echo "📁 File Existence Checks"
echo "─────────────────────────────────────────────────────────────────"

check "policies.html exists" \
  "[[ -f services/ui/public/policies.html ]]"

check "server.js exists" \
  "[[ -f services/ui/server.js ]]"

check "command-center-v2.html exists" \
  "[[ -f services/ui/public/command-center-v2.html ]]"

check "policies/order.rego exists" \
  "[[ -f policies/order.rego ]]"

echo ""

# ============================================================================
# Policies page DOM anchors (4 explicit states)
# ============================================================================
echo "🔍 Policies Page DOM Anchors"
echo "─────────────────────────────────────────────────────────────────"

check 'id="policies-state-loading" in policies.html' \
  "grep -q 'id=\"policies-state-loading\"' services/ui/public/policies.html"

check 'id="policies-state-error" in policies.html' \
  "grep -q 'id=\"policies-state-error\"' services/ui/public/policies.html"

check 'id="policies-state-empty" in policies.html' \
  "grep -q 'id=\"policies-state-empty\"' services/ui/public/policies.html"

check 'id="policies-state-ready" in policies.html' \
  "grep -q 'id=\"policies-state-ready\"' services/ui/public/policies.html"

check 'id="policies-status-banner" in policies.html' \
  "grep -q 'id=\"policies-status-banner\"' services/ui/public/policies.html"

check 'id="policies-version" in policies.html' \
  "grep -q 'id=\"policies-version\"' services/ui/public/policies.html"

check 'id="policies-bundle-sha" in policies.html' \
  "grep -q 'id=\"policies-bundle-sha\"' services/ui/public/policies.html"

check 'id="policies-rules-count" in policies.html' \
  "grep -q 'id=\"policies-rules-count\"' services/ui/public/policies.html"

check 'id="policies-compile-state" in policies.html' \
  "grep -q 'id=\"policies-compile-state\"' services/ui/public/policies.html"

echo ""

# ============================================================================
# Server route checks
# ============================================================================
echo "🌐 Server Route Checks"
echo "─────────────────────────────────────────────────────────────────"

check '/api/policies/status endpoint in server.js' \
  "grep -q '/api/policies/status' services/ui/server.js"

check 'normalizePolicyStatus function in server.js' \
  "grep -q 'normalizePolicyStatus' services/ui/server.js"

check 'computePolicyBundle function in server.js' \
  "grep -q 'computePolicyBundle' services/ui/server.js"

check 'checkOpaHealth function in server.js' \
  "grep -q 'checkOpaHealth' services/ui/server.js"

check '/policies route in server.js' \
  "grep -q '\"/policies\"' services/ui/server.js"

echo ""

# ============================================================================
# Shell integration checks (command-center-v2.html)
# ============================================================================
echo "🐚 Shell Integration (command-center-v2.html)"
echo "─────────────────────────────────────────────────────────────────"

check 'id="tab-policies" in command-center-v2.html' \
  "grep -q 'id=\"tab-policies\"' services/ui/public/command-center-v2.html"

check 'id="panel-policies" in command-center-v2.html' \
  "grep -q 'id=\"panel-policies\"' services/ui/public/command-center-v2.html"

check 'id="policies-badge" in command-center-v2.html' \
  "grep -q 'id=\"policies-badge\"' services/ui/public/command-center-v2.html"

check 'validTabs includes policies' \
  "grep -q \"'policies'\" services/ui/public/command-center-v2.html"

check 'Policies iframe embed URL' \
  "grep -q '/policies?embed=1' services/ui/public/command-center-v2.html"

echo ""

# ============================================================================
# API Contract Schema Checks
# ============================================================================
echo "📋 API Contract Schema (static checks)"
echo "─────────────────────────────────────────────────────────────────"

check 'schema_version in normalizePolicyStatus' \
  "grep -q 'schema_version' services/ui/server.js"

check 'bundle.sha256 field in response' \
  "grep -q 'sha256' services/ui/server.js"

check 'bundle.rules_count field in response' \
  "grep -q 'rules_count' services/ui/server.js"

check 'compile.state field in response' \
  "grep -q 'compile.*state' services/ui/server.js"

check 'OPA_URL configuration' \
  "grep -q 'OPA_URL' services/ui/server.js"

echo ""

# ============================================================================
# Policy file content checks
# ============================================================================
echo "📜 Policy File Content"
echo "─────────────────────────────────────────────────────────────────"

check 'policy_version defined in order.rego' \
  "grep -q 'policy_version' policies/order.rego"

check 'broker.risk.order package in order.rego' \
  "grep -q 'package broker.risk.order' policies/order.rego"

echo ""

# ============================================================================
# Runtime checks (optional - only if UI server is running)
# ============================================================================
if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
  echo "🔗 Runtime API Checks (UI server detected)"
  echo "─────────────────────────────────────────────────────────────────"

  check 'API returns schema_version' \
    "curl -sf http://localhost:3000/api/policies/status | jq -e '.schema_version' > /dev/null"

  check 'API returns status field' \
    "curl -sf http://localhost:3000/api/policies/status | jq -e '.status' > /dev/null"

  check 'API returns bundle.sha256' \
    "curl -sf http://localhost:3000/api/policies/status | jq -e '.bundle.sha256' > /dev/null"

  check 'API returns bundle.rules_count' \
    "curl -sf http://localhost:3000/api/policies/status | jq -e '.bundle.rules_count' > /dev/null"

  check 'API returns compile.state' \
    "curl -sf http://localhost:3000/api/policies/status | jq -e '.compile.state' > /dev/null"

  check 'API returns rules array' \
    "curl -sf http://localhost:3000/api/policies/status | jq -e '.rules | type == \"array\"' > /dev/null"

  check 'API status is not undefined' \
    "curl -sf http://localhost:3000/api/policies/status | jq -e '.status != null' > /dev/null"

  echo ""
else
  echo "⏭️  Runtime checks skipped (UI server not running on :3000)"
  echo ""
fi

# ============================================================================
# Summary
# ============================================================================
echo "═══════════════════════════════════════════════════════════════════"
echo ""
printf "%b" "$RESULTS"
echo "═══════════════════════════════════════════════════════════════════"
echo "GATE_SUMMARY gate=ph13-policies passed=$PASSED failed=$FAILED"

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
