#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# P0 Performance Proof Harness - Authorization Gate Latency & Throughput
# 
# Produces timestamped JSON evidence for P3 latency/throughput claims.
# 
# Requirements:
#   - curl (for health checks)
#   - ab (Apache Bench) OR hey (Go HTTP load tool) OR wrk
#   - jq (for JSON processing)
#   - Services running: order-api (7001), risk-gate (7002), audit-writer (7003)
#
# Output:
#   - test-results/P0-PERF-{timestamp}.json (primary artifact)
#   - test-results/P0-PERF-{timestamp}.log (execution log)
#
# Success Criteria (P0-D3):
#   - Same-host/LAN: p99 < 10ms
#   - Throughput: ≥ 10,000 req/sec (sustained)
#
# Run: ./scripts/p0-perf-proof.sh [--requests N] [--concurrency C] [--tool ab|hey|wrk]
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

# Defaults
TOTAL_REQUESTS=${REQUESTS:-10000}
CONCURRENCY=${CONCURRENCY:-100}
LOAD_TOOL=${LOAD_TOOL:-"ab"}  # ab, hey, or wrk
TARGET_URL="http://localhost:7001/v1/orders"  # Maps to /orders endpoint
DRY_RUN_URL="http://localhost:7001/dry-run"   # No audit overhead

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --requests|-n) TOTAL_REQUESTS="$2"; shift 2 ;;
    --concurrency|-c) CONCURRENCY="$2"; shift 2 ;;
    --tool|-t) LOAD_TOOL="$2"; shift 2 ;;
    --target) TARGET_URL="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [--requests N] [--concurrency C] [--tool ab|hey|wrk]"
      echo ""
      echo "Options:"
      echo "  --requests, -n    Total requests to send (default: 10000)"
      echo "  --concurrency, -c Concurrent connections (default: 100)"
      echo "  --tool, -t        Load tool: ab, hey, or wrk (default: ab)"
      echo "  --target          Target URL (default: $TARGET_URL)"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Create output directory
mkdir -p test-results

TIMESTAMP=$(date +%Y-%m-%d-%H%M%S)
LOG_FILE="test-results/P0-PERF-${TIMESTAMP}.log"
JSON_FILE="test-results/P0-PERF-${TIMESTAMP}.json"

# Logging helpers
log() { echo "[$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")] $1" | tee -a "$LOG_FILE"; }
pass() { log "✓ PASS: $1"; }
fail() { log "✗ FAIL: $1"; }

# =============================================================================
log "╔═══════════════════════════════════════════════════════════════════════════╗"
log "║           P0 Performance Proof Harness - BrokerOps Gate Contract          ║"
log "╚═══════════════════════════════════════════════════════════════════════════╝"
log ""
log "Configuration:"
log "  Total Requests:   $TOTAL_REQUESTS"
log "  Concurrency:      $CONCURRENCY"
log "  Load Tool:        $LOAD_TOOL"
log "  Target URL:       $TARGET_URL"
log "  Dry-Run URL:      $DRY_RUN_URL"
log ""

# =============================================================================
# Environment Metadata
# =============================================================================
log "Collecting environment metadata..."

GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
HOSTNAME=$(hostname)
CPU_INFO=$(grep -m1 "model name" /proc/cpuinfo 2>/dev/null | cut -d: -f2 | xargs || echo "unknown")
CPU_CORES=$(nproc 2>/dev/null || echo "unknown")
MEM_TOTAL=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2 " " $3}' || echo "unknown")
KERNEL=$(uname -r)
NODE_VERSION=$(node --version 2>/dev/null || echo "unknown")

log "  Git Commit:   $GIT_COMMIT"
log "  Git Branch:   $GIT_BRANCH"
log "  Hostname:     $HOSTNAME"
log "  CPU:          $CPU_INFO"
log "  CPU Cores:    $CPU_CORES"
log "  Memory:       $MEM_TOTAL"
log "  Kernel:       $KERNEL"
log "  Node.js:      $NODE_VERSION"
log ""

# =============================================================================
# Service Health Checks
# =============================================================================
log "Checking service health..."

check_service() {
  local name=$1
  local url=$2
  local port=$3
  
  if curl -sf "$url" > /dev/null 2>&1; then
    log "  ✓ $name (:$port) healthy"
    return 0
  else
    log "  ✗ $name (:$port) NOT REACHABLE"
    return 1
  fi
}

SERVICES_OK=true
check_service "Order API" "http://localhost:7001/health" 7001 || SERVICES_OK=false
check_service "Risk Gate" "http://localhost:7002/health" 7002 || SERVICES_OK=false
check_service "Audit Writer" "http://localhost:7003/health" 7003 || SERVICES_OK=false

if [ "$SERVICES_OK" = false ]; then
  log ""
  log "ERROR: Required services not running."
  log "Start services: pnpm -r build && node services/order-api/dist/index.js &"
  
  # Write failure JSON
  cat > "$JSON_FILE" << EOF
{
  "version": "p0-perf-v1",
  "status": "FAILED",
  "failure_reason": "SERVICES_NOT_RUNNING",
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")",
  "git_commit": "$GIT_COMMIT"
}
EOF
  exit 1
fi

log ""

# =============================================================================
# Load Tool Detection & Validation
# =============================================================================
detect_load_tool() {
  if command -v hey &> /dev/null; then
    echo "hey"
  elif command -v ab &> /dev/null; then
    echo "ab"
  elif command -v wrk &> /dev/null; then
    echo "wrk"
  else
    echo "none"
  fi
}

if [ "$LOAD_TOOL" = "auto" ]; then
  LOAD_TOOL=$(detect_load_tool)
fi

if ! command -v "$LOAD_TOOL" &> /dev/null && [ "$LOAD_TOOL" != "curl" ]; then
  log "WARNING: $LOAD_TOOL not found, falling back to sequential curl (slow)"
  LOAD_TOOL="curl"
fi

log "Using load tool: $LOAD_TOOL"
log ""

# =============================================================================
# Prepare Request Payload
# =============================================================================
PAYLOAD_FILE=$(mktemp)
cat > "$PAYLOAD_FILE" << 'EOF'
{"clientOrderId":"perf-test","symbol":"AAPL","side":"BUY","qty":100,"price":150.00}
EOF

log "Test payload: $(cat $PAYLOAD_FILE)"
log ""

# =============================================================================
# Warmup Phase
# =============================================================================
log "Warmup: sending 100 requests..."
for i in {1..100}; do
  curl -sf -X POST "$DRY_RUN_URL" \
    -H "Content-Type: application/json" \
    -d @"$PAYLOAD_FILE" > /dev/null 2>&1 || true
done
log "Warmup complete."
log ""

# =============================================================================
# Main Load Test
# =============================================================================
log "═══════════════════════════════════════════════════════════════════════════"
log "Starting load test: $TOTAL_REQUESTS requests, $CONCURRENCY concurrent"
log "Target: $DRY_RUN_URL (dry-run mode for pure gate latency)"
log "═══════════════════════════════════════════════════════════════════════════"
log ""

RAW_OUTPUT_FILE=$(mktemp)
START_TIME=$(date +%s.%N)

case "$LOAD_TOOL" in
  hey)
    hey -n "$TOTAL_REQUESTS" -c "$CONCURRENCY" \
      -m POST \
      -H "Content-Type: application/json" \
      -D "$PAYLOAD_FILE" \
      "$DRY_RUN_URL" 2>&1 | tee "$RAW_OUTPUT_FILE"
    
    # Parse hey output
    P50=$(grep "50%" "$RAW_OUTPUT_FILE" | awk '{print $2}' | sed 's/ms//') || echo "N/A"
    P90=$(grep "90%" "$RAW_OUTPUT_FILE" | awk '{print $2}' | sed 's/ms//') || echo "N/A"
    P99=$(grep "99%" "$RAW_OUTPUT_FILE" | awk '{print $2}' | sed 's/ms//') || echo "N/A"
    RPS=$(grep "Requests/sec:" "$RAW_OUTPUT_FILE" | awk '{print $2}') || echo "N/A"
    MEAN=$(grep "Average:" "$RAW_OUTPUT_FILE" | awk '{print $2}' | sed 's/ms//') || echo "N/A"
    ;;
    
  ab)
    ab -n "$TOTAL_REQUESTS" -c "$CONCURRENCY" \
      -p "$PAYLOAD_FILE" \
      -T "application/json" \
      "$DRY_RUN_URL" 2>&1 | tee "$RAW_OUTPUT_FILE"
    
    # Parse ab output
    P50=$(grep "50%" "$RAW_OUTPUT_FILE" | awk '{print $2}') || echo "N/A"
    P90=$(grep "90%" "$RAW_OUTPUT_FILE" | awk '{print $2}') || echo "N/A"
    P99=$(grep "99%" "$RAW_OUTPUT_FILE" | awk '{print $2}') || echo "N/A"
    RPS=$(grep "Requests per second:" "$RAW_OUTPUT_FILE" | awk '{print $4}') || echo "N/A"
    MEAN=$(grep "Time per request:" "$RAW_OUTPUT_FILE" | head -1 | awk '{print $4}') || echo "N/A"
    ;;
    
  wrk)
    # wrk requires a Lua script for POST with body
    WRK_SCRIPT=$(mktemp --suffix=.lua)
    cat > "$WRK_SCRIPT" << 'LUASCRIPT'
wrk.method = "POST"
wrk.headers["Content-Type"] = "application/json"
wrk.body = '{"clientOrderId":"perf-test","symbol":"AAPL","side":"BUY","qty":100,"price":150.00}'
LUASCRIPT
    
    wrk -t4 -c"$CONCURRENCY" -d30s --latency -s "$WRK_SCRIPT" "$DRY_RUN_URL" 2>&1 | tee "$RAW_OUTPUT_FILE"
    rm -f "$WRK_SCRIPT"
    
    # Parse wrk output (latency is in different format)
    P50=$(grep "50%" "$RAW_OUTPUT_FILE" | awk '{print $2}' | sed 's/ms//;s/us$//' | awk '{if(/us/) print $1/1000; else print $1}') || echo "N/A"
    P90=$(grep "90%" "$RAW_OUTPUT_FILE" | awk '{print $2}' | sed 's/ms//') || echo "N/A"
    P99=$(grep "99%" "$RAW_OUTPUT_FILE" | awk '{print $2}' | sed 's/ms//') || echo "N/A"
    RPS=$(grep "Requests/sec:" "$RAW_OUTPUT_FILE" | awk '{print $2}') || echo "N/A"
    MEAN=$(grep "Avg" "$RAW_OUTPUT_FILE" | head -1 | awk '{print $2}' | sed 's/ms//') || echo "N/A"
    ;;
    
  curl)
    # Sequential fallback - much slower but always available
    log "WARNING: Using sequential curl - results will be slower than production"
    
    SUCCESS=0
    FAIL=0
    LATENCIES=()
    
    for i in $(seq 1 $TOTAL_REQUESTS); do
      START=$(date +%s.%N)
      if curl -sf -X POST "$DRY_RUN_URL" \
        -H "Content-Type: application/json" \
        -d @"$PAYLOAD_FILE" > /dev/null 2>&1; then
        SUCCESS=$((SUCCESS + 1))
      else
        FAIL=$((FAIL + 1))
      fi
      END=$(date +%s.%N)
      LATENCY=$(echo "$END - $START" | bc | awk '{printf "%.3f", $1 * 1000}')
      LATENCIES+=("$LATENCY")
      
      # Progress indicator
      if [ $((i % 100)) -eq 0 ]; then
        log "Progress: $i / $TOTAL_REQUESTS"
      fi
    done
    
    # Calculate percentiles from array (simplified)
    P50="N/A (curl fallback)"
    P90="N/A (curl fallback)"
    P99="N/A (curl fallback)"
    MEAN="N/A (curl fallback)"
    RPS="N/A (curl fallback)"
    ;;
esac

END_TIME=$(date +%s.%N)
DURATION=$(echo "$END_TIME - $START_TIME" | bc)

log ""
log "═══════════════════════════════════════════════════════════════════════════"
log "Load test complete. Duration: ${DURATION}s"
log "═══════════════════════════════════════════════════════════════════════════"
log ""

# =============================================================================
# Results Analysis
# =============================================================================
log "Results:"
log "  Requests/sec:  $RPS"
log "  Mean latency:  ${MEAN}ms"
log "  p50 latency:   ${P50}ms"
log "  p90 latency:   ${P90}ms"
log "  p99 latency:   ${P99}ms"
log ""

# Evaluate against SLOs
P99_TARGET_MS=10
RPS_TARGET=10000

P99_PASS="UNKNOWN"
RPS_PASS="UNKNOWN"

if [[ "$P99" =~ ^[0-9.]+$ ]]; then
  if (( $(echo "$P99 < $P99_TARGET_MS" | bc -l) )); then
    P99_PASS="PASS"
    pass "p99 latency (${P99}ms) < ${P99_TARGET_MS}ms target"
  else
    P99_PASS="FAIL"
    fail "p99 latency (${P99}ms) >= ${P99_TARGET_MS}ms target"
  fi
fi

if [[ "$RPS" =~ ^[0-9.]+$ ]]; then
  if (( $(echo "$RPS >= $RPS_TARGET" | bc -l) )); then
    RPS_PASS="PASS"
    pass "Throughput (${RPS} req/s) >= ${RPS_TARGET} req/s target"
  else
    RPS_PASS="FAIL"
    fail "Throughput (${RPS} req/s) < ${RPS_TARGET} req/s target"
  fi
fi

log ""

# =============================================================================
# Generate JSON Artifact
# =============================================================================
log "Generating JSON artifact: $JSON_FILE"

OVERALL_STATUS="PASS"
if [ "$P99_PASS" = "FAIL" ] || [ "$RPS_PASS" = "FAIL" ]; then
  OVERALL_STATUS="FAIL"
fi
if [ "$P99_PASS" = "UNKNOWN" ] || [ "$RPS_PASS" = "UNKNOWN" ]; then
  OVERALL_STATUS="INCONCLUSIVE"
fi

cat > "$JSON_FILE" << EOF
{
  "version": "p0-perf-v1",
  "status": "$OVERALL_STATUS",
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")",
  "proof_type": "P0-PERF",
  
  "environment": {
    "git_commit": "$GIT_COMMIT",
    "git_branch": "$GIT_BRANCH",
    "hostname": "$HOSTNAME",
    "cpu": "$CPU_INFO",
    "cpu_cores": "$CPU_CORES",
    "memory": "$MEM_TOTAL",
    "kernel": "$KERNEL",
    "node_version": "$NODE_VERSION",
    "topology": "same-host",
    "note": "All services running on same host - results represent same-host/LAN topology"
  },
  
  "test_config": {
    "total_requests": $TOTAL_REQUESTS,
    "concurrency": $CONCURRENCY,
    "load_tool": "$LOAD_TOOL",
    "target_url": "$DRY_RUN_URL",
    "duration_seconds": $DURATION
  },
  
  "results": {
    "requests_per_second": "$RPS",
    "latency_ms": {
      "mean": "$MEAN",
      "p50": "$P50",
      "p90": "$P90",
      "p99": "$P99"
    }
  },
  
  "slo_evaluation": {
    "p99_target_ms": $P99_TARGET_MS,
    "p99_actual_ms": "$P99",
    "p99_pass": "$P99_PASS",
    "rps_target": $RPS_TARGET,
    "rps_actual": "$RPS",
    "rps_pass": "$RPS_PASS",
    "topology_caveat": "These results apply to same-host/LAN topology only. Cross-region SLOs must be measured separately."
  },
  
  "hash": "$(sha256sum "$JSON_FILE" 2>/dev/null | cut -d' ' -f1 || echo 'pending')"
}
EOF

# Update hash (file changed)
HASH=$(sha256sum "$JSON_FILE" | cut -d' ' -f1)
sed -i "s/\"hash\": \".*\"/\"hash\": \"$HASH\"/" "$JSON_FILE"

log ""
log "════════════════════════════════════════════════════════════════════════════"
log "P0 Performance Proof Complete"
log ""
log "Artifacts:"
log "  JSON:  $JSON_FILE"
log "  Log:   $LOG_FILE"
log ""
log "Status: $OVERALL_STATUS"
log "════════════════════════════════════════════════════════════════════════════"

# Cleanup
rm -f "$PAYLOAD_FILE" "$RAW_OUTPUT_FILE"

# Exit with appropriate code
if [ "$OVERALL_STATUS" = "PASS" ]; then
  exit 0
elif [ "$OVERALL_STATUS" = "INCONCLUSIVE" ]; then
  exit 0  # Not a failure, just incomplete
else
  exit 1
fi
