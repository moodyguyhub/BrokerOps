#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# P1 Test Prerequisites Script
# 
# Ensures all required infrastructure is running before P1 tests.
# 
# Requirements:
#   - Docker Compose
#   - pnpm
#
# Usage:
#   ./scripts/test-p1.sh          # Run P1 tests with auto-setup
#   ./scripts/test-p1.sh --skip-infra  # Skip infrastructure setup
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

SKIP_INFRA=false
TIMESTAMP=$(date +%Y-%m-%d-%H%M%S)

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-infra) SKIP_INFRA=true; shift ;;
    --help|-h)
      echo "Usage: $0 [--skip-infra]"
      echo ""
      echo "Options:"
      echo "  --skip-infra    Skip Docker infrastructure setup"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "=== P1 Test Runner ==="
echo "Timestamp: $TIMESTAMP"

# Step 1: Infrastructure
if [ "$SKIP_INFRA" = false ]; then
  echo ""
  echo ">>> Starting infrastructure (postgres, opa)..."
  docker compose up -d postgres opa
  
  echo ">>> Waiting for services to be ready..."
  sleep 3
  
  # Verify OPA is healthy
  if ! curl -s http://localhost:8181/health > /dev/null; then
    echo "ERROR: OPA not responding on port 8181"
    exit 1
  fi
  echo ">>> OPA healthy"
  
  # Verify Postgres is healthy
  if ! docker compose exec -T postgres pg_isready -U broker > /dev/null 2>&1; then
    echo "ERROR: Postgres not ready"
    exit 1
  fi
  echo ">>> Postgres healthy"
fi

# Step 2: Build tests
echo ""
echo ">>> Building test suite..."
pnpm --filter @broker/tests build

# Step 3: Run tests
echo ""
echo ">>> Running P1 tests..."
mkdir -p test-results

pnpm --filter @broker/tests test 2>&1 | tee "test-results/P1-CONCURRENCY-${TIMESTAMP}.log"

# Step 4: Summary
echo ""
echo "=== P1 Test Complete ==="
echo "Artifact: test-results/P1-CONCURRENCY-${TIMESTAMP}.log"
