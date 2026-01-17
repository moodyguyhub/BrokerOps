#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${BLUE}[PH1-DEMO]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }

require_binary() {
  local bin=$1
  local hint=$2
  if ! command -v "$bin" > /dev/null 2>&1; then
    error "$bin is required but not installed. ${hint}"
    exit 1
  fi
}

require_binary "docker" "Install Docker and retry."
require_binary "curl" "Install curl and retry."
require_binary "jq" "Install jq (e.g., apt-get install jq) and retry."

UI_PORT="${UI_PORT:-3000}"
UI_BASE="http://localhost:${UI_PORT}"
RECEIPT_FILE="test-results/ph1-golden-path-latest.json"
RUN_LOG="test-results/ph1-golden-path-run.log"
UI_CHECKLIST="test-results/ui-proof-latest/UI-CHECKLIST.md"

UI_IN_COMPOSE="false"
if docker compose config --services 2>/dev/null | grep -q '^ui$'; then
  UI_IN_COMPOSE="true"
fi

SERVICES=(lp-simulator audit-writer reconstruction-api)
if [ "$UI_IN_COMPOSE" = "true" ]; then
  SERVICES+=(ui)
fi

log "Starting services: ${SERVICES[*]}"
docker compose up -d --force-recreate "${SERVICES[@]}"

if [ "$UI_IN_COMPOSE" != "true" ]; then
  warn "UI is not containerized. Start it manually in another terminal:"
  warn "  pnpm --filter @broker/ui dev"
fi

wait_for_health() {
  local name=$1
  local url=$2
  local attempts=${3:-30}
  local wait_seconds=${4:-2}

  for ((i=1; i<=attempts; i++)); do
    status=$(curl -sS -o /dev/null -w "%{http_code}" "$url/health" || true)
    if [[ "$status" == 2* ]]; then
      success "$name is healthy"
      return 0
    fi
    sleep "$wait_seconds"
  done

  error "$name failed health check at $url/health"
  return 1
}

log "Waiting for health endpoints..."
wait_for_health "lp-simulator" "http://localhost:7010"
wait_for_health "audit-writer" "http://localhost:7003"
wait_for_health "reconstruction-api" "http://localhost:7004"

if [ "$UI_IN_COMPOSE" = "true" ]; then
  wait_for_health "ui" "$UI_BASE"
fi

log "Running golden-path test..."
set +e
./scripts/ph1-golden-path-test.sh 2>&1 | tee "$RUN_LOG"
GP_STATUS=${PIPESTATUS[0]}
set -e

if [ "$GP_STATUS" -ne 0 ]; then
  error "Golden-path test exited with status ${GP_STATUS}. See ${RUN_LOG}."
  exit 1
fi

if [ ! -f "$RECEIPT_FILE" ]; then
  error "Receipt not found at ${RECEIPT_FILE}."
  exit 1
fi

OVERALL_STATUS=$(jq -r '.overall_status // ""' "$RECEIPT_FILE")
EVIDENCE_PATH=$(jq -r '.evidence_path // ""' "$RECEIPT_FILE")

if [ "$OVERALL_STATUS" != "PASS" ]; then
  error "Receipt status is ${OVERALL_STATUS}. Demo run failed."
  exit 1
fi

TIMESTAMP=$(date -u +"%Y-%m-%d-%H%M%S")
DEMO_DIR="test-results/demo-pack-${TIMESTAMP}"
SUMMARY_FILE="${DEMO_DIR}/SUMMARY.md"
mkdir -p "$DEMO_DIR"

cat > "$SUMMARY_FILE" <<EOF
# PH1 Demo Proof Pack Summary

- Receipt: ${RECEIPT_FILE}
- Run log: ${RUN_LOG}
- Evidence JSON: ${EVIDENCE_PATH}
- UI checklist: ${UI_CHECKLIST}

## UI URLs
- All:      ${UI_BASE}/?server_id=all&policy_scope=all
- Server 1: ${UI_BASE}/?server_id=srv-1&policy_scope=srv-1
- Server 2: ${UI_BASE}/?server_id=srv-2&policy_scope=srv-2

Provenance: Demo data from lp-simulator; real multi-server mgmt Phase 2.
EOF

success "Demo summary written: ${SUMMARY_FILE}"
