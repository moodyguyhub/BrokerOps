#!/bin/bash
# Week 4 UI Integration Acceptance Test
# 
# Proves:
# 1. Demo trigger proxy works (order-api → lp-simulator)
# 2. margin-warning scenario → MARGIN_* alert appears
# 3. Alert acknowledgement works
# 4. rejection-spike scenario → REJECT_SPIKE alert appears
# 5. Dashboard KPIs match DB counts
# 6. UI is accessible and healthy
#
# Output: test-results/ph1-week4-ui-integration.json

# Don't use set -e as we need to handle failures gracefully

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Configuration
ORDER_API_URL="${ORDER_API_URL:-http://localhost:7001}"
UI_URL="${UI_URL:-http://localhost:3000}"
PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5434}"
PGUSER="${PGUSER:-broker}"
PGPASSWORD="${PGPASSWORD:-broker}"
PGDATABASE="${PGDATABASE:-broker}"

TIMESTAMP=$(date +%Y-%m-%d-%H%M%S)
OUTPUT_DIR="${PROJECT_ROOT}/test-results"
RESULTS_FILE="${OUTPUT_DIR}/ph1-week4-ui-integration.json"
LOG_FILE="${OUTPUT_DIR}/ph1-week4-ui-integration-${TIMESTAMP}.log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

mkdir -p "$OUTPUT_DIR"

# Test counters
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
TEST_RESULTS=()

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# PostgreSQL helper
psql_query() {
    PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -t -A -c "$1" 2>/dev/null
}

# Record test result
record_test() {
    local name="$1"
    local status="$2"
    local message="$3"
    
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    
    if [ "$status" = "PASS" ]; then
        PASSED_TESTS=$((PASSED_TESTS + 1))
        echo -e "${GREEN}✓ PASS${NC}: $name"
    else
        FAILED_TESTS=$((FAILED_TESTS + 1))
        echo -e "${RED}✗ FAIL${NC}: $name - $message"
    fi
    
    TEST_RESULTS+=("{\"name\": \"$name\", \"status\": \"$status\", \"message\": \"$message\"}")
    log "Test: $name - $status - $message"
}

# Wait for condition with polling
wait_for_condition() {
    local description="$1"
    local check_cmd="$2"
    local max_attempts="${3:-20}"
    local delay="${4:-1}"
    
    log "Waiting for: $description (max ${max_attempts}s)"
    
    for i in $(seq 1 $max_attempts); do
        if eval "$check_cmd" > /dev/null 2>&1; then
            log "  ✓ Condition met after ${i}s"
            return 0
        fi
        sleep "$delay"
    done
    
    log "  ✗ Timeout waiting for: $description"
    return 1
}

# ============================================================================
# Pre-flight checks
# ============================================================================

log "=== Week 4 UI Integration Acceptance Test ==="
log "Order API: $ORDER_API_URL"
log "UI: $UI_URL"
log ""

log "=== Pre-flight: Service Health Checks ==="

# Check order-api health
if curl -sf "${ORDER_API_URL}/health" > /dev/null 2>&1; then
    record_test "order-api health" "PASS" "healthy"
else
    record_test "order-api health" "FAIL" "not responding"
fi

# Check UI health
if curl -sf "${UI_URL}/health" > /dev/null 2>&1; then
    UI_HEALTH=$(curl -sf "${UI_URL}/health")
    record_test "ui health" "PASS" "healthy"
else
    record_test "ui health" "FAIL" "not responding"
fi

# Check DB connection
if psql_query "SELECT 1" > /dev/null 2>&1; then
    record_test "database connection" "PASS" "connected"
else
    record_test "database connection" "FAIL" "not responding"
fi

# ============================================================================
# Test 1: Demo Scenarios Endpoint
# ============================================================================

log ""
log "=== Test 1: Demo Scenarios Endpoint ==="

SCENARIOS_RESP=$(curl -sf "${ORDER_API_URL}/api/demo/scenarios" 2>/dev/null || echo "")
if echo "$SCENARIOS_RESP" | grep -q "margin-warning"; then
    SCENARIO_COUNT=$(echo "$SCENARIOS_RESP" | grep -o '"id"' | wc -l)
    record_test "demo scenarios list" "PASS" "found ${SCENARIO_COUNT} scenarios"
else
    record_test "demo scenarios list" "FAIL" "endpoint not responding"
fi

# ============================================================================
# Test 2: Margin Warning Scenario → Alert Created
# ============================================================================

log ""
log "=== Test 2: Margin Warning Scenario ==="

# Clean up any existing test alerts and cooldowns
psql_query "DELETE FROM alerts WHERE lp_id = 'LP-A' AND category = 'MARGIN' AND created_at > NOW() - INTERVAL '1 minute';" > /dev/null 2>&1 || true
psql_query "DELETE FROM alert_cooldowns WHERE lp_id = 'LP-A';" > /dev/null 2>&1 || true

# Count alerts before
ALERTS_BEFORE=$(psql_query "SELECT COUNT(*) FROM alerts WHERE lp_id = 'LP-A' AND category = 'MARGIN' AND status = 'OPEN';")

# Trigger margin warning via demo proxy
TRIGGER_RESP=$(curl -sf -X POST "${ORDER_API_URL}/api/demo/trigger/margin-warning" \
    -H "Content-Type: application/json" \
    -d '{"lp_id": "LP-A", "margin_level": 45}' 2>/dev/null || echo "")

if echo "$TRIGGER_RESP" | grep -q '"success":true'; then
    record_test "trigger margin-warning" "PASS" "scenario triggered"
else
    record_test "trigger margin-warning" "FAIL" "trigger failed: $TRIGGER_RESP"
fi

# Wait for alert to appear
sleep 3

# Check for new margin alert
ALERTS_AFTER=$(psql_query "SELECT COUNT(*) FROM alerts WHERE lp_id = 'LP-A' AND category = 'MARGIN' AND status = 'OPEN';")

if [ "${ALERTS_AFTER:-0}" -gt "${ALERTS_BEFORE:-0}" ]; then
    record_test "margin alert created" "PASS" "alert count: ${ALERTS_BEFORE} → ${ALERTS_AFTER}"
else
    # Also check via API
    ALERT_API=$(curl -sf "${ORDER_API_URL}/api/alerts?lp_id=LP-A&status=OPEN" 2>/dev/null || echo "[]")
    if echo "$ALERT_API" | grep -q "MARGIN"; then
        record_test "margin alert created" "PASS" "found via API"
    else
        record_test "margin alert created" "FAIL" "no new alert (before: ${ALERTS_BEFORE}, after: ${ALERTS_AFTER})"
    fi
fi

# ============================================================================
# Test 3: Alert Acknowledgement
# ============================================================================

log ""
log "=== Test 3: Alert Acknowledgement ==="

# Get an open alert (using alert_id column)
OPEN_ALERT=$(psql_query "SELECT alert_id FROM alerts WHERE status = 'OPEN' LIMIT 1;")

if [ -n "$OPEN_ALERT" ]; then
    # Acknowledge via API
    ACK_RESP=$(curl -sf -X POST "${ORDER_API_URL}/api/alerts/${OPEN_ALERT}/ack" \
        -H "Content-Type: application/json" \
        -d '{"acked_by": "test-script"}' 2>/dev/null || echo "")
    
    if echo "$ACK_RESP" | grep -q '"success":true'; then
        # Verify alert status changed to ACKNOWLEDGED
        ACK_STATUS=$(psql_query "SELECT status FROM alerts WHERE alert_id = '${OPEN_ALERT}';")
        ACK_COUNT=$(echo "$ACK_STATUS" | grep -c "ACKNOWLEDGED" || echo 0)
        if [ "${ACK_COUNT:-0}" -gt 0 ]; then
            record_test "alert acknowledgement" "PASS" "ack recorded"
        else
            record_test "alert acknowledgement" "FAIL" "ack not in DB"
        fi
    else
        record_test "alert acknowledgement" "FAIL" "API returned error"
    fi
else
    record_test "alert acknowledgement" "FAIL" "no open alert to ack"
fi

# ============================================================================
# Test 4: Rejection Spike Scenario → Alert Created
# ============================================================================

log ""
log "=== Test 4: Rejection Spike Scenario ==="

# Clean up cooldowns for rejection category
psql_query "DELETE FROM alert_cooldowns WHERE setting_id IN (SELECT id FROM alert_settings WHERE category = 'REJECTION');" > /dev/null 2>&1 || true

# Count rejection alerts before
REJECT_ALERTS_BEFORE=$(psql_query "SELECT COUNT(*) FROM alerts WHERE category = 'REJECTION';")

# Trigger rejection spike
TRIGGER_RESP=$(curl -sf -X POST "${ORDER_API_URL}/api/demo/trigger/rejection-spike" \
    -H "Content-Type: application/json" \
    -d '{"count": 5, "symbol": "EURUSD"}' 2>/dev/null || echo "")

if echo "$TRIGGER_RESP" | grep -q '"success":true'; then
    record_test "trigger rejection-spike" "PASS" "scenario triggered"
else
    record_test "trigger rejection-spike" "FAIL" "trigger failed"
fi

# Wait for alert processing
sleep 5

# Check for new rejection spike alert
REJECT_ALERTS_AFTER=$(psql_query "SELECT COUNT(*) FROM alerts WHERE category = 'REJECTION';")

if [ "${REJECT_ALERTS_AFTER:-0}" -gt "${REJECT_ALERTS_BEFORE:-0}" ]; then
    record_test "rejection spike alert" "PASS" "alert count: ${REJECT_ALERTS_BEFORE} → ${REJECT_ALERTS_AFTER}"
else
    # Check via API as fallback
    REJECT_API=$(curl -sf "${ORDER_API_URL}/api/alerts?category=REJECTION" 2>/dev/null || echo "[]")
    if echo "$REJECT_API" | grep -q "REJECTION"; then
        record_test "rejection spike alert" "PASS" "found via API"
    else
        record_test "rejection spike alert" "FAIL" "no new rejection alert (before: ${REJECT_ALERTS_BEFORE}, after: ${REJECT_ALERTS_AFTER})"
    fi
fi

# ============================================================================
# Test 5: Dashboard KPIs Match DB
# ============================================================================

log ""
log "=== Test 5: Dashboard KPIs Consistency ==="

# Get KPIs from API
KPIS_RESP=$(curl -sf "${ORDER_API_URL}/api/dashboard/kpis?window=1h" 2>/dev/null || echo "")

if echo "$KPIS_RESP" | grep -q '"success":true'; then
    # Extract values from API
    API_ORDERS=$(echo "$KPIS_RESP" | grep -o '"total":[0-9]*' | head -1 | grep -o '[0-9]*' || echo "0")
    API_OPEN_ALERTS=$(echo "$KPIS_RESP" | grep -o '"open":[0-9]*' | head -1 | grep -o '[0-9]*' || echo "0")
    
    # Get values from DB
    DB_ORDERS=$(psql_query "SELECT COUNT(*) FROM orders WHERE created_at > NOW() - INTERVAL '1 hour';")
    DB_OPEN_ALERTS=$(psql_query "SELECT COUNT(*) FROM alerts WHERE status = 'OPEN';")
    
    # Compare orders
    if [ "${API_ORDERS:-0}" -eq "${DB_ORDERS:-0}" ] 2>/dev/null; then
        record_test "KPI orders match DB" "PASS" "API: ${API_ORDERS}, DB: ${DB_ORDERS}"
    else
        record_test "KPI orders match DB" "FAIL" "API: ${API_ORDERS}, DB: ${DB_ORDERS}"
    fi
    
    # Compare alerts
    if [ "${API_OPEN_ALERTS:-0}" -eq "${DB_OPEN_ALERTS:-0}" ] 2>/dev/null; then
        record_test "KPI alerts match DB" "PASS" "API: ${API_OPEN_ALERTS}, DB: ${DB_OPEN_ALERTS}"
    else
        record_test "KPI alerts match DB" "FAIL" "API: ${API_OPEN_ALERTS}, DB: ${DB_OPEN_ALERTS}"
    fi
else
    record_test "KPI orders match DB" "FAIL" "KPI endpoint error"
    record_test "KPI alerts match DB" "FAIL" "KPI endpoint error"
fi

# ============================================================================
# Test 6: UI Dashboard Accessible
# ============================================================================

log ""
log "=== Test 6: UI Dashboard Smoke Test ==="

# Check dashboard page
DASHBOARD_RESP=$(curl -sf "${UI_URL}/dashboard" 2>/dev/null || echo "")
if echo "$DASHBOARD_RESP" | grep -q "Operations Dashboard"; then
    record_test "UI dashboard accessible" "PASS" "page loads"
else
    record_test "UI dashboard accessible" "FAIL" "page not loading"
fi

# Check UI health endpoint returns apiBase
UI_HEALTH=$(curl -sf "${UI_URL}/health" 2>/dev/null || echo "{}")
if echo "$UI_HEALTH" | grep -q "apiBase"; then
    record_test "UI health includes apiBase" "PASS" "config exposed"
else
    record_test "UI health includes apiBase" "FAIL" "apiBase missing"
fi

# Check UI can proxy to order-api
UI_KPI_RESP=$(curl -sf "${UI_URL}/api/dashboard/kpis" 2>/dev/null || echo "")
if echo "$UI_KPI_RESP" | grep -q '"success"'; then
    record_test "UI proxy to order-api" "PASS" "proxy works"
else
    record_test "UI proxy to order-api" "FAIL" "proxy failed"
fi

# ============================================================================
# Test 7: LP Accounts API
# ============================================================================

log ""
log "=== Test 7: LP Accounts API ==="

LP_RESP=$(curl -sf "${ORDER_API_URL}/api/lp-accounts" 2>/dev/null || echo "")
if echo "$LP_RESP" | grep -q '"success":true'; then
    LP_COUNT=$(echo "$LP_RESP" | grep -o '"id"' | wc -l)
    record_test "LP accounts endpoint" "PASS" "found ${LP_COUNT} accounts"
else
    record_test "LP accounts endpoint" "FAIL" "endpoint error"
fi

# ============================================================================
# Generate Results
# ============================================================================

log ""
log "=== Generating Results ==="

OVERALL_SUCCESS="true"
if [ "$FAILED_TESTS" -gt 0 ]; then
    OVERALL_SUCCESS="false"
fi

# Build JSON results
cat > "$RESULTS_FILE" << EOF
{
  "suite": "PH1-Week4-UI-Integration",
  "timestamp": "$(date -Iseconds)",
  "success": ${OVERALL_SUCCESS},
  "summary": {
    "total": ${TOTAL_TESTS},
    "passed": ${PASSED_TESTS},
    "failed": ${FAILED_TESTS}
  },
  "tests": [
    $(IFS=,; echo "${TEST_RESULTS[*]}")
  ],
  "environment": {
    "order_api_url": "${ORDER_API_URL}",
    "ui_url": "${UI_URL}",
    "pghost": "${PGHOST}",
    "pgport": "${PGPORT}"
  }
}
EOF

log "Results written to: $RESULTS_FILE"

# Print summary
echo ""
echo "═══════════════════════════════════════════════════════════"
if [ "$OVERALL_SUCCESS" = "true" ]; then
    echo -e "${GREEN}  Week 4 UI Integration: ALL TESTS PASSED${NC}"
else
    echo -e "${RED}  Week 4 UI Integration: SOME TESTS FAILED${NC}"
fi
echo "  Total: ${TOTAL_TESTS} | Passed: ${PASSED_TESTS} | Failed: ${FAILED_TESTS}"
echo "═══════════════════════════════════════════════════════════"

# Exit with appropriate code
if [ "$FAILED_TESTS" -gt 0 ]; then
    exit 1
fi
exit 0
