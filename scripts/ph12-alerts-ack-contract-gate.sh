#!/bin/bash
# ============================================================================
# Phase 12: Alerts Acknowledgment Contract Gate
# ============================================================================
# Static contract checks for alert ack workflow
# Validates UI ack controls, API route, and state transitions
# ============================================================================

set -uo pipefail

PASS=0
FAIL=0

check() {
  local desc="$1"
  local result="$2"
  if [[ "$result" == "PASS" ]]; then
    echo "✓ PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "✗ FAIL: $desc"
    FAIL=$((FAIL + 1))
  fi
}

UI_SERVER="services/ui/server.js"
ALERTS_HTML="services/ui/public/alerts.html"
ORDER_API="services/order-api/src/index.ts"

echo ""
echo "============================================"
echo "Phase 12: Alerts Acknowledgment Contract Gate"
echo "============================================"
echo ""

# ----------------------------------------------------------------------------
# Section 1: API Route Checks
# ----------------------------------------------------------------------------
echo "--- Section 1: API Routes ---"

# 1.1 UI server proxy route exists
if grep -q 'app.post.*alerts.*ack' "$UI_SERVER" || grep -q 'POST.*alerts.*ack' "$UI_SERVER"; then
  check "UI server POST /api/alerts/:id/ack proxy route" "PASS"
else
  check "UI server POST /api/alerts/:id/ack proxy route" "FAIL"
fi

# 1.2 Order API ack endpoint exists
if grep -q 'app.post.*alerts.*ack' "$ORDER_API"; then
  check "Order API POST /api/alerts/:alertId/ack endpoint" "PASS"
else
  check "Order API POST /api/alerts/:alertId/ack endpoint" "FAIL"
fi

# 1.3 Ack action types supported
if grep -q "ACK.*RESOLVE.*SNOOZE" "$ORDER_API" || grep -q "validActions" "$ORDER_API"; then
  check "API supports ACK/RESOLVE/SNOOZE actions" "PASS"
else
  check "API supports ACK/RESOLVE/SNOOZE actions" "FAIL"
fi

# 1.4 Alert status update on ack
if grep -q "UPDATE alerts SET" "$ORDER_API" && grep -q "status" "$ORDER_API"; then
  check "API updates alert status on ack" "PASS"
else
  check "API updates alert status on ack" "FAIL"
fi

# 1.5 Ack record insertion
if grep -q "INSERT INTO alert_acks" "$ORDER_API"; then
  check "API inserts ack record (audit trail)" "PASS"
else
  check "API inserts ack record (audit trail)" "FAIL"
fi

# 1.6 acknowledged_at timestamp set
if grep -q "acknowledged_at.*NOW()" "$ORDER_API"; then
  check "API sets acknowledged_at timestamp" "PASS"
else
  check "API sets acknowledged_at timestamp" "FAIL"
fi

echo ""

# ----------------------------------------------------------------------------
# Section 2: UI Ack Panel Checks
# ----------------------------------------------------------------------------
echo "--- Section 2: UI Ack Panel ---"

# 2.1 Ack panel exists
if grep -q 'id="alerts-ack-panel"' "$ALERTS_HTML"; then
  check "Ack panel DOM anchor (alerts-ack-panel)" "PASS"
else
  check "Ack panel DOM anchor (alerts-ack-panel)" "FAIL"
fi

# 2.2 Ack submit button
if grep -q 'id="alerts-ack-submit"' "$ALERTS_HTML"; then
  check "Ack submit button (alerts-ack-submit)" "PASS"
else
  check "Ack submit button (alerts-ack-submit)" "FAIL"
fi

# 2.3 Ack note input
if grep -q 'id="alerts-ack-note"' "$ALERTS_HTML"; then
  check "Ack note textarea (alerts-ack-note)" "PASS"
else
  check "Ack note textarea (alerts-ack-note)" "FAIL"
fi

# 2.4 Critical alert required note
if grep -q 'critical.*required' "$ALERTS_HTML" || grep -q 'note.*REQUIRED' "$ALERTS_HTML"; then
  check "Critical alerts require note" "PASS"
else
  check "Critical alerts require note" "FAIL"
fi

# 2.5 Ack button in filters/actions
if grep -q 'btn-ack-selected' "$ALERTS_HTML"; then
  check "Bulk ack button (btn-ack-selected)" "PASS"
else
  check "Bulk ack button (btn-ack-selected)" "FAIL"
fi

echo ""

# ----------------------------------------------------------------------------
# Section 3: Ack Submission Logic Checks
# ----------------------------------------------------------------------------
echo "--- Section 3: Ack Submission Logic ---"

# 3.1 submitAck function exists
if grep -q 'function submitAck' "$ALERTS_HTML" || grep -q 'async function submitAck' "$ALERTS_HTML"; then
  check "submitAck function defined" "PASS"
else
  check "submitAck function defined" "FAIL"
fi

# 3.2 API call with correct body format
if grep -q 'action.*ACK' "$ALERTS_HTML" && grep -q 'actor_name' "$ALERTS_HTML"; then
  check "API body uses action/actor_name format" "PASS"
else
  check "API body uses action/actor_name format" "FAIL"
fi

# 3.3 Comment field sent
if grep -q 'comment.*note' "$ALERTS_HTML" || grep -q 'note.*comment' "$ALERTS_HTML"; then
  check "Comment/note sent in API body" "PASS"
else
  check "Comment/note sent in API body" "FAIL"
fi

# 3.4 Local state update after ack
if grep -q "alert.status.*acknowledged" "$ALERTS_HTML"; then
  check "Local state updated to acknowledged" "PASS"
else
  check "Local state updated to acknowledged" "FAIL"
fi

# 3.5 Re-fetch after ack
if grep -q "fetchAlerts()" "$ALERTS_HTML" && grep -q "closeDetail()" "$ALERTS_HTML"; then
  check "Re-fetches alerts after ack" "PASS"
else
  check "Re-fetches alerts after ack" "FAIL"
fi

# 3.6 Toast notification on success
if grep -q "showToast.*acknowledged" "$ALERTS_HTML"; then
  check "Toast notification on ack success" "PASS"
else
  check "Toast notification on ack success" "FAIL"
fi

echo ""

# ----------------------------------------------------------------------------
# Section 4: Acked Display Checks
# ----------------------------------------------------------------------------
echo "--- Section 4: Acked State Display ---"

# 4.1 Acknowledged row class
if grep -q 'class.*acknowledged' "$ALERTS_HTML"; then
  check "Acknowledged row styling class" "PASS"
else
  check "Acknowledged row styling class" "FAIL"
fi

# 4.2 Acked by display in detail
if grep -q 'acknowledgedBy' "$ALERTS_HTML" || grep -q 'actor_name' "$ALERTS_HTML"; then
  check "Acked-by display in detail panel" "PASS"
else
  check "Acked-by display in detail panel" "FAIL"
fi

# 4.3 Acked at timestamp display
if grep -q 'acknowledgedAt' "$ALERTS_HTML" || grep -q 'acknowledged_at' "$ALERTS_HTML"; then
  check "Acked-at timestamp display" "PASS"
else
  check "Acked-at timestamp display" "FAIL"
fi

# 4.4 Ack note display
if grep -q 'ackNote' "$ALERTS_HTML" && grep -q 'No note provided' "$ALERTS_HTML"; then
  check "Ack note display (with fallback)" "PASS"
else
  check "Ack note display (with fallback)" "FAIL"
fi

# 4.5 Status badge for acknowledged
if grep -q 'status-badge.*acknowledged' "$ALERTS_HTML"; then
  check "Status badge for acknowledged state" "PASS"
else
  check "Status badge for acknowledged state" "FAIL"
fi

# 4.6 Stats counter for acked
if grep -q 'stat-acked' "$ALERTS_HTML"; then
  check "Stats counter for acked alerts" "PASS"
else
  check "Stats counter for acked alerts" "FAIL"
fi

echo ""

# ----------------------------------------------------------------------------
# Section 5: Data Model Checks
# ----------------------------------------------------------------------------
echo "--- Section 5: Data Model ---"

# 5.1 normalizeAlert includes alert_id
if grep -q 'alert_id.*raw.alert_id' "$ALERTS_HTML" || grep -qP 'alert_id:\s*raw' "$ALERTS_HTML"; then
  check "normalizeAlert includes alert_id for API" "PASS"
else
  check "normalizeAlert includes alert_id for API" "FAIL"
fi

# 5.2 normalizeAlert handles ACKNOWLEDGED status
if grep -qP 'ACKNOWLEDGED.*acknowledged' "$ALERTS_HTML" || grep -q 'status.*ACKNOWLEDGED' "$ALERTS_HTML"; then
  check "normalizeAlert handles ACKNOWLEDGED status" "PASS"
else
  check "normalizeAlert handles ACKNOWLEDGED status" "FAIL"
fi

# 5.3 acknowledgedBy mapped from ack info
if grep -q 'acknowledgedBy.*actor_name' "$ALERTS_HTML" || grep -q 'ackInfo.actor_name' "$ALERTS_HTML"; then
  check "acknowledgedBy mapped from server ack info" "PASS"
else
  check "acknowledgedBy mapped from server ack info" "FAIL"
fi

echo ""

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
echo "============================================"
echo "GATE_SUMMARY gate=ph12-alerts-ack passed=$PASS failed=$FAIL"
echo "============================================"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
