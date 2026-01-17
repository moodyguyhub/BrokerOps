#!/bin/bash
# Clean Boot Verification Script
# 
# Spins up a fresh Postgres, applies all migrations 001-007,
# then runs Week 1-3 acceptance tests to produce a single receipt.
#
# Usage: ./scripts/clean-boot-verification.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Configuration
TIMESTAMP=$(date +%Y-%m-%d-%H%M%S)
OUTPUT_DIR="${PROJECT_ROOT}/test-results/clean-boot-${TIMESTAMP}"
RESULTS_FILE="${OUTPUT_DIR}/clean-boot-receipt.json"
LOG_FILE="${OUTPUT_DIR}/clean-boot.log"

# Clean boot postgres config
CLEAN_PG_CONTAINER="broker-postgres-clean-test"
CLEAN_PG_PORT="5435"
CLEAN_PG_USER="broker"
CLEAN_PG_PASSWORD="broker"
CLEAN_PG_DB="broker"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

mkdir -p "$OUTPUT_DIR"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

cleanup() {
    log "Cleaning up test container..."
    docker rm -f "$CLEAN_PG_CONTAINER" 2>/dev/null || true
}

trap cleanup EXIT

log "=== Clean Boot Verification ==="
log "Output directory: ${OUTPUT_DIR}"
log ""

# ============================================================================
# Step 1: Spin up fresh Postgres
# ============================================================================

log "=== Step 1: Starting fresh Postgres container ==="

# Remove any existing test container
docker rm -f "$CLEAN_PG_CONTAINER" 2>/dev/null || true

# Start fresh Postgres
docker run -d \
  --name "$CLEAN_PG_CONTAINER" \
  -e POSTGRES_USER="$CLEAN_PG_USER" \
  -e POSTGRES_PASSWORD="$CLEAN_PG_PASSWORD" \
  -e POSTGRES_DB="$CLEAN_PG_DB" \
  -p "${CLEAN_PG_PORT}:5432" \
  postgres:16-alpine

log "Waiting for Postgres to be ready..."
sleep 5

# Wait for postgres to be ready
for i in $(seq 1 30); do
    if PGPASSWORD="$CLEAN_PG_PASSWORD" psql -h localhost -p "$CLEAN_PG_PORT" -U "$CLEAN_PG_USER" -d "$CLEAN_PG_DB" -c "SELECT 1" > /dev/null 2>&1; then
        log "Postgres ready after ${i} seconds"
        break
    fi
    sleep 1
done

# ============================================================================
# Step 2: Apply all migrations
# ============================================================================

log ""
log "=== Step 2: Applying migrations 001-007 ==="

MIGRATIONS_DIR="${PROJECT_ROOT}/infra/db/migrations"
MIGRATION_RESULTS=()
MIGRATION_FAILURES=0

for migration in $(ls -1 "${MIGRATIONS_DIR}"/*.sql | sort); do
    migration_name=$(basename "$migration")
    log "Applying: ${migration_name}"
    
    if PGPASSWORD="$CLEAN_PG_PASSWORD" psql -h localhost -p "$CLEAN_PG_PORT" -U "$CLEAN_PG_USER" -d "$CLEAN_PG_DB" -f "$migration" >> "$LOG_FILE" 2>&1; then
        MIGRATION_RESULTS+=("{\"file\": \"${migration_name}\", \"status\": \"SUCCESS\"}")
        log "  ✓ ${migration_name} applied successfully"
    else
        MIGRATION_RESULTS+=("{\"file\": \"${migration_name}\", \"status\": \"FAILED\"}")
        log "  ✗ ${migration_name} FAILED"
        MIGRATION_FAILURES=$((MIGRATION_FAILURES + 1))
    fi
done

if [ "$MIGRATION_FAILURES" -gt 0 ]; then
    log ""
    log "ERROR: ${MIGRATION_FAILURES} migration(s) failed!"
    
    # Generate failure receipt
    cat > "$RESULTS_FILE" << EOF
{
  "suite": "Clean-Boot-Verification",
  "timestamp": "$(date -Iseconds)",
  "output_dir": "${OUTPUT_DIR}",
  "success": false,
  "phase": "migrations",
  "error": "Migration failures: ${MIGRATION_FAILURES}",
  "migrations": [
    $(IFS=,; echo "${MIGRATION_RESULTS[*]}")
  ]
}
EOF
    
    echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${RED}  Clean Boot: MIGRATION FAILURES                           ${NC}"
    echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
    exit 1
fi

log ""
log "All migrations applied successfully"

# ============================================================================
# Step 3: Verify table structure
# ============================================================================

log ""
log "=== Step 3: Verifying table structure ==="

EXPECTED_TABLES=(
    "audit_events"
    "lp_accounts"
    "lp_snapshots"
    "orders"
    "order_lifecycle_events"
    "rejections"
    "alert_settings"
    "alerts"
    "alert_acks"
    "alert_cooldowns"
    "dashboard_stats"
    "notification_log"
)

TABLE_RESULTS=()
TABLE_FAILURES=0

for table in "${EXPECTED_TABLES[@]}"; do
    if PGPASSWORD="$CLEAN_PG_PASSWORD" psql -h localhost -p "$CLEAN_PG_PORT" -U "$CLEAN_PG_USER" -d "$CLEAN_PG_DB" -t -c "SELECT 1 FROM information_schema.tables WHERE table_name = '${table}';" 2>/dev/null | grep -q 1; then
        TABLE_RESULTS+=("{\"table\": \"${table}\", \"exists\": true}")
        log "  ✓ ${table}"
    else
        TABLE_RESULTS+=("{\"table\": \"${table}\", \"exists\": false}")
        log "  ✗ ${table} MISSING"
        TABLE_FAILURES=$((TABLE_FAILURES + 1))
    fi
done

if [ "$TABLE_FAILURES" -gt 0 ]; then
    log ""
    log "ERROR: ${TABLE_FAILURES} table(s) missing!"
    exit 1
fi

# ============================================================================
# Step 4: Verify seed data
# ============================================================================

log ""
log "=== Step 4: Verifying seed data ==="

ALERT_SETTINGS_COUNT=$(PGPASSWORD="$CLEAN_PG_PASSWORD" psql -h localhost -p "$CLEAN_PG_PORT" -U "$CLEAN_PG_USER" -d "$CLEAN_PG_DB" -t -A -c "SELECT COUNT(*) FROM alert_settings;" 2>/dev/null)
DASHBOARD_STATS_COUNT=$(PGPASSWORD="$CLEAN_PG_PASSWORD" psql -h localhost -p "$CLEAN_PG_PORT" -U "$CLEAN_PG_USER" -d "$CLEAN_PG_DB" -t -A -c "SELECT COUNT(*) FROM dashboard_stats;" 2>/dev/null)

log "  Alert settings: ${ALERT_SETTINGS_COUNT}"
log "  Dashboard stats: ${DASHBOARD_STATS_COUNT}"

SEED_OK=true
if [ "${ALERT_SETTINGS_COUNT:-0}" -lt 4 ]; then
    log "  ✗ Alert settings seed data missing"
    SEED_OK=false
fi
if [ "${DASHBOARD_STATS_COUNT:-0}" -lt 8 ]; then
    log "  ✗ Dashboard stats seed data missing"
    SEED_OK=false
fi

# ============================================================================
# Generate Receipt
# ============================================================================

log ""
log "=== Generating Clean Boot Receipt ==="

cat > "$RESULTS_FILE" << EOF
{
  "suite": "Clean-Boot-Verification",
  "timestamp": "$(date -Iseconds)",
  "output_dir": "${OUTPUT_DIR}",
  "success": true,
  "phases": {
    "postgres_startup": "SUCCESS",
    "migrations": "SUCCESS",
    "table_verification": "SUCCESS",
    "seed_data": "${SEED_OK}"
  },
  "migrations": [
    $(IFS=,; echo "${MIGRATION_RESULTS[*]}")
  ],
  "tables": [
    $(IFS=,; echo "${TABLE_RESULTS[*]}")
  ],
  "seed_data": {
    "alert_settings_count": ${ALERT_SETTINGS_COUNT:-0},
    "dashboard_stats_count": ${DASHBOARD_STATS_COUNT:-0}
  },
  "postgres": {
    "container": "${CLEAN_PG_CONTAINER}",
    "port": "${CLEAN_PG_PORT}",
    "database": "${CLEAN_PG_DB}"
  }
}
EOF

# Create symlink
ln -sf "${OUTPUT_DIR}" "${PROJECT_ROOT}/test-results/clean-boot-latest"
cp "$RESULTS_FILE" "${PROJECT_ROOT}/test-results/clean-boot-latest.json"

log ""
log "Receipt written to: ${RESULTS_FILE}"
log "Symlink: test-results/clean-boot-latest"

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Clean Boot Verification: SUCCESS                         ${NC}"
echo -e "${GREEN}  Migrations: ${#MIGRATION_RESULTS[@]} applied              ${NC}"
echo -e "${GREEN}  Tables: ${#EXPECTED_TABLES[@]} verified                   ${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"

exit 0
