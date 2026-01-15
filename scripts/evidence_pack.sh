#!/usr/bin/env bash
set -euo pipefail

# BrokerOps Evidence Pack Generator
# Creates a shareable audit artifact containing:
# - Policy file (Rego)
# - Policy test results
# - Trace bundle JSON
# - System metadata

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[EVIDENCE]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

usage() {
  echo "Usage: $0 <traceId>"
  echo ""
  echo "Generates an evidence pack for audit/compliance review."
  echo ""
  echo "Arguments:"
  echo "  traceId    The trace ID to include in the evidence pack"
  echo ""
  echo "Output:"
  echo "  evidence/trace_<traceId>.zip"
  echo ""
  echo "Example:"
  echo "  $0 1da205ae-d2c4-48d5-9d6c-bd8fbf4388ff"
  exit 1
}

if [ $# -lt 1 ]; then
  usage
fi

TRACE_ID="$1"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
EVIDENCE_DIR="evidence/trace_${TRACE_ID}_${TIMESTAMP}"
ZIP_FILE="evidence/trace_${TRACE_ID}_${TIMESTAMP}.zip"

log "Generating evidence pack for trace: $TRACE_ID"

# Create evidence directory
mkdir -p "$EVIDENCE_DIR"

# ============================================================================
# 1. Metadata
# ============================================================================
log "Collecting system metadata..."

cat > "$EVIDENCE_DIR/metadata.json" <<EOF
{
  "evidencePackVersion": "1.0",
  "generatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "traceId": "$TRACE_ID",
  "generator": "BrokerOps Evidence Pack Generator",
  "gitCommit": "$(git rev-parse HEAD 2>/dev/null || echo 'unknown')",
  "gitBranch": "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')",
  "nodeVersion": "$(node --version 2>/dev/null || echo 'unknown')",
  "hostname": "$(hostname)",
  "user": "$(whoami)"
}
EOF
success "Metadata collected"

# ============================================================================
# 2. Policy Files
# ============================================================================
log "Copying policy files..."

mkdir -p "$EVIDENCE_DIR/policy"
cp policies/*.rego "$EVIDENCE_DIR/policy/" 2>/dev/null || error "No policy files found"

# Get OPA policy version if running
if curl -sf http://localhost:8181/health > /dev/null 2>&1; then
  curl -s http://localhost:8181/v1/data/broker/risk/order/policy_version > "$EVIDENCE_DIR/policy/active_version.json" 2>/dev/null || true
fi

success "Policy files copied"

# ============================================================================
# 3. Policy Test Results
# ============================================================================
log "Running policy tests..."

mkdir -p "$EVIDENCE_DIR/tests"

# Check if OPA is running
if curl -sf http://localhost:8181/health > /dev/null 2>&1; then
  # Run tests and capture output
  cd "$ROOT_DIR"
  if pnpm --filter @broker/tests test > "$EVIDENCE_DIR/tests/test_output.txt" 2>&1; then
    echo '{"status": "PASS", "timestamp": "'$(date -u +"%Y-%m-%dT%H:%M:%SZ")'"}' > "$EVIDENCE_DIR/tests/test_result.json"
    success "Policy tests: PASS"
  else
    echo '{"status": "FAIL", "timestamp": "'$(date -u +"%Y-%m-%dT%H:%M:%SZ")'"}' > "$EVIDENCE_DIR/tests/test_result.json"
    error "Policy tests: FAIL"
  fi
else
  echo '{"status": "SKIPPED", "reason": "OPA not running", "timestamp": "'$(date -u +"%Y-%m-%dT%H:%M:%SZ")'"}' > "$EVIDENCE_DIR/tests/test_result.json"
  log "Policy tests skipped (OPA not running)"
fi

# Copy test source
cp tests/policy/*.ts "$EVIDENCE_DIR/tests/" 2>/dev/null || true

# ============================================================================
# 4. Trace Bundle
# ============================================================================
log "Fetching trace bundle..."

mkdir -p "$EVIDENCE_DIR/trace"

# Check if reconstruction API is running
if curl -sf http://localhost:7004/health > /dev/null 2>&1; then
  BUNDLE=$(curl -s "http://localhost:7004/trace/$TRACE_ID/bundle")
  
  if echo "$BUNDLE" | jq -e '.error' > /dev/null 2>&1; then
    ERROR=$(echo "$BUNDLE" | jq -r '.error')
    if [ "$ERROR" = "AUDIT_CHAIN_INTEGRITY_FAILURE" ]; then
      error "CRITICAL: Hash chain integrity failure detected!"
    else
      error "Failed to fetch bundle: $ERROR"
    fi
  fi
  
  echo "$BUNDLE" > "$EVIDENCE_DIR/trace/bundle.json"
  
  # Extract summary for quick review
  echo "$BUNDLE" | jq '.summary' > "$EVIDENCE_DIR/trace/summary.json"
  
  # Extract hash chain
  echo "$BUNDLE" | jq '.hashChain' > "$EVIDENCE_DIR/trace/hash_chain.json"
  
  # Extract events
  echo "$BUNDLE" | jq '.events' > "$EVIDENCE_DIR/trace/events.json"
  
  # Integrity check
  INTEGRITY=$(echo "$BUNDLE" | jq -r '.integrityVerified // false')
  if [ "$INTEGRITY" = "true" ]; then
    success "Trace bundle fetched (integrity verified)"
  else
    error "Trace bundle integrity NOT verified"
  fi
else
  echo '{"error": "reconstruction-api not running"}' > "$EVIDENCE_DIR/trace/bundle.json"
  log "Trace bundle skipped (reconstruction-api not running)"
fi

# ============================================================================
# 5. Raw Audit Events (direct from DB)
# ============================================================================
log "Extracting raw audit events from database..."

if docker exec broker-postgres psql -U broker -d broker -c "SELECT 1" > /dev/null 2>&1; then
  docker exec broker-postgres psql -U broker -d broker -t -A -F',' \
    -c "SELECT id, trace_id, event_type, event_version, payload_json, prev_hash, hash, created_at FROM audit_events WHERE trace_id='$TRACE_ID' ORDER BY id" \
    > "$EVIDENCE_DIR/trace/raw_events.csv" 2>/dev/null || true
  success "Raw audit events extracted"
else
  log "Raw events skipped (database not accessible)"
fi

# ============================================================================
# 5b. Economics Data
# ============================================================================
log "Fetching economics data..."

mkdir -p "$EVIDENCE_DIR/economics"

# Check if economics service is running
if curl -sf http://localhost:7005/health > /dev/null 2>&1; then
  # Trace-level economics
  curl -s "http://localhost:7005/economics/trace/$TRACE_ID" > "$EVIDENCE_DIR/economics/trace.json" 2>/dev/null || true
  
  # Global summary (for context)
  curl -s "http://localhost:7005/economics/summary" > "$EVIDENCE_DIR/economics/summary.json" 2>/dev/null || true
  
  success "Economics data fetched"
  
  # Export raw economic events for this trace from DB
  if docker exec broker-postgres psql -U broker -d broker -c "SELECT 1" > /dev/null 2>&1; then
    docker exec broker-postgres psql -U broker -d broker -t -A -F',' \
      -c "SELECT id, trace_id, event_type, gross_revenue, fees, costs, estimated_lost_revenue, currency, source, policy_id, hash, created_at FROM economic_events WHERE trace_id='$TRACE_ID' ORDER BY id" \
      > "$EVIDENCE_DIR/economics/economic_events.csv" 2>/dev/null || true
    
    # Add CSV header
    if [ -s "$EVIDENCE_DIR/economics/economic_events.csv" ]; then
      sed -i '1i id,trace_id,event_type,gross_revenue,fees,costs,estimated_lost_revenue,currency,source,policy_id,hash,created_at' "$EVIDENCE_DIR/economics/economic_events.csv"
      success "Economic events CSV exported"
    fi
  fi
else
  echo '{"error": "economics service not running"}' > "$EVIDENCE_DIR/economics/trace.json"
  log "Economics data skipped (economics service not running)"
fi

# ============================================================================
# 6. Generate Evidence Summary (human-readable)
# ============================================================================
log "Generating evidence summary..."

SUMMARY_FILE="$EVIDENCE_DIR/EVIDENCE_SUMMARY.md"

cat > "$SUMMARY_FILE" <<EOF
# Evidence Pack: $TRACE_ID

Generated: $(date -u +"%Y-%m-%d %H:%M:%S UTC")

## Trace Summary

EOF

if [ -f "$EVIDENCE_DIR/trace/summary.json" ]; then
  cat >> "$SUMMARY_FILE" <<EOF
\`\`\`json
$(cat "$EVIDENCE_DIR/trace/summary.json")
\`\`\`

EOF
fi

cat >> "$SUMMARY_FILE" <<EOF
## Hash Chain

| # | Event Type | Hash (truncated) |
|---|------------|------------------|
EOF

if [ -f "$EVIDENCE_DIR/trace/hash_chain.json" ]; then
  jq -r '.[] | "| \(.seq) | \(.eventType) | \(.hash[0:16])... |"' "$EVIDENCE_DIR/trace/hash_chain.json" >> "$SUMMARY_FILE"
fi

cat >> "$SUMMARY_FILE" <<EOF

## Integrity Verification

EOF

if [ -f "$EVIDENCE_DIR/trace/bundle.json" ]; then
  INTEGRITY=$(jq -r '.integrityVerified // "unknown"' "$EVIDENCE_DIR/trace/bundle.json")
  HASH_VALID=$(jq -r '.summary.hashChainValid // "unknown"' "$EVIDENCE_DIR/trace/bundle.json")
  cat >> "$SUMMARY_FILE" <<EOF
- **Integrity Verified**: $INTEGRITY
- **Hash Chain Valid**: $HASH_VALID
EOF
fi

cat >> "$SUMMARY_FILE" <<EOF

## Policy Test Results

EOF

if [ -f "$EVIDENCE_DIR/tests/test_result.json" ]; then
  TEST_STATUS=$(jq -r '.status' "$EVIDENCE_DIR/tests/test_result.json")
  cat >> "$SUMMARY_FILE" <<EOF
- **Status**: $TEST_STATUS
EOF
fi

cat >> "$SUMMARY_FILE" <<EOF

## Economic Impact

EOF

if [ -f "$EVIDENCE_DIR/economics/trace.json" ]; then
  ECON_ERROR=$(jq -r '.error // empty' "$EVIDENCE_DIR/economics/trace.json")
  if [ -z "$ECON_ERROR" ]; then
    ECON_REVENUE=$(jq -r '.summary.totalRevenue // 0' "$EVIDENCE_DIR/economics/trace.json")
    ECON_COSTS=$(jq -r '.summary.totalCosts // 0' "$EVIDENCE_DIR/economics/trace.json")
    ECON_LOST=$(jq -r '.summary.estimatedLostRevenue // 0' "$EVIDENCE_DIR/economics/trace.json")
    ECON_CURRENCY=$(jq -r '.summary.currency // "USD"' "$EVIDENCE_DIR/economics/trace.json")
    EVENT_COUNT=$(jq -r '.events | length' "$EVIDENCE_DIR/economics/trace.json")
    cat >> "$SUMMARY_FILE" <<EOF
- **Gross Revenue**: $ECON_CURRENCY $ECON_REVENUE
- **Total Costs**: $ECON_CURRENCY $ECON_COSTS
- **Estimated Lost Revenue**: $ECON_CURRENCY $ECON_LOST
- **Economic Events**: $EVENT_COUNT
EOF
  else
    cat >> "$SUMMARY_FILE" <<EOF
- Economics data not available ($ECON_ERROR)
EOF
  fi
fi

cat >> "$SUMMARY_FILE" <<EOF

## Files Included

- \`metadata.json\` - Generation metadata
- \`policy/\` - Rego policy files
- \`tests/\` - Policy test source and results
- \`trace/\` - Trace bundle, summary, events, hash chain
- \`economics/\` - Economic impact data (trace + summary + CSV)

---

*This evidence pack was generated by BrokerOps Evidence Pack Generator.*
*Git commit: $(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')*
EOF

success "Evidence summary generated"

# ============================================================================
# 7. Create ZIP Archive
# ============================================================================
log "Creating ZIP archive..."

cd evidence
zip -r "$(basename "$ZIP_FILE")" "$(basename "$EVIDENCE_DIR")" > /dev/null
cd "$ROOT_DIR"

# Cleanup temp directory
rm -rf "$EVIDENCE_DIR"

success "Evidence pack created: $ZIP_FILE"

# ============================================================================
# Summary
# ============================================================================
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Evidence Pack Ready${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo "  File: $ZIP_FILE"
echo "  Size: $(du -h "$ZIP_FILE" | cut -f1)"
echo ""
echo "  Contents:"
echo "    • Policy files (Rego)"
echo "    • Policy test results"
echo "    • Trace bundle (JSON)"
echo "    • Hash chain verification"
echo "    • Economic impact data"
echo "    • Human-readable summary"
echo ""
echo -e "${BLUE}Share this file with auditors/compliance for review.${NC}"
echo ""
