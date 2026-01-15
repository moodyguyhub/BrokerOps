#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# P2 Acceptance Test Suite - Audit-Proof Execution
# 
# This script produces a timestamped log file suitable for CI/audit archives.
# Run: ./scripts/p2-acceptance-test.sh
# Output: test-results/p2-acceptance-YYYY-MM-DD-HHMMSS.log
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

# Create output directory
mkdir -p test-results

TIMESTAMP=$(date +%Y-%m-%d-%H%M%S)
LOG_FILE="test-results/p2-acceptance-${TIMESTAMP}.log"
SUMMARY_FILE="test-results/p2-acceptance-latest.json"

# Logging helpers
log() { echo "[$(iso_timestamp)] $1" | tee -a "$LOG_FILE"; }
pass() { echo "[$(iso_timestamp)] ✓ PASS: $1" | tee -a "$LOG_FILE"; }
fail() { echo "[$(iso_timestamp)] ✗ FAIL: $1" | tee -a "$LOG_FILE"; }

# UUID generation helper (works on Linux without uuidgen)
generate_uuid() {
  if command -v uuidgen &> /dev/null; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  elif [ -f /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  else
    # Fallback: generate pseudo-UUID
    printf '%04x%04x-%04x-%04x-%04x-%04x%04x%04x\n' \
      $RANDOM $RANDOM $RANDOM \
      $(($RANDOM & 0x0fff | 0x4000)) \
      $(($RANDOM & 0x3fff | 0x8000)) \
      $RANDOM $RANDOM $RANDOM
  fi
}

# ISO timestamp helper (Zod expects .000Z format)
iso_timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%S.000Z"
}

# Test counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

record_result() {
  local name=$1
  local status=$2
  local details=$3
  TESTS_RUN=$((TESTS_RUN + 1))
  if [ "$status" = "pass" ]; then
    TESTS_PASSED=$((TESTS_PASSED + 1))
    pass "$name"
  else
    TESTS_FAILED=$((TESTS_FAILED + 1))
    fail "$name: $details"
  fi
}

# =============================================================================
log "P2 Acceptance Test Suite Started"
log "Git commit: $(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
log "Timestamp: $TIMESTAMP"
log "============================================================================="

# Prerequisites check
log "Checking prerequisites..."

if ! curl -sf http://localhost:7006/health > /dev/null 2>&1; then
  log "ERROR: Webhooks service not running on :7006"
  log "Run: node services/webhooks/dist/index.js &"
  exit 1
fi

if ! curl -sf http://localhost:7001/health > /dev/null 2>&1; then
  log "ERROR: Order API not running on :7001"
  exit 1
fi

if ! curl -sf http://localhost:7004/health > /dev/null 2>&1; then
  log "ERROR: Reconstruction API not running on :7004"
  exit 1
fi

log "All services healthy"

# =============================================================================
# Test 1: Idempotency Replay
# =============================================================================
log ""
log "TEST 1: Idempotency Replay"
log "Expected: First request returns 200, subsequent return 409"

TEST_EXEC_ID="p2-test-$(date +%s)-001"
EXEC_EVENT="{
  \"event_type\": \"execution.reported\",
  \"event_id\": \"$(generate_uuid)\",
  \"event_timestamp\": \"$(iso_timestamp)\",
  \"idempotency_key\": \"exec:${TEST_EXEC_ID}\",
  \"decision_token\": \"test-idempotency-token\",
  \"client_order_id\": \"test-order-001\",
  \"exec_id\": \"${TEST_EXEC_ID}\",
  \"symbol\": \"AAPL\",
  \"side\": \"BUY\",
  \"fill_qty\": 100,
  \"fill_price\": 150.00,
  \"fill_currency\": \"USD\",
  \"fill_timestamp\": \"$(iso_timestamp)\",
  \"realized_notional\": 15000,
  \"source\": \"PLATFORM\",
  \"source_timestamp\": \"$(iso_timestamp)\"
}"

CODES=""
for i in 1 2 3 4 5; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:7006/events/execution \
    -H "Content-Type: application/json" \
    -d "$EXEC_EVENT")
  CODES="$CODES$CODE "
  log "  Request $i: HTTP $CODE"
done

# Expected: 200 409 409 409 409
FIRST_CODE=$(echo $CODES | cut -d' ' -f1)
DUPE_CODES=$(echo $CODES | cut -d' ' -f2-5)

if [ "$FIRST_CODE" = "200" ] && [ "$DUPE_CODES" = "409 409 409 409" ]; then
  record_result "Idempotency Replay" "pass" ""
else
  record_result "Idempotency Replay" "fail" "Got: $CODES"
fi

# =============================================================================
# Test 2: Payload Mismatch Detection
# =============================================================================
log ""
log "TEST 2: Payload Mismatch Detection"
log "Expected: Same exec_id with different price returns payload_mismatch=true"

MISMATCH_EVENT="{
  \"event_type\": \"execution.reported\",
  \"event_id\": \"$(generate_uuid)\",
  \"event_timestamp\": \"$(iso_timestamp)\",
  \"idempotency_key\": \"exec:${TEST_EXEC_ID}\",
  \"decision_token\": \"test-idempotency-token\",
  \"client_order_id\": \"test-order-001\",
  \"exec_id\": \"${TEST_EXEC_ID}\",
  \"symbol\": \"AAPL\",
  \"side\": \"BUY\",
  \"fill_qty\": 100,
  \"fill_price\": 155.00,
  \"fill_currency\": \"USD\",
  \"fill_timestamp\": \"$(iso_timestamp)\",
  \"realized_notional\": 15500,
  \"source\": \"PLATFORM\",
  \"source_timestamp\": \"$(iso_timestamp)\"
}"

MISMATCH_RESP=$(curl -s -X POST http://localhost:7006/events/execution \
  -H "Content-Type: application/json" \
  -d "$MISMATCH_EVENT")

MISMATCH_FLAG=$(echo "$MISMATCH_RESP" | jq -r '.payload_mismatch // false')
log "  payload_mismatch: $MISMATCH_FLAG"

if [ "$MISMATCH_FLAG" = "true" ]; then
  record_result "Payload Mismatch Detection" "pass" ""
else
  record_result "Payload Mismatch Detection" "fail" "payload_mismatch=$MISMATCH_FLAG"
fi

# =============================================================================
# Test 3: Full Lifecycle Flow
# =============================================================================
log ""
log "TEST 3: Full Lifecycle Flow (Order → Execution → Close)"

# Create order
ORDER_RESP=$(curl -s -X POST http://localhost:7001/orders \
  -H "Content-Type: application/json" \
  -d "{\"clientOrderId\": \"p2-lifecycle-$(date +%s)\", \"symbol\": \"AAPL\", \"qty\": 50, \"side\": \"BUY\", \"price\": 150.00}")

TRACE_ID=$(echo "$ORDER_RESP" | jq -r '.traceId')
ORDER_STATUS=$(echo "$ORDER_RESP" | jq -r '.status')
log "  Order created: traceId=$TRACE_ID status=$ORDER_STATUS"

if [ "$ORDER_STATUS" != "AUTHORIZED" ]; then
  record_result "Lifecycle: Order Creation" "fail" "status=$ORDER_STATUS"
else
  record_result "Lifecycle: Order Creation" "pass" ""
fi

# Post execution
LIFECYCLE_EXEC_ID="fill-lifecycle-$(date +%s)"
EXEC_RESP=$(curl -s -X POST http://localhost:7006/events/execution \
  -H "Content-Type: application/json" \
  -d "{
    \"event_type\": \"execution.reported\",
    \"event_id\": \"$(generate_uuid)\",
    \"event_timestamp\": \"$(iso_timestamp)\",
    \"idempotency_key\": \"exec:${LIFECYCLE_EXEC_ID}\",
    \"decision_token\": \"$TRACE_ID\",
    \"client_order_id\": \"p2-lifecycle-test\",
    \"exec_id\": \"${LIFECYCLE_EXEC_ID}\",
    \"symbol\": \"AAPL\",
    \"side\": \"BUY\",
    \"fill_qty\": 50,
    \"fill_price\": 150.50,
    \"fill_currency\": \"USD\",
    \"fill_timestamp\": \"$(iso_timestamp)\",
    \"realized_notional\": 7525,
    \"source\": \"PLATFORM\",
    \"source_timestamp\": \"$(iso_timestamp)\"
  }")

EXEC_STATUS=$(echo "$EXEC_RESP" | jq -r '.status')
log "  Execution posted: status=$EXEC_STATUS"

if [ "$EXEC_STATUS" = "accepted" ]; then
  record_result "Lifecycle: Execution Ingestion" "pass" ""
else
  record_result "Lifecycle: Execution Ingestion" "fail" "status=$EXEC_STATUS"
fi

# Post position close
CLOSE_ID="close-lifecycle-$(date +%s)"
CLOSE_RESP=$(curl -s -X POST http://localhost:7006/events/position-closed \
  -H "Content-Type: application/json" \
  -d "{
    \"event_type\": \"position.closed\",
    \"event_id\": \"$(generate_uuid)\",
    \"event_timestamp\": \"$(iso_timestamp)\",
    \"idempotency_key\": \"close:${CLOSE_ID}\",
    \"decision_token\": \"$TRACE_ID\",
    \"close_id\": \"${CLOSE_ID}\",
    \"symbol\": \"AAPL\",
    \"entry_price\": 150.50,
    \"exit_price\": 155.00,
    \"qty\": 50,
    \"side\": \"BUY\",
    \"realized_pnl\": 225,
    \"realized_pnl_currency\": \"USD\",
    \"pnl_source\": \"PLATFORM\",
    \"entry_timestamp\": \"$(iso_timestamp)\",
    \"exit_timestamp\": \"$(iso_timestamp)\"
  }")

CLOSE_STATUS=$(echo "$CLOSE_RESP" | jq -r '.status')
CLOSE_PNL=$(echo "$CLOSE_RESP" | jq -r '.realized_pnl')
log "  Position closed: status=$CLOSE_STATUS pnl=$CLOSE_PNL"

if [ "$CLOSE_STATUS" = "accepted" ] && [ "$CLOSE_PNL" = "225" ]; then
  record_result "Lifecycle: Position Close" "pass" ""
else
  record_result "Lifecycle: Position Close" "fail" "status=$CLOSE_STATUS pnl=$CLOSE_PNL"
fi

# =============================================================================
# Test 4: Evidence Pack Realized Economics
# =============================================================================
log ""
log "TEST 4: Evidence Pack Realized Economics"

sleep 1  # Allow propagation

EVIDENCE=$(curl -s "http://localhost:7004/trace/$TRACE_ID/evidence-pack")
ECON_HASH=$(echo "$EVIDENCE" | jq -r '.manifest.componentHashes.economics // "null"')
REALIZED_STATUS=$(echo "$EVIDENCE" | jq -r '.components.economics.realized.pnl_status // "null"')
REALIZED_PNL=$(echo "$EVIDENCE" | jq -r '.components.economics.realized.realized_pnl // "null"')

log "  economics_hash: ${ECON_HASH:0:16}..."
log "  pnl_status: $REALIZED_STATUS"
log "  realized_pnl: $REALIZED_PNL"

if [ "$REALIZED_STATUS" = "PROVISIONAL" ] && [ "$REALIZED_PNL" = "225" ]; then
  record_result "Evidence Pack Realized Economics" "pass" ""
elif [ "$REALIZED_STATUS" = "null" ]; then
  record_result "Evidence Pack Realized Economics" "fail" "realized economics missing"
else
  record_result "Evidence Pack Realized Economics" "fail" "status=$REALIZED_STATUS pnl=$REALIZED_PNL"
fi

# =============================================================================
# Test 5: Idempotency Stats
# =============================================================================
log ""
log "TEST 5: Idempotency Stats Endpoint"

STATS=$(curl -s http://localhost:7006/events/idempotency/stats)
TOTAL=$(echo "$STATS" | jq -r '.total_events // 0')
DUPES=$(echo "$STATS" | jq -r '.duplicates_blocked // 0')

log "  total_events: $TOTAL"
log "  duplicates_blocked: $DUPES"

if [ "$TOTAL" -gt 0 ] && [ "$DUPES" -gt 0 ]; then
  record_result "Idempotency Stats" "pass" ""
else
  record_result "Idempotency Stats" "fail" "total=$TOTAL dupes=$DUPES"
fi

# =============================================================================
# Summary
# =============================================================================
log ""
log "============================================================================="
log "P2 Acceptance Test Summary"
log "============================================================================="
log "Tests Run:    $TESTS_RUN"
log "Tests Passed: $TESTS_PASSED"
log "Tests Failed: $TESTS_FAILED"
log "Log File:     $LOG_FILE"

# Write JSON summary for CI consumption
# Schema versioned for backward compatibility (see PPE Learning Tip)
cat > "$SUMMARY_FILE" << EOF
{
  "schema_version": "1.0.0",
  "timestamp": "$TIMESTAMP",
  "git_commit": "$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')",
  "tests_run": $TESTS_RUN,
  "tests_passed": $TESTS_PASSED,
  "tests_failed": $TESTS_FAILED,
  "success": $([ $TESTS_FAILED -eq 0 ] && echo "true" || echo "false"),
  "log_file": "$LOG_FILE"
}
EOF

log ""
log "JSON summary written to: $SUMMARY_FILE"

# Exit with failure if any tests failed
if [ $TESTS_FAILED -gt 0 ]; then
  log ""
  log "RESULT: FAILED ($TESTS_FAILED failures)"
  exit 1
else
  log ""
  log "RESULT: PASSED (all $TESTS_PASSED tests)"
  exit 0
fi
