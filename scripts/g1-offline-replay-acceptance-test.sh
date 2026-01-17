#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Gate 1 Offline Replay + Sync Integrity Harness
# Produces a tamper-evident evidence pack for replay determinism
# ============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Config
API_URL="${API_URL:-http://localhost:7001}"
COUNT="${G1_COUNT:-5}"
TAMPER="${G1_TAMPER:-false}"

# Timestamped pack
TIMESTAMP=$(date -u +"%Y-%m-%d-%H%M%S")
PACK_DIR="evidence/g1-pack-${TIMESTAMP}"
SPOOL_FILE="${PACK_DIR}/spool.jsonl"
CLOUD_FILE="${PACK_DIR}/cloud-store.jsonl"
REPORT_FILE="${PACK_DIR}/g1-replay-report.json"
INVARIANTS_FILE="${PACK_DIR}/g1-invariants.json"
LOG_FILE="${PACK_DIR}/g1-sync-run.log"

# Create pack dir
mkdir -p "$PACK_DIR"

# Log everything to pack log (preserve original stdout on FD 3)
exec 3>&1
exec > >(tee -a "$LOG_FILE") 2>&1

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "      GATE 1 OFFLINE REPLAY + SYNC INTEGRITY HARNESS"
echo "═══════════════════════════════════════════════════════════════"
echo ""

echo "[G1] Pack: $PACK_DIR"

echo "[G1] Preflight: checking tools..."
command -v node >/dev/null 2>&1 || { echo "[G1] ERROR: node required"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "[G1] ERROR: jq required"; exit 1; }

# Preflight API
if ! curl -sf "$API_URL/health" >/dev/null 2>&1; then
  echo "[G1] ERROR: order-api not reachable at $API_URL"
  exit 1
fi

echo "[G1] Capture: generating $COUNT decisions"

# Helper: build event with canonical hash + chain
cat > "${PACK_DIR}/_event-builder.mjs" << 'NODE'
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';

const responsePath = process.argv[2];
const prevHash = process.argv[3] || '';
const response = JSON.parse(fs.readFileSync(responsePath, 'utf8'));

const payload = response.decision_token?.payload || {};
const order = payload.order || {};

// Canonical decision payload (exclude nondeterministic fields)
const canonical = {
  trace_id: payload.trace_id,
  decision: payload.decision,
  reason_code: payload.reason_code,
  rule_ids: payload.rule_ids || [],
  policy_snapshot_hash: payload.policy_snapshot_hash,
  order_digest: payload.order_digest,
  order_digest_version: payload.order_digest_version,
  order: {
    client_order_id: order.client_order_id,
    symbol: order.symbol,
    side: order.side,
    qty: order.qty,
    price: order.price ?? null
  },
  subject: payload.subject,
  audience: payload.audience
};

const canonicalJson = JSON.stringify(canonical);
const decisionHash = createHash('sha256').update(canonicalJson).digest('hex');
const eventId = randomUUID();
const chainHash = createHash('sha256').update(`${prevHash}|${eventId}|${decisionHash}`).digest('hex');

const event = {
  event_id: eventId,
  idempotency_key: `g1:${eventId}`,
  trace_id: payload.trace_id,
  captured_at: new Date().toISOString(),
  decision_hash: decisionHash,
  decision_payload: canonical,
  chain: {
    prev_hash: prevHash || null,
    hash: chainHash
  }
};

process.stdout.write(JSON.stringify(event));
NODE

PREV_HASH=""
for i in $(seq 1 "$COUNT"); do
  ORDER_ID="g1-${TIMESTAMP}-${i}"
  RESPONSE_FILE="${PACK_DIR}/authorize-response-${i}.json"

  curl -s -X POST "$API_URL/v1/authorize" \
    -H "Content-Type: application/json" \
    -d "{\"order\":{\"client_order_id\":\"${ORDER_ID}\",\"symbol\":\"AAPL\",\"side\":\"BUY\",\"qty\":100,\"price\":185.5},\"context\":{\"client_id\":\"g1-harness\"}}" \
    > "$RESPONSE_FILE"

  EVENT_JSON=$(node "${PACK_DIR}/_event-builder.mjs" "$RESPONSE_FILE" "$PREV_HASH")
  echo "$EVENT_JSON" >> "$SPOOL_FILE"

  PREV_HASH=$(echo "$EVENT_JSON" | jq -r '.chain.hash')
  echo "[G1] Captured event $i trace_id=$(echo "$EVENT_JSON" | jq -r '.trace_id')"
done

# Optional tamper (for negative testing)
if [ "$TAMPER" = "true" ]; then
  echo "[G1] Tamper: enabled (modifying first event decision_hash)"
  node - "$SPOOL_FILE" <<'NODE'
import fs from 'fs';
const file = process.argv[2];
const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
if (lines.length > 0) {
  const evt = JSON.parse(lines[0]);
  evt.decision_hash = evt.decision_hash.replace(/^./, evt.decision_hash[0] === 'a' ? 'b' : 'a');
  lines[0] = JSON.stringify(evt);
  fs.writeFileSync(file, lines.join('\n') + '\n');
}
NODE
fi

# Sync to cloud store (idempotent)
node - "${SPOOL_FILE}" "${CLOUD_FILE}" <<'NODE'
import fs from 'fs';
const spool = process.argv[2];
const cloud = process.argv[3];

const spoolLines = fs.readFileSync(spool, 'utf8').trim().split('\n').filter(Boolean);
let cloudLines = [];
if (fs.existsSync(cloud)) {
  cloudLines = fs.readFileSync(cloud, 'utf8').trim().split('\n').filter(Boolean);
}

const existing = new Set(cloudLines.map(l => JSON.parse(l).event_id));
let duplicates = 0;

for (const line of spoolLines) {
  const evt = JSON.parse(line);
  if (existing.has(evt.event_id)) {
    duplicates++;
    continue;
  }
  cloudLines.push(line);
  existing.add(evt.event_id);
}

fs.writeFileSync(cloud, cloudLines.join('\n') + (cloudLines.length ? '\n' : ''));
console.log(JSON.stringify({ duplicate_attempts: duplicates }));
NODE

# Re-sync to prove idempotency
SYNC_RESULT=$(node - "${SPOOL_FILE}" "${CLOUD_FILE}" <<'NODE'
import fs from 'fs';
const spool = process.argv[2];
const cloud = process.argv[3];

const spoolLines = fs.readFileSync(spool, 'utf8').trim().split('\n').filter(Boolean);
let cloudLines = [];
if (fs.existsSync(cloud)) {
  cloudLines = fs.readFileSync(cloud, 'utf8').trim().split('\n').filter(Boolean);
}

const existing = new Set(cloudLines.map(l => JSON.parse(l).event_id));
let duplicates = 0;

for (const line of spoolLines) {
  const evt = JSON.parse(line);
  if (existing.has(evt.event_id)) {
    duplicates++;
    continue;
  }
  cloudLines.push(line);
  existing.add(evt.event_id);
}

fs.writeFileSync(cloud, cloudLines.join('\n') + (cloudLines.length ? '\n' : ''));
process.stdout.write(JSON.stringify({ duplicate_attempts: duplicates }));
NODE
)

DUPLICATE_ATTEMPTS=$(echo "$SYNC_RESULT" | jq -r '.duplicate_attempts')

# Count duplicates in cloud store (should be zero if idempotent)
CLOUD_DUPLICATE_COUNT=$(node - "${CLOUD_FILE}" <<'NODE'
import fs from 'fs';
const cloud = process.argv[2];
const lines = fs.readFileSync(cloud, 'utf8').trim().split('\n').filter(Boolean);
const seen = new Set();
let dupes = 0;
for (const line of lines) {
  const e = JSON.parse(line);
  if (seen.has(e.event_id)) dupes++;
  seen.add(e.event_id);
}
process.stdout.write(String(dupes));
NODE
)

# Replay verification
REPLAY_RESULT=$(node - "${SPOOL_FILE}" "${CLOUD_FILE}" <<'NODE'
import fs from 'fs';
import { createHash } from 'crypto';

const spool = process.argv[2];
const cloud = process.argv[3];

const spoolLines = fs.readFileSync(spool, 'utf8').trim().split('\n').filter(Boolean);
const cloudLines = fs.readFileSync(cloud, 'utf8').trim().split('\n').filter(Boolean);

const spoolMap = new Map(spoolLines.map(l => {
  const e = JSON.parse(l);
  return [e.event_id, e];
}));

let mismatches = 0;
let chainBroken = false;

// Verify chain in spool
let prevHash = null;
for (const line of spoolLines) {
  const e = JSON.parse(line);
  const expected = createHash('sha256').update(`${prevHash ?? ''}|${e.event_id}|${e.decision_hash}`).digest('hex');
  if (e.chain?.hash !== expected || e.chain?.prev_hash !== prevHash) {
    chainBroken = true;
    break;
  }
  prevHash = e.chain?.hash ?? null;
}

for (const line of cloudLines) {
  const cloudEvt = JSON.parse(line);
  const localEvt = spoolMap.get(cloudEvt.event_id);
  if (!localEvt || localEvt.decision_hash !== cloudEvt.decision_hash) {
    mismatches++;
  }
}

const status = (mismatches === 0 && !chainBroken) ? 'PASS' : 'FAIL';
const reason_code = status === 'PASS' ? null : 'REPLAY_INTEGRITY_FAILURE';

process.stdout.write(JSON.stringify({
  spool_events: spoolLines.length,
  cloud_events: cloudLines.length,
  mismatches,
  chain_broken: chainBroken,
  status,
  reason_code
}));
NODE
)

# Write report
cat > "$REPORT_FILE" <<EOF
{
  "generated_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "spool_events": $(echo "$REPLAY_RESULT" | jq -r '.spool_events'),
  "cloud_events": $(echo "$REPLAY_RESULT" | jq -r '.cloud_events'),
  "duplicate_count": ${CLOUD_DUPLICATE_COUNT},
  "duplicate_attempts": ${DUPLICATE_ATTEMPTS},
  "mismatches": $(echo "$REPLAY_RESULT" | jq -r '.mismatches'),
  "chain_broken": $(echo "$REPLAY_RESULT" | jq -r '.chain_broken'),
  "status": "$(echo "$REPLAY_RESULT" | jq -r '.status')",
  "reason_code": $(echo "$REPLAY_RESULT" | jq -r '.reason_code | @json')
}
EOF

# Invariants
IDEMPOTENCY_PASS=false
REPLAY_PASS=false
CHAIN_PASS=false

if [ "${CLOUD_DUPLICATE_COUNT}" = "0" ]; then IDEMPOTENCY_PASS=true; fi
if [ "$(echo "$REPLAY_RESULT" | jq -r '.mismatches')" = "0" ]; then REPLAY_PASS=true; fi
if [ "$(echo "$REPLAY_RESULT" | jq -r '.chain_broken')" = "false" ]; then CHAIN_PASS=true; fi

cat > "$INVARIANTS_FILE" <<EOF
{
  "generated_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "status": "$(echo "$REPLAY_RESULT" | jq -r '.status')",
  "reason_code": $(echo "$REPLAY_RESULT" | jq -r '.reason_code | @json'),
  "invariants": [
    {
      "id": "idempotency",
      "pass": ${IDEMPOTENCY_PASS},
      "details": { "duplicate_count": ${CLOUD_DUPLICATE_COUNT}, "duplicate_attempts": ${DUPLICATE_ATTEMPTS} }
    },
    {
      "id": "replay_determinism",
      "pass": ${REPLAY_PASS},
      "details": { "mismatch_count": $(echo "$REPLAY_RESULT" | jq -r '.mismatches') }
    },
    {
      "id": "integrity_chain",
      "pass": ${CHAIN_PASS},
      "details": { "chain_broken": $(echo "$REPLAY_RESULT" | jq -r '.chain_broken') }
    }
  ]
}
EOF

# Stop logging to file before generating checksums to keep log stable
exec >&3 2>&1

# Checksums (do not emit output that would mutate g1-sync-run.log)
(
  cd "$PACK_DIR"
  find . -type f ! -name "CHECKSUMS.sha256" | sort | xargs sha256sum > CHECKSUMS.sha256
)

echo ""
echo "[G1] Evidence pack complete: $PACK_DIR"
echo "[G1] Report: $(basename "$REPORT_FILE")"
echo "[G1] Invariants: $(basename "$INVARIANTS_FILE")"
echo "[G1] Checksums: CHECKSUMS.sha256"

echo ""
echo "[G1] Status: $(jq -r '.status' "$REPORT_FILE")"
if [ "$(jq -r '.status' "$REPORT_FILE")" != "PASS" ]; then
  echo "[G1] FAIL-CLOSED: reason_code=$(jq -r '.reason_code' "$REPORT_FILE")"
  exit 1
fi
