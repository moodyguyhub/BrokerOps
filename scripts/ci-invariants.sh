#!/bin/bash
# CI Invariant Checks
# Run this script to verify CI invariants are maintained
# Usage: ./scripts/ci-invariants.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

FAILED=0

check() {
    local name="$1"
    local result="$2"
    if [ "$result" -eq 0 ]; then
        echo -e "${GREEN}✓${NC} $name"
    else
        echo -e "${RED}✗${NC} $name"
        FAILED=1
    fi
}

echo "=== CI Invariant Checks ==="
echo ""

# INV-001: Toolchain Version Anchoring
echo "INV-001: Toolchain Version Anchoring"
PKG_PNPM=$(grep -oP '"packageManager":\s*"pnpm@\K[^"]+' "$PROJECT_ROOT/package.json" 2>/dev/null || echo "")
if [ -n "$PKG_PNPM" ]; then
    # Check all workflow files use the same version
    WORKFLOW_MISMATCH=0
    for wf in "$PROJECT_ROOT"/.github/workflows/*.yml; do
        if grep -q "pnpm/action-setup" "$wf" 2>/dev/null; then
            # Get just the first match of version after pnpm/action-setup
            WF_PNPM=$(grep -A3 "pnpm/action-setup" "$wf" | grep -m1 'version:' | grep -oP '"\K[^"]+' || echo "")
            if [ -n "$WF_PNPM" ] && [ "$WF_PNPM" != "$PKG_PNPM" ]; then
                echo "  Mismatch: $(basename $wf) has $WF_PNPM, package.json has $PKG_PNPM"
                WORKFLOW_MISMATCH=1
            fi
        fi
    done
    check "pnpm version consistent across workflows" $WORKFLOW_MISMATCH
else
    echo "  Warning: No packageManager field in package.json"
fi
echo ""

# INV-002: No Local Absolute Paths
echo "INV-002: No Local Absolute Paths in Config"
ABSOLUTE_PATHS=$(grep -rE "^[^#]*(/home/|/Users/|C:\\\\)" "$PROJECT_ROOT"/*.yaml "$PROJECT_ROOT"/*.yml 2>/dev/null | grep -v node_modules || true)
if [ -z "$ABSOLUTE_PATHS" ]; then
    check "No absolute paths in YAML configs" 0
else
    echo "$ABSOLUTE_PATHS"
    check "No absolute paths in YAML configs" 1
fi
echo ""

# INV-003: OPA Policy Validation
echo "INV-003: OPA Policy Validation"
if [ -d "$PROJECT_ROOT/policies" ]; then
    if command -v opa &> /dev/null; then
        if opa check --strict "$PROJECT_ROOT/policies" 2>/dev/null; then
            check "OPA policies compile successfully" 0
        else
            check "OPA policies compile successfully" 1
        fi
    elif command -v docker &> /dev/null; then
        if docker run --rm -v "$PROJECT_ROOT/policies:/policies" openpolicyagent/opa:latest check --strict /policies 2>/dev/null; then
            check "OPA policies compile successfully" 0
        else
            check "OPA policies compile successfully" 1
        fi
    else
        echo "  Skipped: neither opa nor docker available"
    fi
else
    echo "  Skipped: no policies directory"
fi
echo ""

# INV-004: Service-Port Correspondence
echo "INV-004: Service-Port Correspondence"
# Extract ports from health checks in ci.yml
CI_YML="$PROJECT_ROOT/.github/workflows/ci.yml"
if [ -f "$CI_YML" ]; then
    HEALTH_PORTS=$(grep -oP 'localhost:\K700[0-9]' "$CI_YML" | sort -u)
    STARTED_SERVICES=$(grep -oP 'services/\K[^/]+(?=/dist)' "$CI_YML" | sort -u)
    
    # Map ports to services
    declare -A PORT_MAP
    PORT_MAP[7001]="order-api"
    PORT_MAP[7002]="risk-gate"
    PORT_MAP[7003]="audit-writer"
    PORT_MAP[7004]="reconstruction-api"
    PORT_MAP[7005]="economics"
    PORT_MAP[7006]="webhooks"
    
    MISSING=0
    for port in $HEALTH_PORTS; do
        SERVICE="${PORT_MAP[$port]}"
        if [ -n "$SERVICE" ]; then
            if echo "$STARTED_SERVICES" | grep -q "$SERVICE"; then
                :
            else
                echo "  Port $port ($SERVICE) checked but service not started"
                MISSING=1
            fi
        fi
    done
    check "All health-checked ports have started services" $MISSING
else
    echo "  Skipped: ci.yml not found"
fi
echo ""

# INV-005: No Nested Git Repositories
echo "INV-005: No Nested Git Repositories"
# VS Code auto-detects nested .git directories and shows phantom changes
# This invariant prevents the "10k changes but git is clean" developer trap
NESTED_GIT=$(find "$PROJECT_ROOT" -name ".git" -type d 2>/dev/null | wc -l)
if [ "$NESTED_GIT" -eq 1 ]; then
    check "Only root .git directory exists" 0
else
    echo "  Found $NESTED_GIT .git directories (expected 1):"
    find "$PROJECT_ROOT" -name ".git" -type d 2>/dev/null | grep -v "^$PROJECT_ROOT/.git$" | sed 's/^/    /'
    check "Only root .git directory exists" 1
fi
echo ""

# Summary
echo "=== Summary ==="
if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}All invariants passed${NC}"
    exit 0
else
    echo -e "${RED}Some invariants failed${NC}"
    exit 1
fi
