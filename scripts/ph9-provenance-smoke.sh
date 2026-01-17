#!/usr/bin/env bash
# =============================================================================
# Phase 9 Provenance Endpoint Runtime Smoke Test
# =============================================================================
# Verifies that GET /api/provenance returns valid JSON at runtime.
# This closes the gap between static contract gates (grep-based) and
# actual route precedence/content-type correctness.
#
# Gate 11 verifies: anchors exist in DOM, footer component, single source of truth
# This smoke verifies: endpoint NOT shadowed by wildcard, returns JSON, correct shape
# =============================================================================

set -euo pipefail

# ===========================================================================
# Configuration
# ===========================================================================
PORT="${PORT:-3999}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-15}"
RESULT_DIR="${PROJECT_ROOT}/test-results"
LOG_FILE="/tmp/ui-provenance-smoke.log"
RESPONSE_FILE="/tmp/provenance-response.json"

# ===========================================================================
# Terminal output helpers
# ===========================================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

passed=0
failed=0

pass() {
  echo -e "${GREEN}✓${NC} $1"
  ((passed++)) || true
}

fail() {
  echo -e "${RED}✗${NC} $1"
  ((failed++)) || true
}

info() {
  echo -e "${CYAN}ℹ${NC} $1"
}

warn() {
  echo -e "${YELLOW}⚠${NC} $1"
}

# ===========================================================================
# Cleanup handler
# ===========================================================================
UI_PID=""

cleanup() {
  if [[ -n "${UI_PID:-}" ]]; then
    kill "$UI_PID" >/dev/null 2>&1 || true
    wait "$UI_PID" 2>/dev/null || true
  fi
  # Kill any process still on the port (may not have fuser available)
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

# ===========================================================================
# Main
# ===========================================================================
echo "============================================================"
echo "Phase 9: Provenance Endpoint Runtime Smoke Test"
echo "============================================================"
echo ""

# Check if port is already in use
port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -i:"${PORT}" >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn | grep -q ":${PORT} "
  else
    # Fall back to curl check
    curl -sf "http://localhost:${PORT}/health" >/dev/null 2>&1
  fi
}

if port_in_use; then
  warn "Port ${PORT} is already in use, attempting to free it..."
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
  fi
  sleep 1
fi

# Start UI server on isolated port
info "Starting UI server on port ${PORT}..."
cd "$PROJECT_ROOT"
PORT="${PORT}" node services/ui/server.js > "$LOG_FILE" 2>&1 &
UI_PID="$!"

# Wait for server to be healthy
info "Waiting for UI server to become healthy..."
healthy=false
i=0
max_attempts=$((TIMEOUT_SECONDS * 5))
while [[ $i -lt $max_attempts ]]; do
  if curl -sf "http://localhost:${PORT}/health" >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 0.2
  i=$((i + 1))
done

if [[ "$healthy" != "true" ]]; then
  fail "UI server failed to start within ${TIMEOUT_SECONDS}s"
  echo "--- Server log ---"
  cat "$LOG_FILE" || true
  exit 1
fi

pass "UI server healthy on port ${PORT}"

# ===========================================================================
# Test 1: Endpoint returns 200 OK
# ===========================================================================
echo ""
echo "--- Test 1: HTTP Status Code ---"

http_code=$(curl -m 10 -s -o "$RESPONSE_FILE" -w "%{http_code}" "http://localhost:${PORT}/api/provenance" 2>/dev/null || echo "000")

if [[ "$http_code" == "200" ]]; then
  pass "HTTP status code is 200"
else
  fail "HTTP status code is ${http_code} (expected 200)"
fi

# ===========================================================================
# Test 2: Content-Type is application/json
# ===========================================================================
echo ""
echo "--- Test 2: Content-Type Header ---"

content_type=$(curl -m 10 -sI "http://localhost:${PORT}/api/provenance" 2>/dev/null | grep -i "content-type" | tr -d '\r\n' || echo "")

if echo "$content_type" | grep -qi "application/json"; then
  pass "Content-Type is application/json"
else
  fail "Content-Type is not application/json: ${content_type}"
fi

# ===========================================================================
# Test 3: Response is valid JSON
# ===========================================================================
echo ""
echo "--- Test 3: Valid JSON ---"

if jq -e '.' "$RESPONSE_FILE" >/dev/null 2>&1; then
  pass "Response is valid JSON"
else
  fail "Response is not valid JSON"
  echo "Raw response:"
  head -20 "$RESPONSE_FILE"
fi

# ===========================================================================
# Test 4: JSON has required keys (kernel, ui, ts aliased as buildTs)
# ===========================================================================
echo ""
echo "--- Test 4: Required JSON Keys ---"

# Check for kernel key
if jq -e '.kernel' "$RESPONSE_FILE" >/dev/null 2>&1; then
  pass "JSON has 'kernel' key"
else
  fail "JSON missing 'kernel' key"
fi

# Check for ui key
if jq -e '.ui' "$RESPONSE_FILE" >/dev/null 2>&1; then
  pass "JSON has 'ui' key"
else
  fail "JSON missing 'ui' key"
fi

# Check for buildTs key (this is 'ts' in the schema)
if jq -e '.buildTs' "$RESPONSE_FILE" >/dev/null 2>&1; then
  pass "JSON has 'buildTs' key"
else
  fail "JSON missing 'buildTs' key"
fi

# ===========================================================================
# Test 5: Values are not empty/null
# ===========================================================================
echo ""
echo "--- Test 5: Non-Empty Values ---"

kernel_val=$(jq -r '.kernel // empty' "$RESPONSE_FILE")
ui_val=$(jq -r '.ui // empty' "$RESPONSE_FILE")
ts_val=$(jq -r '.buildTs // empty' "$RESPONSE_FILE")

if [[ -n "$kernel_val" ]]; then
  pass "kernel value is non-empty: ${kernel_val}"
else
  fail "kernel value is empty"
fi

if [[ -n "$ui_val" ]]; then
  pass "ui value is non-empty: ${ui_val}"
else
  fail "ui value is empty"
fi

if [[ -n "$ts_val" ]]; then
  pass "buildTs value is non-empty: ${ts_val}"
else
  fail "buildTs value is empty"
fi

# ===========================================================================
# Test 6: Endpoint is NOT returning HTML (wildcard check)
# ===========================================================================
echo ""
echo "--- Test 6: Not HTML (Route Precedence) ---"

first_char=$(head -c 1 "$RESPONSE_FILE")
if [[ "$first_char" == "{" ]]; then
  pass "Response starts with '{' (not HTML)"
else
  fail "Response starts with '${first_char}' (might be HTML)"
fi

if ! grep -qi "<!DOCTYPE" "$RESPONSE_FILE" 2>/dev/null; then
  pass "Response does not contain DOCTYPE"
else
  fail "Response contains DOCTYPE (HTML fallback)"
fi

if ! grep -qi "<html" "$RESPONSE_FILE" 2>/dev/null; then
  pass "Response does not contain <html>"
else
  fail "Response contains <html> (HTML fallback)"
fi

# ===========================================================================
# Summary
# ===========================================================================
echo ""
echo "============================================================"
echo "SUMMARY: Phase 9 Provenance Smoke Test"
echo "============================================================"
total=$((passed + failed))
echo ""
echo "PASSED: ${passed}/${total}"
echo "FAILED: ${failed}/${total}"

# Save result for CI
mkdir -p "$RESULT_DIR"
result_file="${RESULT_DIR}/ph9-provenance-smoke.json"
cat > "$result_file" <<EOF
{
  "test": "ph9-provenance-smoke",
  "timestamp": "$(date -Iseconds)",
  "port": ${PORT},
  "passed": ${passed},
  "failed": ${failed},
  "total": ${total},
  "status": "$(if [[ $failed -eq 0 ]]; then echo "PASS"; else echo "FAIL"; fi)",
  "provenance": $(cat "$RESPONSE_FILE" 2>/dev/null || echo '{}')
}
EOF

echo ""
if [[ $failed -eq 0 ]]; then
  echo -e "${GREEN}SMOKE_OK${NC} provenance_json_keys=kernel,ui,buildTs port=${PORT}"
  echo ""
  exit 0
else
  echo -e "${RED}SMOKE_FAIL${NC} ${failed} checks failed"
  echo ""
  exit 1
fi
