#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# BrokerOps Demo Bring-Up Script
# One command to start the entire demo environment
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

log() { echo -e "${BLUE}[DEMO]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }

header() {
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}  $1${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

wait_for_health() {
  local url=$1
  local name=$2
  local max_attempts=30
  local attempt=0
  
  while [ $attempt -lt $max_attempts ]; do
    if curl -sf "$url" > /dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.5
  done
  return 1
}

# ============================================================================
header "TRUVESTA DEMO ENVIRONMENT"
# ============================================================================

echo ""
log "Starting demo environment..."
echo ""

# Step 1: Infrastructure
log "Step 1/5: Starting infrastructure (Postgres + OPA)..."
docker compose up -d --wait 2>/dev/null || docker compose up -d
sleep 2

if wait_for_health "http://localhost:8181/health" "OPA"; then
  success "OPA policy engine ready :8181"
else
  error "OPA failed to start"
  exit 1
fi

# Step 2: Database migrations
log "Step 2/5: Applying database migrations..."
for migration in infra/sql/*.sql; do
  if [ -f "$migration" ]; then
    docker exec -i broker-postgres psql -U broker -d broker < "$migration" 2>/dev/null || true
  fi
done
for migration in infra/db/migrations/*.sql; do
  if [ -f "$migration" ]; then
    docker exec -i broker-postgres psql -U broker -d broker < "$migration" 2>/dev/null || true
  fi
done
success "Database migrations applied"

# Step 3: Build services
log "Step 3/5: Building services..."
pnpm -r build --filter="@broker/*" 2>/dev/null || pnpm -r build 2>/dev/null
success "Services built"

# Step 4: Start services
log "Step 4/5: Starting services..."
pkill -f "node services/" 2>/dev/null || true
sleep 1

# Start services with log files
mkdir -p /tmp/brokerops-demo

node services/risk-gate/dist/index.js > /tmp/brokerops-demo/risk-gate.log 2>&1 &
node services/audit-writer/dist/index.js > /tmp/brokerops-demo/audit-writer.log 2>&1 &
node services/order-api/dist/index.js > /tmp/brokerops-demo/order-api.log 2>&1 &
node services/reconstruction-api/dist/index.js > /tmp/brokerops-demo/reconstruction-api.log 2>&1 &
node services/economics/dist/index.js > /tmp/brokerops-demo/economics.log 2>&1 &
node services/webhooks/dist/index.js > /tmp/brokerops-demo/webhooks.log 2>&1 &
node services/ui/server.js > /tmp/brokerops-demo/ui.log 2>&1 &

# Step 5: Health checks
log "Step 5/5: Verifying service health..."
echo ""

SERVICES_OK=true

if wait_for_health "http://localhost:7002/health" "risk-gate"; then
  success "risk-gate        :7002"
else
  error "risk-gate        :7002"
  SERVICES_OK=false
fi

if wait_for_health "http://localhost:7003/health" "audit-writer"; then
  success "audit-writer     :7003"
else
  error "audit-writer     :7003"
  SERVICES_OK=false
fi

if wait_for_health "http://localhost:7001/health" "order-api"; then
  success "order-api        :7001"
else
  error "order-api        :7001"
  SERVICES_OK=false
fi

if wait_for_health "http://localhost:7004/health" "reconstruction-api"; then
  success "reconstruction   :7004"
else
  error "reconstruction   :7004"
  SERVICES_OK=false
fi

if wait_for_health "http://localhost:7005/health" "economics"; then
  success "economics        :7005"
else
  error "economics        :7005"
  SERVICES_OK=false
fi

if wait_for_health "http://localhost:7006/health" "webhooks"; then
  success "webhooks         :7006"
else
  error "webhooks         :7006"
  SERVICES_OK=false
fi

if wait_for_health "http://localhost:3000/health" "ui"; then
  success "UI dashboard     :3000"
else
  warn "UI dashboard     :3000 (may need manual check)"
fi

echo ""

if [ "$SERVICES_OK" = true ]; then
  header "DEMO READY"
  echo ""
  echo -e "  ${BOLD}Command Center:${NC}       ${CYAN}http://localhost:3000/command-center.html${NC}"
  echo -e "  ${BOLD}Truvesta Dashboard:${NC}   ${CYAN}http://localhost:3000/truvesta.html${NC}"
  echo -e "  ${BOLD}Authorization API:${NC}    ${CYAN}http://localhost:7001/v1/authorize${NC}"
  echo -e "  ${BOLD}Reconstruction API:${NC}   ${CYAN}http://localhost:7004${NC}"
  echo -e "  ${BOLD}OPA Policy Engine:${NC}    ${CYAN}http://localhost:8181${NC}"
  echo ""
  echo -e "  ${BOLD}Next steps:${NC}"
  echo -e "    1. Open the Command Center UI in your browser"
  echo -e "    2. Run ${CYAN}./scripts/demo-scenarios.sh${NC} to execute demo scenarios"
  echo -e "    3. Run ${CYAN}./scripts/demo-evidence-pack.sh${NC} to generate proof artifacts"
  echo ""
  echo -e "  ${BOLD}Run full test suite:${NC} ${CYAN}pnpm --filter @broker/tests test${NC}"
  echo -e "  ${BOLD}To stop:${NC} ${CYAN}./scripts/demo-down.sh${NC}"
  echo ""
else
  header "DEMO STARTUP INCOMPLETE"
  echo ""
  error "Some services failed to start. Check logs in /tmp/brokerops-demo/"
  echo ""
  exit 1
fi
