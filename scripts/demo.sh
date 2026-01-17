#!/usr/bin/env bash
#
# TRUVESTA DEMO — Complete Demo Flow
# One command: up → scenarios → evidence pack → down
#
# Usage:
#   ./scripts/demo.sh          # Full demo flow (interactive)
#   ./scripts/demo.sh --auto   # Non-interactive (auto-cleanup)
#   ./scripts/demo.sh --up     # Start services only
#   ./scripts/demo.sh --down   # Stop services only
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Banner
print_banner() {
  echo ""
  echo -e "${CYAN}╔══════════════════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║${NC}                                                                          ${CYAN}║${NC}"
  echo -e "${CYAN}║${NC}  ${BOLD}████████╗██████╗ ██╗   ██╗██╗   ██╗███████╗███████╗████████╗ █████╗${NC}       ${CYAN}║${NC}"
  echo -e "${CYAN}║${NC}  ${BOLD}╚══██╔══╝██╔══██╗██║   ██║██║   ██║██╔════╝██╔════╝╚══██╔══╝██╔══██╗${NC}      ${CYAN}║${NC}"
  echo -e "${CYAN}║${NC}  ${BOLD}   ██║   ██████╔╝██║   ██║██║   ██║█████╗  ███████╗   ██║   ███████║${NC}      ${CYAN}║${NC}"
  echo -e "${CYAN}║${NC}  ${BOLD}   ██║   ██╔══██╗██║   ██║╚██╗ ██╔╝██╔══╝  ╚════██║   ██║   ██╔══██║${NC}      ${CYAN}║${NC}"
  echo -e "${CYAN}║${NC}  ${BOLD}   ██║   ██║  ██║╚██████╔╝ ╚████╔╝ ███████╗███████║   ██║   ██║  ██║${NC}      ${CYAN}║${NC}"
  echo -e "${CYAN}║${NC}  ${BOLD}   ╚═╝   ╚═╝  ╚═╝ ╚═════╝   ╚═══╝  ╚══════╝╚══════╝   ╚═╝   ╚═╝  ╚═╝${NC}      ${CYAN}║${NC}"
  echo -e "${CYAN}║${NC}                                                                          ${CYAN}║${NC}"
  echo -e "${CYAN}║${NC}      ${YELLOW}Decision authority here; execution remains platform-owned.${NC}         ${CYAN}║${NC}"
  echo -e "${CYAN}║${NC}                                                                          ${CYAN}║${NC}"
  echo -e "${CYAN}╚══════════════════════════════════════════════════════════════════════════╝${NC}"
  echo ""
}

# Header
header() {
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}  $1${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
}

# Parse arguments
AUTO_MODE=false
UP_ONLY=false
DOWN_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --auto)
      AUTO_MODE=true
      shift
      ;;
    --up)
      UP_ONLY=true
      shift
      ;;
    --down)
      DOWN_ONLY=true
      shift
      ;;
    -h|--help)
      echo "TRUVESTA Demo Script"
      echo ""
      echo "Usage: ./scripts/demo.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --up      Start services only (no scenarios)"
      echo "  --down    Stop services only"
      echo "  --auto    Non-interactive mode (auto-cleanup after demo)"
      echo "  -h,--help Show this help message"
      echo ""
      echo "Examples:"
      echo "  ./scripts/demo.sh          # Interactive full demo"
      echo "  ./scripts/demo.sh --up     # Just start services"
      echo "  ./scripts/demo.sh --auto   # Full demo, auto-cleanup"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Use --help for usage information"
      exit 1
      ;;
  esac
done

cd "$PROJECT_DIR"

# Down only mode
if [ "$DOWN_ONLY" = true ]; then
  echo -e "${YELLOW}Stopping demo environment...${NC}"
  ./scripts/demo-down.sh
  exit 0
fi

# Print banner
print_banner

# Step 1: Start services
header "STEP 1/3: Starting Demo Environment"
./scripts/demo-up.sh

if [ "$UP_ONLY" = true ]; then
  exit 0
fi

# ============================================================================
# PREFLIGHT: Verify order_digest is present in token (catch old builds early)
# ============================================================================
echo ""
echo -e "${YELLOW}Running preflight check...${NC}"

PREFLIGHT_RESPONSE=$(curl -sf -X POST http://localhost:7001/v1/authorize \
  -H "Content-Type: application/json" \
  -d '{"order":{"client_order_id":"preflight-check","symbol":"TEST","side":"BUY","qty":1},"context":{"client_id":"preflight"}}' 2>/dev/null || echo '{}')

if command -v jq &> /dev/null; then
  ORDER_DIGEST=$(echo "$PREFLIGHT_RESPONSE" | jq -r '.decision_token.payload.order_digest // empty' 2>/dev/null)
  if [ -z "$ORDER_DIGEST" ] || [ "$ORDER_DIGEST" = "null" ]; then
    echo ""
    echo -e "${RED}╔══════════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║  PREFLIGHT FAILED: Token missing order_digest (old build detected)       ║${NC}"
    echo -e "${RED}╠══════════════════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${RED}║  Fix: Rebuild and restart services                                       ║${NC}"
    echo -e "${RED}║       cd packages/common && pnpm tsc --build                             ║${NC}"
    echo -e "${RED}║       cd services/order-api && pnpm tsc --build                          ║${NC}"
    echo -e "${RED}║       ./scripts/demo-down.sh && ./scripts/demo-up.sh                     ║${NC}"
    echo -e "${RED}╚══════════════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    ./scripts/demo-down.sh
    exit 1
  fi
  echo -e "${GREEN}✓${NC} Preflight passed: order_digest present"
else
  echo -e "${YELLOW}!${NC} jq not installed - skipping preflight (evidence pack will still validate)"
fi

# Pause before scenarios
echo ""
echo -e "${YELLOW}Services ready. Starting demo scenarios in 3 seconds...${NC}"
sleep 3

# Step 2: Run scenarios
header "STEP 2/3: Running Demo Scenarios"
./scripts/demo-scenarios.sh

# Pause before evidence pack
echo ""
echo -e "${YELLOW}Scenarios complete. Generating evidence pack in 3 seconds...${NC}"
sleep 3

# Step 3: Generate evidence pack
header "STEP 3/3: Generating Evidence Pack"
./scripts/demo-evidence-pack.sh

# Summary
header "DEMO COMPLETE"

echo -e "  ${GREEN}✓${NC} Infrastructure: PostgreSQL + OPA"
echo -e "  ${GREEN}✓${NC} Services: 7 microservices running"
echo -e "  ${GREEN}✓${NC} Scenarios: 4 value demonstrations executed"
echo -e "  ${GREEN}✓${NC} Evidence: Pack generated with SHA256 checksums"
echo ""
echo -e "  ${BOLD}Live URLs:${NC}"
echo ""
echo -e "    ${CYAN}http://localhost:3000/command-center.html${NC}  ← Command Center"
echo -e "    ${CYAN}http://localhost:3000/truvesta.html${NC}        ← Truvesta Dashboard"
echo -e "    ${CYAN}http://localhost:7001/v1/authorize${NC}         ← Authorization API"
echo ""
echo -e "  ${BOLD}Evidence Pack:${NC}"
echo -e "    Location: ${CYAN}./evidence/demo-pack-*/CHECKSUMS.sha256${NC}"
echo ""
echo -e "  ${BOLD}Run Tests:${NC}"
echo -e "    ${CYAN}pnpm --filter @broker/tests test${NC}           ← Full test suite"
echo ""

if [ "$AUTO_MODE" = true ]; then
  echo -e "${YELLOW}Auto mode: Shutting down in 5 seconds...${NC}"
  sleep 5
  ./scripts/demo-down.sh
else
  echo -e "  ${BOLD}To stop services:${NC} ${CYAN}./scripts/demo-down.sh${NC}"
  echo ""
  echo -e "  ${YELLOW}Press Enter to stop services, or Ctrl+C to keep running...${NC}"
  read -r
  ./scripts/demo-down.sh
fi

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                       Demo complete. Thank you!                          ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════════════════╝${NC}"
echo ""
