#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# BrokerOps Demo Shutdown Script
# Clean stop of all demo components
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

# Colors
BLUE='\033[0;34m'
GREEN='\033[0;32m'
NC='\033[0m'

log() { echo -e "${BLUE}[DEMO]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }

echo ""
log "Stopping BrokerOps demo environment..."
echo ""

# Stop Node.js services
log "Stopping Node.js services..."
pkill -f "node services/" 2>/dev/null || true
success "Node.js services stopped"

# Stop Docker containers
log "Stopping Docker containers..."
docker compose down 2>/dev/null || true
success "Docker containers stopped"

# Clean up temp logs
log "Cleaning up temp files..."
rm -rf /tmp/brokerops-demo 2>/dev/null || true
success "Temp files cleaned"

echo ""
success "Demo environment stopped cleanly"
echo ""
