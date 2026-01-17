#!/bin/bash
# =============================================================================
# Phase 1 Demo Choreography Script
# =============================================================================
#
# PURPOSE:
# Single, repeatable "demo truth" artifact that composes:
#   - Clean boot verification
#   - Stack health checks
#   - Demo trigger flows via proxy
#   - UI-visible deltas verification
#   - Export step (fail-closed)
#
# OUTPUT:
#   test-results/ph1-demo-run-<timestamp>.json
#
# EXIT CODES:
#   0  = All checks passed
#   1  = One or more checks failed
#   2  = Critical infrastructure failure (stack not up)
#   3  = Export endpoint missing (EXPORT_ENDPOINT_MISSING)
#
# USAGE:
#   ./scripts/ph1-demo-choreography.sh [--skip-clean-boot] [--skip-stack-up]
#
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# =============================================================================
# Configuration
# =============================================================================

ORDER_API_URL="${ORDER_API_URL:-http://localhost:7001}"
UI_URL="${UI_URL:-http://localhost:3000}"
AUDIT_WRITER_URL="${AUDIT_WRITER_URL:-http://localhost:7003}"
LP_SIMULATOR_URL="${LP_SIMULATOR_URL:-http://localhost:7010}"
PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5434}"
PGUSER="${PGUSER:-broker}"
PGPASSWORD="${PGPASSWORD:-broker}"
PGDATABASE="${PGDATABASE:-broker}"

TIMESTAMP=$(date +%Y-%m-%d-%H%M%S)
OUTPUT_DIR="${PROJECT_ROOT}/test-results/demo-run-${TIMESTAMP}"
RESULTS_FILE="${OUTPUT_DIR}/ph1-demo-run.json"
LOG_FILE="${OUTPUT_DIR}/demo-choreography.log"
EXPORT_DIR="${OUTPUT_DIR}/exports"

# Parse arguments
SKIP_CLEAN_BOOT=false
SKIP_STACK_UP=false
for arg in "$@"; do
    case $arg in
        --skip-clean-boot) SKIP_CLEAN_BOOT=true ;;
        --skip-stack-up) SKIP_STACK_UP=true ;;
    esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# =============================================================================
# State Tracking
# =============================================================================

TOTAL_CHECKS=0
PASSED_CHECKS=0
FAILED_CHECKS=0
CHECK_RESULTS=()
PHASE_RESULTS=()
EXIT_CODE=0
FAILURE_REASON=""

mkdir -p "$OUTPUT_DIR" "$EXPORT_DIR"

# =============================================================================
# Helpers
# =============================================================================

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

phase_header() {
    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}  PHASE: $1${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    log "=== PHASE: $1 ==="
}

record_check() {
    local name="$1"
    local status="$2"
    local message="$3"
    local phase="$4"
    
    TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
    
    if [ "$status" = "PASS" ]; then
        PASSED_CHECKS=$((PASSED_CHECKS + 1))
        echo -e "  ${GREEN}✓${NC} $name"
    else
        FAILED_CHECKS=$((FAILED_CHECKS + 1))
        echo -e "  ${RED}✗${NC} $name: $message"
        if [ -z "$FAILURE_REASON" ]; then
            FAILURE_REASON="$name: $message"
        fi
    fi
    
    CHECK_RESULTS+=("{\"name\": \"$name\", \"status\": \"$status\", \"message\": \"$message\", \"phase\": \"$phase\"}")
    log "Check: $name - $status - $message"
}

record_phase() {
    local phase="$1"
    local status="$2"
    local duration="$3"
    
    PHASE_RESULTS+=("{\"phase\": \"$phase\", \"status\": \"$status\", \"duration_ms\": $duration}")
    
    if [ "$status" = "PASS" ]; then
        echo -e "\n  ${GREEN}Phase $phase: PASSED${NC} (${duration}ms)"
    else
        echo -e "\n  ${RED}Phase $phase: FAILED${NC} (${duration}ms)"
    fi
}

psql_query() {
    PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -t -A -c "$1" 2>/dev/null
}

wait_for_service() {
    local url="$1"
    local name="$2"
    local max_attempts="${3:-30}"
    
    for i in $(seq 1 $max_attempts); do
        if curl -sf "$url" > /dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

# =============================================================================
# PHASE 1: Clean Boot Verification
# =============================================================================

run_clean_boot_phase() {
    phase_header "1 - Clean Boot Verification"
    local phase_start=$(date +%s%3N)
    local phase_status="PASS"
    
    if [ "$SKIP_CLEAN_BOOT" = true ]; then
        echo "  (Skipped via --skip-clean-boot)"
        record_check "clean-boot" "PASS" "skipped" "clean-boot"
        record_phase "clean-boot" "PASS" 0
        return 0
    fi
    
    # Check migrations directory
    if [ -d "${PROJECT_ROOT}/infra/db/migrations" ]; then
        MIGRATION_COUNT=$(ls -1 "${PROJECT_ROOT}/infra/db/migrations/"*.sql 2>/dev/null | wc -l)
        if [ "$MIGRATION_COUNT" -ge 4 ]; then
            record_check "migrations-present" "PASS" "${MIGRATION_COUNT} migration files" "clean-boot"
        else
            record_check "migrations-present" "FAIL" "only ${MIGRATION_COUNT} migrations found" "clean-boot"
            phase_status="FAIL"
        fi
    else
        record_check "migrations-present" "FAIL" "migrations directory missing" "clean-boot"
        phase_status="FAIL"
    fi
    
    # Check key tables exist
    local tables=("audit_events" "orders" "alerts" "alert_settings" "lp_accounts" "lp_snapshots")
    for table in "${tables[@]}"; do
        if psql_query "SELECT 1 FROM information_schema.tables WHERE table_name = '${table}';" 2>/dev/null | grep -q 1; then
            record_check "table-${table}" "PASS" "exists" "clean-boot"
        else
            record_check "table-${table}" "FAIL" "missing" "clean-boot"
            phase_status="FAIL"
        fi
    done
    
    # Check seed data
    local alert_settings_count=$(psql_query "SELECT COUNT(*) FROM alert_settings;")
    if [ "${alert_settings_count:-0}" -ge 4 ]; then
        record_check "seed-alert-settings" "PASS" "${alert_settings_count} settings" "clean-boot"
    else
        record_check "seed-alert-settings" "FAIL" "only ${alert_settings_count} settings" "clean-boot"
        phase_status="FAIL"
    fi
    
    local phase_end=$(date +%s%3N)
    local phase_duration=$((phase_end - phase_start))
    record_phase "clean-boot" "$phase_status" "$phase_duration"
    
    [ "$phase_status" = "PASS" ] && return 0 || return 1
}

# =============================================================================
# PHASE 2: Stack Health
# =============================================================================

run_stack_health_phase() {
    phase_header "2 - Stack Health"
    local phase_start=$(date +%s%3N)
    local phase_status="PASS"
    
    if [ "$SKIP_STACK_UP" = true ]; then
        echo "  (Skipped via --skip-stack-up)"
        record_check "stack-health" "PASS" "skipped" "stack-health"
        record_phase "stack-health" "PASS" 0
        return 0
    fi
    
    # Check each service health endpoint
    local services=(
        "order-api:${ORDER_API_URL}/health"
        "audit-writer:${AUDIT_WRITER_URL}/health"
        "lp-simulator:${LP_SIMULATOR_URL}/health"
        "ui:${UI_URL}/health"
    )
    
    for service_url in "${services[@]}"; do
        local service="${service_url%%:*}"
        local url="${service_url#*:}"
        
        if curl -sf "$url" > /dev/null 2>&1; then
            record_check "health-${service}" "PASS" "responding" "stack-health"
        else
            record_check "health-${service}" "FAIL" "not responding" "stack-health"
            phase_status="FAIL"
        fi
    done
    
    # Check database connection
    if psql_query "SELECT 1" > /dev/null 2>&1; then
        record_check "health-postgres" "PASS" "connected" "stack-health"
    else
        record_check "health-postgres" "FAIL" "connection failed" "stack-health"
        phase_status="FAIL"
        EXIT_CODE=2
        FAILURE_REASON="INFRASTRUCTURE_FAILURE: Database not reachable"
    fi
    
    local phase_end=$(date +%s%3N)
    local phase_duration=$((phase_end - phase_start))
    record_phase "stack-health" "$phase_status" "$phase_duration"
    
    [ "$phase_status" = "PASS" ] && return 0 || return 1
}

# =============================================================================
# PHASE 3: Demo Triggers via Proxy
# =============================================================================

run_demo_triggers_phase() {
    phase_header "3 - Demo Triggers via Proxy"
    local phase_start=$(date +%s%3N)
    local phase_status="PASS"
    
    # Verify scenarios endpoint exists
    local scenarios_resp=$(curl -sf "${ORDER_API_URL}/api/demo/scenarios" 2>/dev/null || echo "")
    if echo "$scenarios_resp" | grep -q '"success":true'; then
        local scenario_count=$(echo "$scenarios_resp" | grep -o '"id"' | wc -l)
        record_check "demo-scenarios-endpoint" "PASS" "${scenario_count} scenarios available" "demo-triggers"
    else
        record_check "demo-scenarios-endpoint" "FAIL" "endpoint not responding" "demo-triggers"
        phase_status="FAIL"
    fi
    
    # Clear cooldowns for clean test
    psql_query "DELETE FROM alert_cooldowns;" > /dev/null 2>&1 || true
    
    # Capture baseline counts
    local alerts_before=$(psql_query "SELECT COUNT(*) FROM alerts WHERE status = 'OPEN';")
    local orders_before=$(psql_query "SELECT COUNT(*) FROM orders;")
    
    # Trigger margin-warning scenario
    local margin_resp=$(curl -sf -X POST "${ORDER_API_URL}/api/demo/trigger/margin-warning" \
        -H "Content-Type: application/json" \
        -d '{"lp_id": "LP-A", "margin_level": 40}' 2>/dev/null || echo "")
    
    if echo "$margin_resp" | grep -q '"success":true'; then
        record_check "trigger-margin-warning" "PASS" "scenario executed" "demo-triggers"
    else
        record_check "trigger-margin-warning" "FAIL" "trigger failed" "demo-triggers"
        phase_status="FAIL"
    fi
    
    sleep 2
    
    # Trigger rejection-spike scenario
    local spike_resp=$(curl -sf -X POST "${ORDER_API_URL}/api/demo/trigger/rejection-spike" \
        -H "Content-Type: application/json" \
        -d '{"count": 5, "symbol": "EURUSD"}' 2>/dev/null || echo "")
    
    if echo "$spike_resp" | grep -q '"success":true'; then
        record_check "trigger-rejection-spike" "PASS" "scenario executed" "demo-triggers"
    else
        record_check "trigger-rejection-spike" "FAIL" "trigger failed" "demo-triggers"
        phase_status="FAIL"
    fi
    
    sleep 3
    
    # Verify deltas occurred
    local alerts_after=$(psql_query "SELECT COUNT(*) FROM alerts WHERE status = 'OPEN';")
    local orders_after=$(psql_query "SELECT COUNT(*) FROM orders;")
    
    if [ "${alerts_after:-0}" -gt "${alerts_before:-0}" ]; then
        local delta=$((alerts_after - alerts_before))
        record_check "delta-alerts-increased" "PASS" "+${delta} open alerts" "demo-triggers"
    else
        record_check "delta-alerts-increased" "FAIL" "no new alerts (before: ${alerts_before}, after: ${alerts_after})" "demo-triggers"
        phase_status="FAIL"
    fi
    
    if [ "${orders_after:-0}" -gt "${orders_before:-0}" ]; then
        local delta=$((orders_after - orders_before))
        record_check "delta-orders-increased" "PASS" "+${delta} orders" "demo-triggers"
    else
        record_check "delta-orders-increased" "FAIL" "no new orders" "demo-triggers"
        phase_status="FAIL"
    fi
    
    local phase_end=$(date +%s%3N)
    local phase_duration=$((phase_end - phase_start))
    record_phase "demo-triggers" "$phase_status" "$phase_duration"
    
    [ "$phase_status" = "PASS" ] && return 0 || return 1
}

# =============================================================================
# PHASE 4: UI-Visible Deltas (API Level + HTML Smoke)
# =============================================================================

run_ui_deltas_phase() {
    phase_header "4 - UI-Visible Deltas"
    local phase_start=$(date +%s%3N)
    local phase_status="PASS"
    
    # Verify KPIs API returns data
    local kpis_resp=$(curl -sf "${ORDER_API_URL}/api/dashboard/kpis?window=1h" 2>/dev/null || echo "")
    if echo "$kpis_resp" | grep -q '"success":true'; then
        local open_alerts=$(echo "$kpis_resp" | grep -o '"open":[0-9]*' | head -1 | grep -o '[0-9]*' || echo "0")
        record_check "api-kpis-available" "PASS" "open_alerts=${open_alerts}" "ui-deltas"
    else
        record_check "api-kpis-available" "FAIL" "KPI endpoint error" "ui-deltas"
        phase_status="FAIL"
    fi
    
    # Verify Alerts API returns data
    local alerts_resp=$(curl -sf "${ORDER_API_URL}/api/alerts?status=OPEN&limit=10" 2>/dev/null || echo "")
    if echo "$alerts_resp" | grep -q '"success":true'; then
        local alert_count=$(echo "$alerts_resp" | grep -o '"alert_id"' | wc -l)
        record_check "api-alerts-available" "PASS" "${alert_count} alerts returned" "ui-deltas"
    else
        record_check "api-alerts-available" "FAIL" "alerts endpoint error" "ui-deltas"
        phase_status="FAIL"
    fi
    
    # Verify LP Accounts API
    local lp_resp=$(curl -sf "${ORDER_API_URL}/api/lp-accounts" 2>/dev/null || echo "")
    if echo "$lp_resp" | grep -q '"success":true'; then
        local lp_count=$(echo "$lp_resp" | grep -o '"id"' | wc -l)
        record_check "api-lp-accounts-available" "PASS" "${lp_count} LP accounts" "ui-deltas"
    else
        record_check "api-lp-accounts-available" "FAIL" "LP accounts endpoint error" "ui-deltas"
        phase_status="FAIL"
    fi
    
    # UI HTML Smoke Tests
    local dashboard_html=$(curl -sf "${UI_URL}/dashboard" 2>/dev/null || echo "")
    
    # Check dashboard page loads
    if echo "$dashboard_html" | grep -q "Operations Dashboard"; then
        record_check "ui-dashboard-loads" "PASS" "page renders" "ui-deltas"
    else
        record_check "ui-dashboard-loads" "FAIL" "page not loading" "ui-deltas"
        phase_status="FAIL"
    fi
    
    # Check key UI anchor IDs exist
    local ui_anchors=("kpi-orders" "kpi-alerts" "alerts-list" "lp-list" "demo-controls")
    for anchor in "${ui_anchors[@]}"; do
        if echo "$dashboard_html" | grep -q "id=\"${anchor}\""; then
            record_check "ui-anchor-${anchor}" "PASS" "present" "ui-deltas"
        else
            record_check "ui-anchor-${anchor}" "FAIL" "missing" "ui-deltas"
            phase_status="FAIL"
        fi
    done
    
    # Verify UI proxy works (calls through to order-api)
    local ui_proxy_kpis=$(curl -sf "${UI_URL}/api/dashboard/kpis" 2>/dev/null || echo "")
    if echo "$ui_proxy_kpis" | grep -q '"success"'; then
        record_check "ui-proxy-works" "PASS" "proxy functional" "ui-deltas"
    else
        record_check "ui-proxy-works" "FAIL" "proxy broken" "ui-deltas"
        phase_status="FAIL"
    fi
    
    local phase_end=$(date +%s%3N)
    local phase_duration=$((phase_end - phase_start))
    record_phase "ui-deltas" "$phase_status" "$phase_duration"
    
    [ "$phase_status" = "PASS" ] && return 0 || return 1
}

# =============================================================================
# PHASE 5: Export Step (Fail-Closed)
# =============================================================================

run_export_phase() {
    phase_header "5 - Export Step"
    local phase_start=$(date +%s%3N)
    local phase_status="PASS"
    local export_available=false
    
    # Check if export endpoint exists
    local export_check=$(curl -sf "${ORDER_API_URL}/api/export/evidence-pack" 2>/dev/null)
    local export_status=$?
    
    # Try different possible export endpoints
    local export_endpoints=(
        "${ORDER_API_URL}/api/export/evidence-pack"
        "${ORDER_API_URL}/api/export/bundle"
        "${ORDER_API_URL}/api/traces/export"
    )
    
    for endpoint in "${export_endpoints[@]}"; do
        local resp=$(curl -sf "$endpoint" 2>/dev/null)
        if [ -n "$resp" ] && echo "$resp" | grep -q '"success"\|"data"\|"bundle"'; then
            export_available=true
            # Save export
            echo "$resp" > "${EXPORT_DIR}/evidence-export.json"
            local checksum=$(sha256sum "${EXPORT_DIR}/evidence-export.json" | cut -d' ' -f1)
            record_check "export-endpoint" "PASS" "exported (sha256: ${checksum:0:16}...)" "export"
            break
        fi
    done
    
    if [ "$export_available" = false ]; then
        # Fail-closed: export endpoint missing
        record_check "export-endpoint" "FAIL" "EXPORT_ENDPOINT_MISSING" "export"
        phase_status="FAIL"
        
        # Create manual export as fallback
        echo "Export endpoint not available. Creating manual evidence bundle..." | tee -a "$LOG_FILE"
        
        # Export current state as JSON
        local manual_export="${EXPORT_DIR}/manual-evidence-bundle.json"
        cat > "$manual_export" << EOF
{
  "type": "manual-evidence-bundle",
  "timestamp": "$(date -Iseconds)",
  "reason": "EXPORT_ENDPOINT_MISSING",
  "state": {
    "alerts_open": $(psql_query "SELECT COUNT(*) FROM alerts WHERE status = 'OPEN';"),
    "alerts_total": $(psql_query "SELECT COUNT(*) FROM alerts;"),
    "orders_total": $(psql_query "SELECT COUNT(*) FROM orders;"),
    "lp_accounts": $(psql_query "SELECT COUNT(*) FROM lp_accounts;"),
    "lp_snapshots": $(psql_query "SELECT COUNT(*) FROM lp_snapshots;")
  },
  "sample_alerts": $(psql_query "SELECT json_agg(row_to_json(t)) FROM (SELECT alert_id, category, severity, status, lp_id FROM alerts ORDER BY created_at DESC LIMIT 5) t;" || echo "[]"),
  "sample_orders": $(psql_query "SELECT json_agg(row_to_json(t)) FROM (SELECT id, symbol, side, status, lp_id FROM orders ORDER BY created_at DESC LIMIT 5) t;" || echo "[]")
}
EOF
        local checksum=$(sha256sum "$manual_export" | cut -d' ' -f1)
        record_check "export-manual-fallback" "PASS" "created (sha256: ${checksum:0:16}...)" "export"
        
        # Set exit code for missing export endpoint
        if [ "$EXIT_CODE" -eq 0 ]; then
            EXIT_CODE=3
            FAILURE_REASON="EXPORT_ENDPOINT_MISSING"
        fi
    fi
    
    local phase_end=$(date +%s%3N)
    local phase_duration=$((phase_end - phase_start))
    record_phase "export" "$phase_status" "$phase_duration"
    
    [ "$phase_status" = "PASS" ] && return 0 || return 1
}

# =============================================================================
# Generate Receipt
# =============================================================================

generate_receipt() {
    phase_header "Receipt Generation"
    
    local overall_status="PASS"
    if [ "$FAILED_CHECKS" -gt 0 ]; then
        overall_status="FAIL"
        [ "$EXIT_CODE" -eq 0 ] && EXIT_CODE=1
    fi
    
    cat > "$RESULTS_FILE" << EOF
{
  "suite": "PH1-Demo-Choreography",
  "version": "1.0.0",
  "timestamp": "$(date -Iseconds)",
  "run_id": "${TIMESTAMP}",
  "output_dir": "${OUTPUT_DIR}",
  "success": $([ "$overall_status" = "PASS" ] && echo "true" || echo "false"),
  "exit_code": ${EXIT_CODE},
  "failure_reason": $([ -n "$FAILURE_REASON" ] && echo "\"$FAILURE_REASON\"" || echo "null"),
  "summary": {
    "total_checks": ${TOTAL_CHECKS},
    "passed": ${PASSED_CHECKS},
    "failed": ${FAILED_CHECKS}
  },
  "phases": [
    $(IFS=,; echo "${PHASE_RESULTS[*]}")
  ],
  "checks": [
    $(IFS=,; echo "${CHECK_RESULTS[*]}")
  ],
  "environment": {
    "order_api_url": "${ORDER_API_URL}",
    "ui_url": "${UI_URL}",
    "pghost": "${PGHOST}",
    "pgport": "${PGPORT}",
    "skip_clean_boot": ${SKIP_CLEAN_BOOT},
    "skip_stack_up": ${SKIP_STACK_UP}
  },
  "artifacts": {
    "log_file": "${LOG_FILE}",
    "export_dir": "${EXPORT_DIR}"
  }
}
EOF

    # Create symlinks
    ln -sf "${OUTPUT_DIR}" "${PROJECT_ROOT}/test-results/demo-run-latest"
    cp "$RESULTS_FILE" "${PROJECT_ROOT}/test-results/ph1-demo-run-latest.json"
    
    log "Receipt written to: $RESULTS_FILE"
    log "Symlink: test-results/demo-run-latest"
}

# =============================================================================
# Main Execution
# =============================================================================

main() {
    echo ""
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║     TRUVESTA Phase 1 Demo Choreography                    ║${NC}"
    echo -e "${CYAN}║     Release Candidate Verification                        ║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    
    log "=== Demo Choreography Started ==="
    log "Output directory: ${OUTPUT_DIR}"
    log "Options: skip_clean_boot=${SKIP_CLEAN_BOOT}, skip_stack_up=${SKIP_STACK_UP}"
    
    # Run all phases
    run_clean_boot_phase
    
    run_stack_health_phase
    if [ $? -ne 0 ] && [ "$EXIT_CODE" -eq 2 ]; then
        # Critical infrastructure failure - abort
        echo -e "\n${RED}CRITICAL: Infrastructure failure. Aborting demo.${NC}"
        generate_receipt
        exit $EXIT_CODE
    fi
    
    run_demo_triggers_phase
    
    run_ui_deltas_phase
    
    run_export_phase
    
    # Generate final receipt
    generate_receipt
    
    # Print summary
    echo ""
    echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
    if [ "$FAILED_CHECKS" -eq 0 ]; then
        echo -e "${GREEN}  Demo Choreography: ALL CHECKS PASSED${NC}"
        echo -e "${GREEN}  Release Candidate: VERIFIED${NC}"
    else
        echo -e "${RED}  Demo Choreography: ${FAILED_CHECKS} CHECK(S) FAILED${NC}"
        if [ -n "$FAILURE_REASON" ]; then
            echo -e "${RED}  Reason: ${FAILURE_REASON}${NC}"
        fi
    fi
    echo -e "  Total: ${TOTAL_CHECKS} | Passed: ${PASSED_CHECKS} | Failed: ${FAILED_CHECKS}"
    echo -e "  Receipt: ${RESULTS_FILE}"
    echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
    
    exit $EXIT_CODE
}

# Run main
main "$@"
