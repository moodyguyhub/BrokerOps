#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[DEMO-KIT]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }

DEMO_KIT_DIR="test-results/demo-kit-latest"
MISSING_FILES=()

check_file() {
  local path=$1
  local desc=$2
  if [ ! -f "$path" ]; then
    MISSING_FILES+=("$desc: $path")
  fi
}

log "Looking for latest demo-pack..."
LATEST_DEMO_PACK=$(ls -1d test-results/demo-pack-* 2>/dev/null | sort | tail -1 || true)

if [ -z "$LATEST_DEMO_PACK" ] || [ ! -d "$LATEST_DEMO_PACK" ]; then
  error "No demo-pack found. Run ./scripts/ph1-demo-run.sh first."
  exit 1
fi

DEMO_PACK_NAME=$(basename "$LATEST_DEMO_PACK")
log "Found: ${DEMO_PACK_NAME}"

check_file "docs/demo/PH1-demo-choreography.md" "Demo choreography"
check_file "docs/demo/PH1-demo-brief.md" "Demo brief"
check_file "${LATEST_DEMO_PACK}/SUMMARY.md" "Demo pack summary"
check_file "test-results/ui-proof-latest/UI-CHECKLIST.md" "UI checklist"
check_file "test-results/ph1-golden-path-latest.json" "Golden path receipt"

EVIDENCE_PATH=""
if [ -f "test-results/ph1-golden-path-latest.json" ]; then
  EVIDENCE_PATH=$(jq -r '.evidence_path // ""' test-results/ph1-golden-path-latest.json)
  if [ -n "$EVIDENCE_PATH" ] && [ "$EVIDENCE_PATH" != "none" ]; then
    check_file "$EVIDENCE_PATH" "Evidence JSON"
  fi
fi

if [ ${#MISSING_FILES[@]} -gt 0 ]; then
  error "Missing required files:"
  for f in "${MISSING_FILES[@]}"; do
    echo "  - $f"
  done
  exit 1
fi

log "Creating demo kit at ${DEMO_KIT_DIR}..."
rm -rf "$DEMO_KIT_DIR"
mkdir -p "$DEMO_KIT_DIR"

cp "docs/demo/PH1-demo-choreography.md" "$DEMO_KIT_DIR/"
cp "docs/demo/PH1-demo-brief.md" "$DEMO_KIT_DIR/"
cp "${LATEST_DEMO_PACK}/SUMMARY.md" "$DEMO_KIT_DIR/DEMO-PACK-SUMMARY.md"
cp "test-results/ui-proof-latest/UI-CHECKLIST.md" "$DEMO_KIT_DIR/"
cp "test-results/ph1-golden-path-latest.json" "$DEMO_KIT_DIR/"

if [ -f "test-results/ph1-demo-run.log" ]; then
  cp "test-results/ph1-demo-run.log" "$DEMO_KIT_DIR/"
fi

if [ -n "$EVIDENCE_PATH" ] && [ "$EVIDENCE_PATH" != "none" ] && [ -f "$EVIDENCE_PATH" ]; then
  cp "$EVIDENCE_PATH" "$DEMO_KIT_DIR/EVIDENCE.json"
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > "$DEMO_KIT_DIR/README.md" <<EOF
# PH1 Demo Kit

**Generated:** ${TIMESTAMP}  
**Source demo-pack:** ${DEMO_PACK_NAME}

## Quick Start

\`\`\`bash
./scripts/ph1-demo-run.sh
\`\`\`

## Included Files

| File | Description |
|------|-------------|
| PH1-demo-choreography.md | Step-by-step demo flow |
| PH1-demo-brief.md | Single-page handout |
| DEMO-PACK-SUMMARY.md | Artifact paths and UI URLs |
| UI-CHECKLIST.md | UI verification checklist |
| ph1-golden-path-latest.json | Test receipt (PASS/FAIL) |
| ph1-demo-run.log | Demo runner output log |
| EVIDENCE.json | Hash-chained audit evidence |

## UI URLs

- All: http://localhost:3000/?server_id=all&policy_scope=all
- Server 1: http://localhost:3000/?server_id=srv-1&policy_scope=srv-1
- Server 2: http://localhost:3000/?server_id=srv-2&policy_scope=srv-2
EOF

success "Demo kit ready at: ${DEMO_KIT_DIR}/"
