#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Phase 1 Week 1 Read Model Acceptance Test
# Proves: simulator → audit-writer → read-models → API endpoints
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log() { echo -e "${BLUE}[W1-TEST]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }

# Configuration
SIM_URL="${SIM_URL:-http://localhost:7010}"
AUDIT_URL="${AUDIT_URL:-http://localhost:7003}"
ORDER_API_URL="${ORDER_API_URL:-http://localhost:7001}"
TIMESTAMP=$(date -u +"%Y-%m-%d-%H%M%S")
STARTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
RESULTS_DIR="test-results"
RECEIPT_FILE="$RESULTS_DIR/ph1-week1-readmodel-acceptance.json"

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  PHASE 1 WEEK 1 READ MODEL ACCEPTANCE TEST${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

mkdir -p "$RESULTS_DIR"

# ============================================================================
# Receipt helpers
# ============================================================================

write_receipt() {
  local status=$1
  local message=$2
  local orders_count=${3:-0}
  local lifecycle_count=${4:-0}
  local lp_count=${5:-0}
  local rejections_count=${6:-0}
  local sample_order_id=${7:-"none"}
  local finished_at
  finished_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  jq -n \
    --arg overall_status "$status" \
    --arg started_at "$STARTED_AT" \
    --arg finished_at "$finished_at" \
    --arg message "$message" \
    --arg sim_url "$SIM_URL" \
    --arg audit_url "$AUDIT_URL" \
    --arg order_api_url "$ORDER_API_URL" \
    --argjson orders_count "$orders_count" \
    --argjson lifecycle_count "$lifecycle_count" \
    --argjson lp_count "$lp_count" \
    --argjson rejections_count "$rejections_count" \
    --arg sample_order_id "$sample_order_id" \
    '{
      overall_status: $overall_status,
      message: $message,
      timestamps: {
        started_at: $started_at,
        finished_at: $finished_at
      },
      endpoints: {
        simulator: $sim_url,
        audit_writer: $audit_url,
        order_api: $order_api_url
      },
      invariants: {
        orders_count: $orders_count,
        lifecycle_events_count: $lifecycle_count,
        lp_accounts_count: $lp_count,
        rejections_count: $rejections_count,
        sample_order_id: $sample_order_id
      },
      week1_criteria: {
        orders_populated: ($orders_count >= 1),
        lifecycle_events_populated: ($lifecycle_count >= 1),
        lp_accounts_seeded: ($lp_count >= 2),
        end_to_end_working: ($orders_count >= 1 and $lifecycle_count >= 1 and $lp_count >= 2)
      }
    }' > "$RECEIPT_FILE"
}

fail() {
  local message=$1
  error "$message"
  write_receipt "FAIL" "$message"
  echo ""
  echo -e "${RED}TEST FAILED${NC}"
  exit 1
}

# ============================================================================
# Step 1: Health checks
# ============================================================================

log "Step 1: Checking service health..."

# Check simulator
SIM_HEALTH=$(curl -sf "$SIM_URL/health" 2>/dev/null || echo '{"ok":false}')
if [[ $(echo "$SIM_HEALTH" | jq -r '.ok') != "true" ]]; then
  fail "Simulator not healthy at $SIM_URL"
fi
success "Simulator healthy"

# Check audit-writer
AUDIT_HEALTH=$(curl -sf "$AUDIT_URL/health" 2>/dev/null || echo '{"ok":false}')
if [[ $(echo "$AUDIT_HEALTH" | jq -r '.ok') != "true" ]]; then
  fail "Audit-writer not healthy at $AUDIT_URL"
fi
success "Audit-writer healthy"

# Check order-api
ORDER_API_HEALTH=$(curl -sf "$ORDER_API_URL/health" 2>/dev/null || echo '{"ok":false}')
if [[ $(echo "$ORDER_API_HEALTH" | jq -r '.ok') != "true" ]]; then
  fail "Order-API not healthy at $ORDER_API_URL"
fi
success "Order-API healthy"

# ============================================================================
# Step 2: Run simulator scenarios
# ============================================================================

log "Step 2: Running simulator scenarios..."

# Generate unique trace IDs
TRACE_FILL="w1-fill-$(date +%s)"
TRACE_REJECT="w1-reject-$(date +%s)"

# Scenario 1: Full fill
FILL_RESULT=$(curl -sf "$SIM_URL/simulate/full-fill" -X POST \
  -H "Content-Type: application/json" \
  -d "{\"trace_id\":\"$TRACE_FILL\",\"order\":{\"symbol\":\"EURUSD\",\"side\":\"BUY\",\"qty\":100000,\"price\":1.0850}}" \
  2>/dev/null || echo '{"success":false}')

if [[ $(echo "$FILL_RESULT" | jq -r '.success') != "true" ]]; then
  fail "Full-fill scenario failed"
fi
success "Full-fill scenario completed (trace: $TRACE_FILL)"

# Scenario 2: Rejection
REJECT_RESULT=$(curl -sf "$SIM_URL/simulate/rejection" -X POST \
  -H "Content-Type: application/json" \
  -d "{\"trace_id\":\"$TRACE_REJECT\",\"order\":{\"symbol\":\"GBPUSD\",\"side\":\"SELL\",\"qty\":50000,\"price\":1.2650},\"reason\":{\"code\":\"MARGIN_001\",\"message\":\"Insufficient margin\"}}" \
  2>/dev/null || echo '{"success":false}')

if [[ $(echo "$REJECT_RESULT" | jq -r '.success') != "true" ]]; then
  fail "Rejection scenario failed"
fi
success "Rejection scenario completed (trace: $TRACE_REJECT)"

# Wait for materialization
sleep 2

# ============================================================================
# Step 3: Verify read models via API
# ============================================================================

log "Step 3: Verifying read models via API endpoints..."

# Check orders
ORDERS_RESPONSE=$(curl -sf "$ORDER_API_URL/api/orders" 2>/dev/null || echo '{"success":false}')
if [[ $(echo "$ORDERS_RESPONSE" | jq -r '.success') != "true" ]]; then
  fail "GET /api/orders failed"
fi
ORDERS_COUNT=$(echo "$ORDERS_RESPONSE" | jq -r '.meta.total // 0')
success "Orders endpoint returned $ORDERS_COUNT orders"

if [[ $ORDERS_COUNT -lt 1 ]]; then
  fail "Expected at least 1 order, got $ORDERS_COUNT"
fi

# Get sample order for lifecycle check
SAMPLE_ORDER_ID=$(echo "$ORDERS_RESPONSE" | jq -r '.data[0].id // "none"')

# Check lifecycle for sample order
LIFECYCLE_RESPONSE=$(curl -sf "$ORDER_API_URL/api/orders/$SAMPLE_ORDER_ID/lifecycle" 2>/dev/null || echo '{"success":false}')
if [[ $(echo "$LIFECYCLE_RESPONSE" | jq -r '.success') != "true" ]]; then
  fail "GET /api/orders/$SAMPLE_ORDER_ID/lifecycle failed"
fi
LIFECYCLE_COUNT=$(echo "$LIFECYCLE_RESPONSE" | jq -r '.meta.event_count // 0')
success "Order $SAMPLE_ORDER_ID has $LIFECYCLE_COUNT lifecycle events"

if [[ $LIFECYCLE_COUNT -lt 1 ]]; then
  fail "Expected at least 1 lifecycle event, got $LIFECYCLE_COUNT"
fi

# Check LP accounts
LP_RESPONSE=$(curl -sf "$ORDER_API_URL/api/lp-accounts" 2>/dev/null || echo '{"success":false}')
if [[ $(echo "$LP_RESPONSE" | jq -r '.success') != "true" ]]; then
  fail "GET /api/lp-accounts failed"
fi
LP_COUNT=$(echo "$LP_RESPONSE" | jq -r '.meta.count // 0')
success "LP accounts endpoint returned $LP_COUNT accounts"

if [[ $LP_COUNT -lt 2 ]]; then
  fail "Expected at least 2 LP accounts, got $LP_COUNT"
fi

# Check rejections
REJECTIONS_RESPONSE=$(curl -sf "$ORDER_API_URL/api/rejections" 2>/dev/null || echo '{"success":false}')
if [[ $(echo "$REJECTIONS_RESPONSE" | jq -r '.success') != "true" ]]; then
  fail "GET /api/rejections failed"
fi
REJECTIONS_COUNT=$(echo "$REJECTIONS_RESPONSE" | jq -r '.meta.count // 0')
success "Rejections endpoint returned $REJECTIONS_COUNT rejections"

# ============================================================================
# Step 4: Write success receipt
# ============================================================================

log "Step 4: Writing acceptance receipt..."

write_receipt "PASS" "All Week 1 invariants verified" \
  "$ORDERS_COUNT" "$LIFECYCLE_COUNT" "$LP_COUNT" "$REJECTIONS_COUNT" "$SAMPLE_ORDER_ID"

success "Receipt written to $RECEIPT_FILE"

# ============================================================================
# Summary
# ============================================================================

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  WEEK 1 ACCEPTANCE TEST PASSED${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Invariants verified:"
echo "    ✓ Orders populated: $ORDERS_COUNT orders in read model"
echo "    ✓ Lifecycle events: $LIFECYCLE_COUNT events for sample order"
echo "    ✓ LP accounts seeded: $LP_COUNT LP accounts"
echo "    ✓ Rejections tracked: $REJECTIONS_COUNT rejections"
echo ""
echo "  Sample order: $SAMPLE_ORDER_ID"
echo "  Receipt: $RECEIPT_FILE"
echo ""

exit 0
