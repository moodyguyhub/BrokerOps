#!/bin/bash
# Phase 1 Week 2 Acceptance Test: LP Account Snapshots
# 
# Invariants tested:
# 1. LP simulator emits periodic snapshots (at least 10 per LP in 60s)
# 2. Audit-writer materializes snapshots to lp_snapshots table
# 3. LP accounts table is updated with latest values
# 4. order-api can serve LP account data
# 5. Rejections window filter works correctly

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Configuration
AUDIT_WRITER_URL="${AUDIT_WRITER_URL:-http://localhost:7003}"
ORDER_API_URL="${ORDER_API_URL:-http://localhost:7001}"
LP_SIMULATOR_URL="${LP_SIMULATOR_URL:-http://localhost:7010}"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5434}"
POSTGRES_DB="${POSTGRES_DB:-broker}"
POSTGRES_USER="${POSTGRES_USER:-broker}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-broker}"

# Test output
TIMESTAMP=$(date +%Y-%m-%d-%H%M%S)
OUTPUT_DIR="${PROJECT_ROOT}/test-results/ph1-week2-${TIMESTAMP}"
mkdir -p "$OUTPUT_DIR"

RESULTS_FILE="${OUTPUT_DIR}/results.json"
LOG_FILE="${OUTPUT_DIR}/test.log"

# Test state
TESTS_PASSED=0
TESTS_FAILED=0
TEST_RESULTS=()

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

pass() {
    echo -e "${GREEN}✓ PASS${NC}: $1" | tee -a "$LOG_FILE"
    TESTS_PASSED=$((TESTS_PASSED + 1))
    TEST_RESULTS+=("{\"test\": \"$1\", \"status\": \"PASS\", \"message\": \"$2\"}")
}

fail() {
    echo -e "${RED}✗ FAIL${NC}: $1" | tee -a "$LOG_FILE"
    echo "  Error: $2" | tee -a "$LOG_FILE"
    TESTS_FAILED=$((TESTS_FAILED + 1))
    TEST_RESULTS+=("{\"test\": \"$1\", \"status\": \"FAIL\", \"message\": \"$2\"}")
}

warn() {
    echo -e "${YELLOW}⚠ WARN${NC}: $1" | tee -a "$LOG_FILE"
}

# ============================================================================
# Service Health Checks
# ============================================================================

log "=== Phase 1 Week 2 Acceptance Test ==="
log "Output directory: ${OUTPUT_DIR}"
log ""

log "Checking service health..."

# Check audit-writer
if curl -sf "${AUDIT_WRITER_URL}/health" > /dev/null 2>&1; then
    pass "Audit-writer health" "Service responding"
else
    fail "Audit-writer health" "Service not responding at ${AUDIT_WRITER_URL}"
fi

# Check order-api
if curl -sf "${ORDER_API_URL}/health" > /dev/null 2>&1; then
    pass "Order-API health" "Service responding"
else
    fail "Order-API health" "Service not responding at ${ORDER_API_URL}"
fi

# Check lp-simulator
if curl -sf "${LP_SIMULATOR_URL}/health" > /dev/null 2>&1; then
    pass "LP Simulator health" "Service responding"
else
    fail "LP Simulator health" "Service not responding at ${LP_SIMULATOR_URL}"
fi

# ============================================================================
# Test 1: LP Simulator Snapshot Status
# ============================================================================

log ""
log "=== Test 1: LP Simulator Snapshot Status ==="

SNAPSHOT_STATUS=$(curl -sf "${LP_SIMULATOR_URL}/lp-snapshots/status" 2>/dev/null)
if [ -n "$SNAPSHOT_STATUS" ]; then
    SNAPSHOT_ENABLED=$(echo "$SNAPSHOT_STATUS" | jq -r '.enabled')
    SNAPSHOT_RUNNING=$(echo "$SNAPSHOT_STATUS" | jq -r '.running')
    SNAPSHOT_INTERVAL=$(echo "$SNAPSHOT_STATUS" | jq -r '.interval_ms')
    ACCOUNTS_COUNT=$(echo "$SNAPSHOT_STATUS" | jq -r '.accounts_count')
    
    log "  Snapshot enabled: ${SNAPSHOT_ENABLED}"
    log "  Snapshot running: ${SNAPSHOT_RUNNING}"
    log "  Interval: ${SNAPSHOT_INTERVAL}ms"
    log "  Accounts: ${ACCOUNTS_COUNT}"
    
    if [ "$SNAPSHOT_ENABLED" = "true" ] && [ "$SNAPSHOT_RUNNING" = "true" ]; then
        pass "LP Snapshot loop running" "enabled=${SNAPSHOT_ENABLED}, running=${SNAPSHOT_RUNNING}"
    else
        fail "LP Snapshot loop running" "expected enabled=true,running=true but got enabled=${SNAPSHOT_ENABLED},running=${SNAPSHOT_RUNNING}"
    fi
else
    fail "LP Snapshot status" "Could not get snapshot status from simulator"
fi

# ============================================================================
# Test 2: Manual Snapshot Emission
# ============================================================================

log ""
log "=== Test 2: Manual Snapshot Emission ==="

EMIT_RESULT=$(curl -sf -X POST "${LP_SIMULATOR_URL}/lp-snapshots/emit-now" 2>/dev/null)
if [ -n "$EMIT_RESULT" ]; then
    EMIT_SUCCESS=$(echo "$EMIT_RESULT" | jq -r '.success')
    EMIT_COUNT=$(echo "$EMIT_RESULT" | jq -r '.results | length')
    
    if [ "$EMIT_SUCCESS" = "true" ]; then
        pass "Manual snapshot emission" "Emitted ${EMIT_COUNT} snapshots"
    else
        fail "Manual snapshot emission" "success=false"
    fi
else
    fail "Manual snapshot emission" "No response from emit-now endpoint"
fi

# ============================================================================
# Test 3: LP Accounts in Database
# ============================================================================

log ""
log "=== Test 3: LP Accounts in Database ==="

# Query database directly
LP_ACCOUNTS_COUNT=$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -c "SELECT COUNT(*) FROM lp_accounts;" 2>/dev/null | tr -d ' \n')

if [ -n "$LP_ACCOUNTS_COUNT" ] && [ "$LP_ACCOUNTS_COUNT" -ge 3 ]; then
    pass "LP accounts exist" "Found ${LP_ACCOUNTS_COUNT} LP accounts in database"
else
    fail "LP accounts exist" "Expected ≥3 LP accounts, found ${LP_ACCOUNTS_COUNT:-0}"
fi

# Check LP account via order-api
LP_API_RESPONSE=$(curl -sf "${ORDER_API_URL}/api/lp-accounts" 2>/dev/null)
if [ -n "$LP_API_RESPONSE" ]; then
    API_LP_COUNT=$(echo "$LP_API_RESPONSE" | jq -r '.meta.total // .data | length' 2>/dev/null)
    if [ -n "$API_LP_COUNT" ] && [ "$API_LP_COUNT" -ge 3 ]; then
        pass "Order-API LP accounts endpoint" "Returns ${API_LP_COUNT} accounts"
    else
        fail "Order-API LP accounts endpoint" "Expected ≥3 accounts, got ${API_LP_COUNT:-0}"
    fi
else
    fail "Order-API LP accounts endpoint" "No response"
fi

# ============================================================================
# Test 4: LP Snapshots Accumulation (Wait and Verify)
# ============================================================================

log ""
log "=== Test 4: LP Snapshots Accumulation ==="
log "Waiting 60 seconds for snapshot accumulation..."

# Get initial count
INITIAL_SNAPSHOT_COUNT=$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -c "SELECT COUNT(*) FROM lp_snapshots;" 2>/dev/null | tr -d ' \n')
log "  Initial snapshot count: ${INITIAL_SNAPSHOT_COUNT:-0}"

# Wait for accumulation
sleep 60

# Get final count
FINAL_SNAPSHOT_COUNT=$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -c "SELECT COUNT(*) FROM lp_snapshots;" 2>/dev/null | tr -d ' \n')
log "  Final snapshot count: ${FINAL_SNAPSHOT_COUNT:-0}"

NEW_SNAPSHOTS=$((${FINAL_SNAPSHOT_COUNT:-0} - ${INITIAL_SNAPSHOT_COUNT:-0}))
log "  New snapshots in 60s: ${NEW_SNAPSHOTS}"

# With 3 LPs and 5s interval, expect ~36 snapshots (3 * 12)
# We require at least 30 (10 per LP) to pass
if [ "$NEW_SNAPSHOTS" -ge 30 ]; then
    pass "LP snapshot accumulation" "${NEW_SNAPSHOTS} snapshots in 60s (≥30 required)"
else
    fail "LP snapshot accumulation" "${NEW_SNAPSHOTS} snapshots in 60s (<30 required)"
fi

# Check per-LP distribution
LP_B_SNAPSHOTS=$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -c "SELECT COUNT(*) FROM lp_snapshots WHERE lp_id = 'LP-B' AND snapshot_at >= NOW() - INTERVAL '60 seconds';" 2>/dev/null | tr -d ' \n')

if [ "${LP_B_SNAPSHOTS:-0}" -ge 10 ]; then
    pass "LP-B snapshot count" "${LP_B_SNAPSHOTS} snapshots for LP-B in 60s (≥10 required)"
else
    fail "LP-B snapshot count" "${LP_B_SNAPSHOTS:-0} snapshots for LP-B (<10 required)"
fi

# ============================================================================
# Test 5: LP Account History Endpoint
# ============================================================================

log ""
log "=== Test 5: LP Account History via API ==="

LP_B_HISTORY=$(curl -sf "${ORDER_API_URL}/api/lp-accounts/LP-B/history?limit=10" 2>/dev/null)
if [ -n "$LP_B_HISTORY" ]; then
    HISTORY_COUNT=$(echo "$LP_B_HISTORY" | jq -r '.data | length' 2>/dev/null)
    if [ "${HISTORY_COUNT:-0}" -ge 5 ]; then
        pass "LP-B history endpoint" "Returns ${HISTORY_COUNT} history records"
    else
        fail "LP-B history endpoint" "Expected ≥5 history records, got ${HISTORY_COUNT:-0}"
    fi
else
    fail "LP-B history endpoint" "No response"
fi

# ============================================================================
# Test 6: Rejections Time Window Filter
# ============================================================================

log ""
log "=== Test 6: Rejections Time Window Filter ==="

# First, trigger a rejection for fresh data
REJECTION_TRACE_ID="w2-test-reject-$(date +%s)"
curl -sf -X POST "${LP_SIMULATOR_URL}/simulate/rejection" \
  -H "Content-Type: application/json" \
  -d "{
    \"trace_id\": \"${REJECTION_TRACE_ID}\",
    \"order\": {\"symbol\": \"EURUSD\", \"side\": \"BUY\", \"qty\": 100000, \"price\": 1.085},
    \"reason\": {\"code\": \"MARGIN_001\", \"message\": \"Insufficient margin for test\"}
  }" > /dev/null 2>&1

sleep 2

# Test window filter - last 1 hour
REJECTIONS_1H=$(curl -sf "${ORDER_API_URL}/api/rejections?window=1h" 2>/dev/null)
if [ -n "$REJECTIONS_1H" ]; then
    WINDOW_META=$(echo "$REJECTIONS_1H" | jq -r '.meta.window' 2>/dev/null)
    REJ_COUNT=$(echo "$REJECTIONS_1H" | jq -r '.data | length' 2>/dev/null)
    
    if [ "$WINDOW_META" = "1h" ]; then
        pass "Rejections 1h window filter" "Window=${WINDOW_META}, count=${REJ_COUNT}"
    else
        fail "Rejections 1h window filter" "Expected window=1h, got ${WINDOW_META}"
    fi
else
    fail "Rejections 1h window filter" "No response"
fi

# Test window filter - last 30 minutes
REJECTIONS_30M=$(curl -sf "${ORDER_API_URL}/api/rejections?window=30m" 2>/dev/null)
if [ -n "$REJECTIONS_30M" ]; then
    WINDOW_META=$(echo "$REJECTIONS_30M" | jq -r '.meta.window' 2>/dev/null)
    if [ "$WINDOW_META" = "30m" ]; then
        pass "Rejections 30m window filter" "Window=${WINDOW_META}"
    else
        fail "Rejections 30m window filter" "Expected window=30m, got ${WINDOW_META}"
    fi
else
    fail "Rejections 30m window filter" "No response"
fi

# Test rollup with window
REJECTIONS_ROLLUP=$(curl -sf "${ORDER_API_URL}/api/rejections?rollup=reason&window=1h" 2>/dev/null)
if [ -n "$REJECTIONS_ROLLUP" ]; then
    ROLLUP_META=$(echo "$REJECTIONS_ROLLUP" | jq -r '.meta.rollup' 2>/dev/null)
    WINDOW_META=$(echo "$REJECTIONS_ROLLUP" | jq -r '.meta.window' 2>/dev/null)
    
    if [ "$ROLLUP_META" = "reason" ] && [ "$WINDOW_META" = "1h" ]; then
        pass "Rejections rollup with window" "rollup=${ROLLUP_META}, window=${WINDOW_META}"
    else
        fail "Rejections rollup with window" "Expected rollup=reason,window=1h got rollup=${ROLLUP_META},window=${WINDOW_META}"
    fi
else
    fail "Rejections rollup with window" "No response"
fi

# ============================================================================
# Generate Results
# ============================================================================

log ""
log "=== Test Results Summary ==="
log "Passed: ${TESTS_PASSED}"
log "Failed: ${TESTS_FAILED}"

TOTAL_TESTS=$((TESTS_PASSED + TESTS_FAILED))
SUCCESS=$([[ $TESTS_FAILED -eq 0 ]] && echo "true" || echo "false")

# Write JSON results
cat > "$RESULTS_FILE" << EOF
{
  "suite": "PH1-Week2-LP-Snapshots-Acceptance",
  "timestamp": "$(date -Iseconds)",
  "output_dir": "${OUTPUT_DIR}",
  "summary": {
    "total": ${TOTAL_TESTS},
    "passed": ${TESTS_PASSED},
    "failed": ${TESTS_FAILED},
    "success": ${SUCCESS}
  },
  "tests": [
    $(IFS=,; echo "${TEST_RESULTS[*]}")
  ],
  "environment": {
    "audit_writer_url": "${AUDIT_WRITER_URL}",
    "order_api_url": "${ORDER_API_URL}",
    "lp_simulator_url": "${LP_SIMULATOR_URL}",
    "postgres_host": "${POSTGRES_HOST}",
    "postgres_port": "${POSTGRES_PORT}"
  }
}
EOF

# Create symlink to latest results
ln -sf "${OUTPUT_DIR}" "${PROJECT_ROOT}/test-results/ph1-week2-latest"
cp "$RESULTS_FILE" "${PROJECT_ROOT}/test-results/ph1-week2-latest.json"

log ""
log "Results written to: ${RESULTS_FILE}"
log "Symlink: test-results/ph1-week2-latest"

if [ "$SUCCESS" = "true" ]; then
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  PH1 Week 2 Acceptance: ALL TESTS PASSED (${TESTS_PASSED}/${TOTAL_TESTS})  ${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
    exit 0
else
    echo ""
    echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${RED}  PH1 Week 2 Acceptance: ${TESTS_FAILED} TESTS FAILED               ${NC}"
    echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
    exit 1
fi
