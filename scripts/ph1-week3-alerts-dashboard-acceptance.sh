#!/bin/bash
# Phase 1 Week 3 Acceptance Test: Alerts Engine + Dashboard KPIs
# 
# Invariants tested:
# 1. Margin drop scenario → alert created, ack works, cooldown enforced
# 2. Rejection spike → REJECT_SPIKE alert created and visible via GET /api/alerts
# 3. Dashboard KPIs reflect DB truth (counts match orders/rejections within window)
# 4. Alert settings CRUD works
# 5. Alert acknowledgment audit trail

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
OUTPUT_DIR="${PROJECT_ROOT}/test-results/ph1-week3-${TIMESTAMP}"
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

psql_query() {
    PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c "$1" 2>/dev/null
}

# ============================================================================
# Service Health Checks
# ============================================================================

log "=== Phase 1 Week 3 Acceptance Test ==="
log "Output directory: ${OUTPUT_DIR}"
log ""

log "Checking service health..."

# Check services
for svc in "audit-writer:${AUDIT_WRITER_URL}" "order-api:${ORDER_API_URL}" "lp-simulator:${LP_SIMULATOR_URL}"; do
    name="${svc%%:*}"
    url="${svc#*:}"
    if curl -sf "${url}/health" > /dev/null 2>&1; then
        pass "${name} health" "Service responding"
    else
        fail "${name} health" "Service not responding at ${url}"
    fi
done

# ============================================================================
# Test 1: Alert Settings Exist
# ============================================================================

log ""
log "=== Test 1: Alert Settings Exist ==="

SETTINGS_COUNT=$(psql_query "SELECT COUNT(*) FROM alert_settings WHERE enabled = TRUE;")
if [ "${SETTINGS_COUNT:-0}" -ge 4 ]; then
    pass "Alert settings exist" "Found ${SETTINGS_COUNT} enabled alert settings"
else
    fail "Alert settings exist" "Expected ≥4 settings, found ${SETTINGS_COUNT:-0}"
fi

# Check settings via API
SETTINGS_API=$(curl -sf "${ORDER_API_URL}/api/alert-settings" 2>/dev/null)
if [ -n "$SETTINGS_API" ]; then
    API_COUNT=$(echo "$SETTINGS_API" | jq -r '.data | length' 2>/dev/null)
    if [ "${API_COUNT:-0}" -ge 4 ]; then
        pass "Alert settings API" "Returns ${API_COUNT} settings"
    else
        fail "Alert settings API" "Expected ≥4 settings, got ${API_COUNT:-0}"
    fi
else
    fail "Alert settings API" "No response"
fi

# ============================================================================
# Test 2: Margin Drop Scenario → Alert Created
# ============================================================================

log ""
log "=== Test 2: Margin Drop Scenario ==="

# Clear any existing test alerts
psql_query "DELETE FROM alerts WHERE lp_id = 'LP-TEST-MARGIN';" > /dev/null 2>&1
psql_query "DELETE FROM alert_cooldowns WHERE lp_id = 'LP-TEST-MARGIN';" > /dev/null 2>&1

# Ensure test LP account exists
psql_query "INSERT INTO lp_accounts (id, name, server_id, server_name, status, balance, equity, margin, free_margin)
VALUES ('LP-TEST-MARGIN', 'Test LP for Margin Alert', 'srv-test', 'Test Server', 'CONNECTED', 10000, 10000, 5000, 5000)
ON CONFLICT (id) DO NOTHING;" > /dev/null 2>&1

# Simulate low margin snapshot (margin_level = 45%, below CRITICAL threshold of 50%)
LOW_MARGIN_EVENT='{
  "event_id": "test-margin-low-'$(date +%s)'",
  "event_type": "lp.account.snapshot",
  "event_version": 1,
  "source": {"kind": "SIM", "name": "test", "adapter_version": "1.0.0", "server_id": "srv-test", "server_name": "Test Server"},
  "occurred_at": "'$(date -Iseconds)'",
  "payload": {
    "lp_id": "LP-TEST-MARGIN",
    "lp_name": "Test LP for Margin Alert",
    "balance": 10000,
    "equity": 4500,
    "margin": 10000,
    "free_margin": -5500,
    "margin_level": 45.0,
    "currency": "USD",
    "status": "CONNECTED"
  }
}'

EMIT_RESULT=$(curl -sf -X POST "${AUDIT_WRITER_URL}/lp-account-snapshots" \
  -H "Content-Type: application/json" \
  -d "$LOW_MARGIN_EVENT" 2>/dev/null)

if echo "$EMIT_RESULT" | jq -e '.ok == true' > /dev/null 2>&1; then
    pass "Low margin event emitted" "LP snapshot with margin_level=45% sent"
else
    fail "Low margin event emitted" "Failed to emit low margin event"
fi

# Wait for alert processing
sleep 2

# Check if MARGIN_CRITICAL alert was created
MARGIN_ALERT_COUNT=$(psql_query "SELECT COUNT(*) FROM alerts WHERE lp_id = 'LP-TEST-MARGIN' AND setting_id = 'MARGIN_CRITICAL';")
if [ "${MARGIN_ALERT_COUNT:-0}" -ge 1 ]; then
    pass "Margin alert created" "MARGIN_CRITICAL alert triggered for LP-TEST-MARGIN"
else
    fail "Margin alert created" "Expected MARGIN_CRITICAL alert, found ${MARGIN_ALERT_COUNT:-0}"
fi

# Get the alert ID for ack test
MARGIN_ALERT_ID=$(psql_query "SELECT alert_id FROM alerts WHERE lp_id = 'LP-TEST-MARGIN' AND setting_id = 'MARGIN_CRITICAL' ORDER BY id DESC LIMIT 1;")

# ============================================================================
# Test 3: Cooldown Enforcement
# ============================================================================

log ""
log "=== Test 3: Cooldown Enforcement ==="

# Send another low margin event - should NOT create new alert due to cooldown
LOW_MARGIN_EVENT2='{
  "event_id": "test-margin-low2-'$(date +%s)'",
  "event_type": "lp.account.snapshot",
  "event_version": 1,
  "source": {"kind": "SIM", "name": "test", "adapter_version": "1.0.0", "server_id": "srv-test", "server_name": "Test Server"},
  "occurred_at": "'$(date -Iseconds)'",
  "payload": {
    "lp_id": "LP-TEST-MARGIN",
    "lp_name": "Test LP for Margin Alert",
    "balance": 10000,
    "equity": 4000,
    "margin": 10000,
    "free_margin": -6000,
    "margin_level": 40.0,
    "currency": "USD",
    "status": "CONNECTED"
  }
}'

curl -sf -X POST "${AUDIT_WRITER_URL}/lp-account-snapshots" \
  -H "Content-Type: application/json" \
  -d "$LOW_MARGIN_EVENT2" > /dev/null 2>&1

sleep 1

# Check alert count - should still be 1 due to cooldown
MARGIN_ALERT_COUNT2=$(psql_query "SELECT COUNT(*) FROM alerts WHERE lp_id = 'LP-TEST-MARGIN' AND setting_id = 'MARGIN_CRITICAL';")
if [ "${MARGIN_ALERT_COUNT2:-0}" -eq 1 ]; then
    pass "Cooldown enforced" "Second event did not create duplicate alert"
else
    fail "Cooldown enforced" "Expected 1 alert (cooldown), found ${MARGIN_ALERT_COUNT2:-0}"
fi

# ============================================================================
# Test 4: Alert Acknowledgment
# ============================================================================

log ""
log "=== Test 4: Alert Acknowledgment ==="

if [ -n "$MARGIN_ALERT_ID" ]; then
    # Acknowledge the alert
    ACK_RESULT=$(curl -sf -X POST "${ORDER_API_URL}/api/alerts/${MARGIN_ALERT_ID}/ack" \
      -H "Content-Type: application/json" \
      -d '{"action": "ACK", "actor_id": "test-user", "actor_name": "Test User", "comment": "Acknowledged during acceptance test"}' 2>/dev/null)
    
    if echo "$ACK_RESULT" | jq -e '.success == true' > /dev/null 2>&1; then
        pass "Alert acknowledged" "ACK action succeeded"
    else
        fail "Alert acknowledged" "ACK action failed"
    fi
    
    # Check status changed to ACKNOWLEDGED
    ALERT_STATUS=$(psql_query "SELECT status FROM alerts WHERE alert_id = '${MARGIN_ALERT_ID}';")
    if [ "$ALERT_STATUS" = "ACKNOWLEDGED" ]; then
        pass "Alert status updated" "Status changed to ACKNOWLEDGED"
    else
        fail "Alert status updated" "Expected ACKNOWLEDGED, got ${ALERT_STATUS}"
    fi
    
    # Check audit trail
    ACK_RECORD_COUNT=$(psql_query "SELECT COUNT(*) FROM alert_acks WHERE alert_id = '${MARGIN_ALERT_ID}';")
    if [ "${ACK_RECORD_COUNT:-0}" -ge 1 ]; then
        pass "Ack audit trail" "Found ${ACK_RECORD_COUNT} acknowledgment record(s)"
    else
        fail "Ack audit trail" "No acknowledgment records found"
    fi
else
    fail "Alert acknowledgment" "No alert ID available for testing"
    fail "Alert status updated" "Skipped - no alert"
    fail "Ack audit trail" "Skipped - no alert"
fi

# ============================================================================
# Test 5: Rejection Spike → Alert
# ============================================================================

log ""
log "=== Test 5: Rejection Spike Scenario ==="

# Clear cooldowns for rejection alerts
psql_query "DELETE FROM alert_cooldowns WHERE setting_id LIKE 'REJECT%';" > /dev/null 2>&1

# Get initial rejection alert count
INITIAL_REJECT_ALERTS=$(psql_query "SELECT COUNT(*) FROM alerts WHERE category = 'REJECTION';")

# Generate 6 rejections quickly (exceeds REJECT_SPIKE_1MIN threshold of 5)
for i in $(seq 1 6); do
    TRACE_ID="w3-reject-spike-$(date +%s)-${i}"
    curl -sf -X POST "${LP_SIMULATOR_URL}/simulate/rejection" \
      -H "Content-Type: application/json" \
      -d "{
        \"trace_id\": \"${TRACE_ID}\",
        \"order\": {\"symbol\": \"EURUSD\", \"side\": \"BUY\", \"qty\": 100000, \"price\": 1.085},
        \"reason\": {\"code\": \"MARGIN_001\", \"message\": \"Test rejection spike\"}
      }" > /dev/null 2>&1
    sleep 0.1
done

# Wait for alert processing
sleep 3

# Check if rejection spike alert was created
FINAL_REJECT_ALERTS=$(psql_query "SELECT COUNT(*) FROM alerts WHERE category = 'REJECTION';")
NEW_REJECT_ALERTS=$((${FINAL_REJECT_ALERTS:-0} - ${INITIAL_REJECT_ALERTS:-0}))

if [ "$NEW_REJECT_ALERTS" -ge 1 ]; then
    pass "Rejection spike alert" "Created ${NEW_REJECT_ALERTS} rejection alert(s)"
else
    fail "Rejection spike alert" "Expected rejection alert, got ${NEW_REJECT_ALERTS} new alerts"
fi

# Check via API
ALERTS_API=$(curl -sf "${ORDER_API_URL}/api/alerts?category=REJECTION" 2>/dev/null)
if [ -n "$ALERTS_API" ]; then
    API_ALERT_COUNT=$(echo "$ALERTS_API" | jq -r '.data | length' 2>/dev/null)
    if [ "${API_ALERT_COUNT:-0}" -ge 1 ]; then
        pass "Rejection alerts via API" "Found ${API_ALERT_COUNT} rejection alert(s)"
    else
        fail "Rejection alerts via API" "Expected ≥1 alerts, got ${API_ALERT_COUNT:-0}"
    fi
else
    fail "Rejection alerts via API" "No response"
fi

# ============================================================================
# Test 6: Dashboard KPIs
# ============================================================================

log ""
log "=== Test 6: Dashboard KPIs ==="

KPI_RESPONSE=$(curl -sf "${ORDER_API_URL}/api/dashboard/kpis?window=1h" 2>/dev/null)
if [ -n "$KPI_RESPONSE" ]; then
    # Check structure
    HAS_ORDERS=$(echo "$KPI_RESPONSE" | jq -e '.data.orders' 2>/dev/null)
    HAS_REJECTIONS=$(echo "$KPI_RESPONSE" | jq -e '.data.rejections' 2>/dev/null)
    HAS_LP=$(echo "$KPI_RESPONSE" | jq -e '.data.lp_health' 2>/dev/null)
    HAS_ALERTS=$(echo "$KPI_RESPONSE" | jq -e '.data.alerts' 2>/dev/null)
    
    if [ -n "$HAS_ORDERS" ] && [ -n "$HAS_REJECTIONS" ] && [ -n "$HAS_LP" ] && [ -n "$HAS_ALERTS" ]; then
        pass "Dashboard KPI structure" "All sections present (orders, rejections, lp_health, alerts)"
    else
        fail "Dashboard KPI structure" "Missing sections in KPI response"
    fi
    
    # Verify order counts match DB
    KPI_REJECTED=$(echo "$KPI_RESPONSE" | jq -r '.data.orders.rejected' 2>/dev/null)
    DB_REJECTED=$(psql_query "SELECT COUNT(*) FROM orders WHERE status = 'REJECTED' AND created_at >= NOW() - INTERVAL '1 hour';")
    
    if [ "${KPI_REJECTED:-0}" -eq "${DB_REJECTED:-0}" ]; then
        pass "KPI orders match DB" "rejected=${KPI_REJECTED} matches DB"
    else
        fail "KPI orders match DB" "KPI=${KPI_REJECTED}, DB=${DB_REJECTED}"
    fi
    
    # Verify rejection counts
    KPI_REJ_TOTAL=$(echo "$KPI_RESPONSE" | jq -r '.data.rejections.total' 2>/dev/null)
    DB_REJ_TOTAL=$(psql_query "SELECT COUNT(*) FROM rejections WHERE rejected_at >= NOW() - INTERVAL '1 hour';")
    
    if [ "${KPI_REJ_TOTAL:-0}" -eq "${DB_REJ_TOTAL:-0}" ]; then
        pass "KPI rejections match DB" "total=${KPI_REJ_TOTAL} matches DB"
    else
        fail "KPI rejections match DB" "KPI=${KPI_REJ_TOTAL}, DB=${DB_REJ_TOTAL}"
    fi
    
    # Verify open alerts count
    KPI_OPEN_ALERTS=$(echo "$KPI_RESPONSE" | jq -r '.data.alerts.open' 2>/dev/null)
    DB_OPEN_ALERTS=$(psql_query "SELECT COUNT(*) FROM alerts WHERE status = 'OPEN';")
    
    if [ "${KPI_OPEN_ALERTS:-0}" -eq "${DB_OPEN_ALERTS:-0}" ]; then
        pass "KPI alerts match DB" "open=${KPI_OPEN_ALERTS} matches DB"
    else
        fail "KPI alerts match DB" "KPI=${KPI_OPEN_ALERTS}, DB=${DB_OPEN_ALERTS}"
    fi
    
    # Save KPIs to output
    echo "$KPI_RESPONSE" | jq '.' > "${OUTPUT_DIR}/dashboard_kpis.json"
else
    fail "Dashboard KPI structure" "No response from KPI endpoint"
    fail "KPI orders match DB" "Skipped"
    fail "KPI rejections match DB" "Skipped"
    fail "KPI alerts match DB" "Skipped"
fi

# ============================================================================
# Test 7: Dashboard Timeline
# ============================================================================

log ""
log "=== Test 7: Dashboard Timeline ==="

TIMELINE_RESPONSE=$(curl -sf "${ORDER_API_URL}/api/dashboard/timeline?window=1h&bucket=5" 2>/dev/null)
if [ -n "$TIMELINE_RESPONSE" ]; then
    BUCKET_COUNT=$(echo "$TIMELINE_RESPONSE" | jq -r '.data | length' 2>/dev/null)
    if [ "${BUCKET_COUNT:-0}" -ge 0 ]; then
        pass "Dashboard timeline" "Returns ${BUCKET_COUNT} time buckets"
    else
        fail "Dashboard timeline" "Invalid timeline response"
    fi
else
    fail "Dashboard timeline" "No response"
fi

# ============================================================================
# Cleanup Test Data
# ============================================================================

log ""
log "=== Cleanup ==="
psql_query "DELETE FROM alert_acks WHERE alert_id IN (SELECT alert_id FROM alerts WHERE lp_id = 'LP-TEST-MARGIN');" > /dev/null 2>&1
psql_query "DELETE FROM alerts WHERE lp_id = 'LP-TEST-MARGIN';" > /dev/null 2>&1
psql_query "DELETE FROM alert_cooldowns WHERE lp_id = 'LP-TEST-MARGIN';" > /dev/null 2>&1
log "Test data cleaned up"

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
  "suite": "PH1-Week3-Alerts-Dashboard-Acceptance",
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

# Create symlinks
ln -sf "${OUTPUT_DIR}" "${PROJECT_ROOT}/test-results/ph1-week3-latest"
cp "$RESULTS_FILE" "${PROJECT_ROOT}/test-results/ph1-week3-alerts-dashboard.json"

log ""
log "Results written to: ${RESULTS_FILE}"
log "Symlink: test-results/ph1-week3-latest"
log "Evidence: test-results/ph1-week3-alerts-dashboard.json"

if [ "$SUCCESS" = "true" ]; then
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  PH1 Week 3 Acceptance: ALL TESTS PASSED (${TESTS_PASSED}/${TOTAL_TESTS})  ${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
    exit 0
else
    echo ""
    echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${RED}  PH1 Week 3 Acceptance: ${TESTS_FAILED} TESTS FAILED               ${NC}"
    echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
    exit 1
fi
