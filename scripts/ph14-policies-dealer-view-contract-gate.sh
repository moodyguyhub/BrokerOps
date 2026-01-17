#!/usr/bin/env bash
# ==============================================================================
# Phase 14: Policies Dealer View Contract Gate
# ==============================================================================
# Additive to Phase 13 (policies contract floor) — verifies dealer view anchors
# and new API endpoints without breaking existing Phase 13 surfaces.
#
# Non-negotiables:
#   1. Phase 13 must remain green (run ph13 first)
#   2. New DOM IDs: policies-dealer-* prefix
#   3. New endpoints: /api/policies/list, /api/policies/detail
#   4. Fail-closed: allowlist enforcement on detail endpoint
#
# Usage: ./scripts/ph14-policies-dealer-view-contract-gate.sh
# ==============================================================================

set -uo pipefail

PASSED=0
FAILED=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

check() {
  local description="$1"
  local command="$2"
  
  if eval "$command" > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} $description"
    ((PASSED++))
  else
    echo -e "${RED}✗${NC} $description"
    ((FAILED++))
  fi
}

echo "═══════════════════════════════════════════════════════════════════"
echo "Phase 14: Policies Dealer View Contract Gate"
echo "═══════════════════════════════════════════════════════════════════"
echo ""

# ==============================================================================
# Section 1: File existence
# ==============================================================================
echo "Section 1: File existence"
echo "-------------------------------------------------------------------"

check "policies.html exists" \
  "test -f services/ui/public/policies.html"

check "server.js exists" \
  "test -f services/ui/server.js"

check "ph13 gate exists (dependency)" \
  "test -f scripts/ph13-policies-contract-gate.sh"

echo ""

# ==============================================================================
# Section 2: Dealer View DOM Anchors (policies-dealer-* prefix)
# ==============================================================================
echo "Section 2: Dealer View DOM Anchors"
echo "-------------------------------------------------------------------"

POLICIES_HTML="services/ui/public/policies.html"

check "policies-dealer-section anchor exists" \
  "grep -q 'id=\"policies-dealer-section\"' '$POLICIES_HTML'"

check "policies-dealer-file-count anchor exists" \
  "grep -q 'id=\"policies-dealer-file-count\"' '$POLICIES_HTML'"

check "policies-dealer-file-list anchor exists" \
  "grep -q 'id=\"policies-dealer-file-list\"' '$POLICIES_HTML'"

check "policies-dealer-source-viewer anchor exists" \
  "grep -q 'id=\"policies-dealer-source-viewer\"' '$POLICIES_HTML'"

check "policies-dealer-source-filename anchor exists" \
  "grep -q 'id=\"policies-dealer-source-filename\"' '$POLICIES_HTML'"

check "policies-dealer-source-meta anchor exists" \
  "grep -q 'id=\"policies-dealer-source-meta\"' '$POLICIES_HTML'"

check "policies-dealer-source-content anchor exists" \
  "grep -q 'id=\"policies-dealer-source-content\"' '$POLICIES_HTML'"

echo ""

# ==============================================================================
# Section 3: Phase 14 API Route Definitions (server.js)
# ==============================================================================
echo "Section 3: Phase 14 API Route Definitions"
echo "-------------------------------------------------------------------"

SERVER_JS="services/ui/server.js"

check "/api/policies/list route defined" \
  "grep -q 'app.get.*\"/api/policies/list\"' '$SERVER_JS'"

check "/api/policies/detail route defined" \
  "grep -q 'app.get.*\"/api/policies/detail\"' '$SERVER_JS'"

check "POLICY_FILE_ALLOWLIST defined (fail-closed)" \
  "grep -q 'POLICY_FILE_ALLOWLIST' '$SERVER_JS'"

check "Phase 14 section header in server.js" \
  "grep -q 'Phase 14.*Policies Dealer View' '$SERVER_JS'"

echo ""

# ==============================================================================
# Section 4: API Response Schema (/api/policies/list)
# ==============================================================================
echo "Section 4: List Endpoint Schema"
echo "-------------------------------------------------------------------"

check "list endpoint returns schema_version" \
  "grep -qE 'schema_version.*1\\.0\\.0' '$SERVER_JS'"

check "list endpoint returns files array" \
  "grep -q 'files:' '$SERVER_JS'"

check "list endpoint returns total_count" \
  "grep -q 'total_count:' '$SERVER_JS'"

check "list endpoint returns fetched_at" \
  "grep -q 'fetched_at:' '$SERVER_JS'"

echo ""

# ==============================================================================
# Section 5: API Response Schema (/api/policies/detail)
# ==============================================================================
echo "Section 5: Detail Endpoint Schema"
echo "-------------------------------------------------------------------"

check "detail endpoint returns filename" \
  "grep -q 'filename,' '$SERVER_JS' || grep -q 'filename:' '$SERVER_JS'"

check "detail endpoint returns content" \
  "grep -q 'content,' '$SERVER_JS' || grep -q 'content:' '$SERVER_JS'"

check "detail endpoint validates allowlist" \
  "grep -q 'POLICY_FILE_ALLOWLIST.includes' '$SERVER_JS'"

check "detail endpoint returns 404 for unknown files" \
  "grep -q '404.*File not in allowlist' '$SERVER_JS' || grep -q 'res.status(404)' '$SERVER_JS'"

echo ""

# ==============================================================================
# Section 6: JavaScript fetch integration
# ==============================================================================
echo "Section 6: JavaScript Fetch Integration"
echo "-------------------------------------------------------------------"

check "fetchPolicyList function defined" \
  "grep -q 'async function fetchPolicyList' '$POLICIES_HTML'"

check "fetchPolicyDetail function defined" \
  "grep -q 'async function fetchPolicyDetail' '$POLICIES_HTML'"

check "renderPolicyFileList function defined" \
  "grep -q 'function renderPolicyFileList' '$POLICIES_HTML'"

check "renderPolicyDetail function defined" \
  "grep -q 'function renderPolicyDetail' '$POLICIES_HTML'"

check "Fetches /api/policies/list" \
  "grep -q \"fetch('/api/policies/list')\" '$POLICIES_HTML'"

check "Fetches /api/policies/detail" \
  "grep -q \"/api/policies/detail\" '$POLICIES_HTML'"

echo ""

# ==============================================================================
# Section 7: Runtime checks (optional, requires server running)
# ==============================================================================
echo "Section 7: Runtime Checks (optional)"
echo "-------------------------------------------------------------------"

UI_URL="${UI_URL:-http://localhost:3000}"

if curl -sf "${UI_URL}/health" > /dev/null 2>&1; then
  echo "UI server reachable at ${UI_URL}, running runtime checks..."
  
  # /api/policies/list
  LIST_RESPONSE=$(curl -sf "${UI_URL}/api/policies/list" 2>/dev/null || echo "{}")
  
  check "API list returns schema_version 1.0.0" \
    "echo '$LIST_RESPONSE' | jq -e '.schema_version == \"1.0.0\"'"
  
  check "API list returns files array" \
    "echo '$LIST_RESPONSE' | jq -e '.files | type == \"array\"'"
  
  check "API list returns total_count" \
    "echo '$LIST_RESPONSE' | jq -e '.total_count != null'"
  
  check "API list returns fetched_at timestamp" \
    "echo '$LIST_RESPONSE' | jq -e '.fetched_at != null'"
  
  # /api/policies/detail?file=order.rego
  DETAIL_RESPONSE=$(curl -sf "${UI_URL}/api/policies/detail?file=order.rego" 2>/dev/null || echo "{}")
  
  check "API detail returns filename" \
    "echo '$DETAIL_RESPONSE' | jq -e '.filename == \"order.rego\"'"
  
  check "API detail returns content" \
    "echo '$DETAIL_RESPONSE' | jq -e '.content != null and (.content | length) > 0'"
  
  check "API detail returns sha256" \
    "echo '$DETAIL_RESPONSE' | jq -e '.sha256 != null'"
  
  check "API detail returns policy_version" \
    "echo '$DETAIL_RESPONSE' | jq -e '.policy_version != null'"
  
  # Allowlist enforcement (fail-closed test) - use curl -s not -sf since we expect 404
  BLOCKED_RESPONSE=$(curl -s "${UI_URL}/api/policies/detail?file=EVIL.rego" 2>/dev/null || echo "{}")
  
  check "API detail blocks non-allowlisted files" \
    "echo '$BLOCKED_RESPONSE' | jq -e '.error | contains(\"not in allowlist\")'"
  
  check "API detail returns allowed_files hint" \
    "echo '$BLOCKED_RESPONSE' | jq -e '.allowed_files | type == \"array\"'"
  
else
  echo -e "${YELLOW}⚠${NC} UI server not reachable at ${UI_URL}, skipping runtime checks"
  echo "   Start server and re-run to verify runtime behavior"
fi

echo ""

# ==============================================================================
# Section 8: Phase 13 compatibility (must not break)
# ==============================================================================
echo "Section 8: Phase 13 Compatibility"
echo "-------------------------------------------------------------------"

check "Phase 13 anchor policies-state-loading preserved" \
  "grep -q 'id=\"policies-state-loading\"' '$POLICIES_HTML'"

check "Phase 13 anchor policies-state-error preserved" \
  "grep -q 'id=\"policies-state-error\"' '$POLICIES_HTML'"

check "Phase 13 anchor policies-state-ready preserved" \
  "grep -q 'id=\"policies-state-ready\"' '$POLICIES_HTML'"

check "Phase 13 anchor policies-version preserved" \
  "grep -q 'id=\"policies-version\"' '$POLICIES_HTML'"

check "Phase 13 anchor policies-bundle-sha preserved" \
  "grep -q 'id=\"policies-bundle-sha\"' '$POLICIES_HTML'"

check "Phase 13 anchor policies-rules-count preserved" \
  "grep -q 'id=\"policies-rules-count\"' '$POLICIES_HTML'"

check "Phase 13 anchor policies-compile-state preserved" \
  "grep -q 'id=\"policies-compile-state\"' '$POLICIES_HTML'"

check "Phase 13 /api/policies/status route preserved" \
  "grep -q 'app.get.*\"/api/policies/status\"' '$SERVER_JS'"

echo ""

# ==============================================================================
# Summary
# ==============================================================================
echo "═══════════════════════════════════════════════════════════════════"
TOTAL=$((PASSED + FAILED))
echo "GATE_SUMMARY gate=ph14-policies-dealer-view passed=$PASSED failed=$FAILED"
echo ""

if [ "$FAILED" -eq 0 ]; then
  echo -e "${GREEN}✅ GATE PASSED: All $TOTAL checks passed${NC}"
  exit 0
else
  echo -e "${RED}❌ GATE FAILED: $FAILED of $TOTAL checks failed${NC}"
  exit 1
fi
