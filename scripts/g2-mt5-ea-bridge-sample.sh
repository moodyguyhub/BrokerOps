#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Gate 2 v0 — MT5 EA HTTP Bridge Evidence Harness (no broker required)
# Produces evidence attachments + checksums
# ============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

EVIDENCE_DIR="docs/discovery/mt5-evidence"
mkdir -p "$EVIDENCE_DIR"

API_URL="${API_URL:-http://localhost:7001}"
SIDEcar_URL="${SIDECAR_URL:-http://localhost:8080}"

LOG_FILE="$EVIDENCE_DIR/ea-http-bridge-log.txt"
CONF_FILE="$EVIDENCE_DIR/mt5-terminal-config.txt"
LATENCY_FILE="$EVIDENCE_DIR/latency-sample.csv"

# Reset logs
: > "$LOG_FILE"
: > "$CONF_FILE"
: > "$LATENCY_FILE"

# ---------------------------------------------------------------------------
# 1) Preflight — record which endpoints are reachable
# ---------------------------------------------------------------------------
{
  echo "[G2] Preflight @ $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "order-api: ${API_URL}"
  echo "sidecar: ${SIDEcar_URL}"

  if curl -sf "$API_URL/health" >/dev/null 2>&1; then
    echo "order-api health: OK"
  else
    echo "order-api health: UNREACHABLE"
  fi

  if curl -sf "$SIDEcar_URL/health" >/dev/null 2>&1; then
    echo "sidecar health: OK"
  else
    echo "sidecar health: UNREACHABLE"
  fi
} >> "$LOG_FILE"

# ---------------------------------------------------------------------------
# 2) MT5 terminal config snapshot (local, non-broker)
# ---------------------------------------------------------------------------
{
  echo "[MT5] Terminal Config Snapshot"
  echo "timestamp_utc=$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "mt5_terminal_path=UNAVAILABLE (no broker terminal on this host)"
  echo "ea_name=EA_HTTP_Bridge (prototype)"
  echo "ea_mode=ADVISORY_ONLY"
  echo "broker_connection=NOT_CONFIGURED"
  echo "notes=Local evidence pack; broker inputs required for execution-grade claims"
} >> "$CONF_FILE"

# ---------------------------------------------------------------------------
# 3) EA HTTP Bridge sample — call /v1/authorize (advisory)
# ---------------------------------------------------------------------------
START_NS=$(date +%s%N)
RESPONSE=$(curl -s -w "\n---HTTP_CODE:%{http_code}---\n" \
  -X POST "$API_URL/v1/authorize" \
  -H "Content-Type: application/json" \
  -d '{
    "order": {
      "client_order_id": "g2-ea-bridge-sample",
      "symbol": "AAPL",
      "side": "BUY",
      "qty": 1,
      "price": 185.50
    },
    "context": { "client_id": "g2-local" }
  }' 2>/dev/null || echo '---HTTP_CODE:000---')
END_NS=$(date +%s%N)
LATENCY_MS=$(( (END_NS - START_NS) / 1000000 ))

{
  echo "[EA_HTTP] request_time_utc=$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "$RESPONSE"
  echo "[EA_HTTP] latency_ms=${LATENCY_MS}"
  echo "[EA_HTTP] advisory_only=true"
} >> "$LOG_FILE"

# ---------------------------------------------------------------------------
# 4) Latency samples (single-row CSV for now)
# ---------------------------------------------------------------------------
if [ ! -s "$LATENCY_FILE" ]; then
  echo "timestamp_utc,endpoint,latency_ms" >> "$LATENCY_FILE"
fi

echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ"),${API_URL}/v1/authorize,${LATENCY_MS}" >> "$LATENCY_FILE"

# ---------------------------------------------------------------------------
# 5) Checksums
# ---------------------------------------------------------------------------
(
  cd "$EVIDENCE_DIR"
  find . -type f ! -name "CHECKSUMS.sha256" | sort | xargs sha256sum > CHECKSUMS.sha256
)

echo "[G2] Evidence artifacts written to $EVIDENCE_DIR"
