#!/bin/bash
# ============================================================================
# Phase 11A: Infrastructure SSE Contract Gate
# ============================================================================
# Static contract checks for SSE (Server-Sent Events) infrastructure stream
# No runtime curl checks - purely static analysis
# ============================================================================

set -uo pipefail

PASS=0
FAIL=0

check() {
  local desc="$1"
  local result="$2"
  if [[ "$result" == "PASS" ]]; then
    echo "✓ PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "✗ FAIL: $desc"
    FAIL=$((FAIL + 1))
  fi
}

SERVER_JS="services/ui/server.js"
INFRA_HTML="services/ui/public/infrastructure.html"
SHELL_HTML="services/ui/public/command-center-v2.html"

echo ""
echo "============================================"
echo "Phase 11A: Infrastructure SSE Contract Gate"
echo "============================================"
echo ""

# ----------------------------------------------------------------------------
# Section 1: Server-side SSE Endpoint Checks
# ----------------------------------------------------------------------------
echo "--- Section 1: Server SSE Endpoint ---"

# 1.1 SSE route exists
if grep -q '"/api/infrastructure/stream"' "$SERVER_JS"; then
  check "SSE route /api/infrastructure/stream exists" "PASS"
else
  check "SSE route /api/infrastructure/stream exists" "FAIL"
fi

# 1.2 SSE Content-Type header
if grep -q 'text/event-stream' "$SERVER_JS"; then
  check "SSE Content-Type header set to text/event-stream" "PASS"
else
  check "SSE Content-Type header set to text/event-stream" "FAIL"
fi

# 1.3 SSE Cache-Control no-cache
if grep -q '"Cache-Control".*no-cache' "$SERVER_JS" || grep -qP 'Cache-Control.*no-cache' "$SERVER_JS"; then
  check "SSE Cache-Control no-cache header" "PASS"
else
  check "SSE Cache-Control no-cache header" "FAIL"
fi

# 1.4 SSE Connection keep-alive
if grep -q '"Connection".*keep-alive' "$SERVER_JS" || grep -qP 'Connection.*keep-alive' "$SERVER_JS"; then
  check "SSE Connection keep-alive header" "PASS"
else
  check "SSE Connection keep-alive header" "FAIL"
fi

# 1.5 SSE flushHeaders called
if grep -q 'flushHeaders()' "$SERVER_JS"; then
  check "SSE flushHeaders() called" "PASS"
else
  check "SSE flushHeaders() called" "FAIL"
fi

# 1.6 SSE connected event sent
if grep -q 'event: connected' "$SERVER_JS"; then
  check "SSE sends connected event on connect" "PASS"
else
  check "SSE sends connected event on connect" "FAIL"
fi

# 1.7 SSE infra event sent
if grep -q 'event: infra' "$SERVER_JS"; then
  check "SSE sends infra event with payload" "PASS"
else
  check "SSE sends infra event with payload" "FAIL"
fi

# 1.8 SSE heartbeat exists
if grep -q 'heartbeat' "$SERVER_JS"; then
  check "SSE heartbeat mechanism exists" "PASS"
else
  check "SSE heartbeat mechanism exists" "FAIL"
fi

# 1.9 SSE client tracking (Set)
if grep -q 'sseClients' "$SERVER_JS"; then
  check "SSE client tracking (sseClients Set)" "PASS"
else
  check "SSE client tracking (sseClients Set)" "FAIL"
fi

# 1.10 SSE cleanup on close
if grep -q 'req.on.*close' "$SERVER_JS" || grep -qP 'req\.on\("close"' "$SERVER_JS"; then
  check "SSE cleanup on connection close" "PASS"
else
  check "SSE cleanup on connection close" "FAIL"
fi

# 1.11 SSE broadcast interval
if grep -q 'SSE_PUSH_INTERVAL' "$SERVER_JS"; then
  check "SSE broadcast interval constant defined" "PASS"
else
  check "SSE broadcast interval constant defined" "FAIL"
fi

# 1.12 SSE broadcast function
if grep -q 'startSSEBroadcast' "$SERVER_JS"; then
  check "SSE broadcast function exists" "PASS"
else
  check "SSE broadcast function exists" "FAIL"
fi

# 1.13 buildInfrastructurePayload helper
if grep -q 'buildInfrastructurePayload' "$SERVER_JS"; then
  check "buildInfrastructurePayload helper function" "PASS"
else
  check "buildInfrastructurePayload helper function" "FAIL"
fi

# 1.14 SSE shares same schema as REST
if grep -qP 'schema_version.*1' "$SERVER_JS" && grep -q 'buildInfrastructurePayload' "$SERVER_JS"; then
  check "SSE uses same payload schema as REST endpoint" "PASS"
else
  check "SSE uses same payload schema as REST endpoint" "FAIL"
fi

echo ""

# ----------------------------------------------------------------------------
# Section 2: infrastructure.html SSE Client Checks
# ----------------------------------------------------------------------------
echo "--- Section 2: infrastructure.html SSE Client ---"

# 2.1 EventSource constructor
if grep -q "EventSource('/api/infrastructure/stream')" "$INFRA_HTML" || grep -qP 'EventSource\s*\(\s*.*infrastructure/stream' "$INFRA_HTML"; then
  check "EventSource connects to /api/infrastructure/stream" "PASS"
else
  check "EventSource connects to /api/infrastructure/stream" "FAIL"
fi

# 2.2 SSE connected event listener
if grep -q "addEventListener.*connected" "$INFRA_HTML"; then
  check "Listens for SSE connected event" "PASS"
else
  check "Listens for SSE connected event" "FAIL"
fi

# 2.3 SSE infra event listener
if grep -q "addEventListener.*infra" "$INFRA_HTML"; then
  check "Listens for SSE infra event" "PASS"
else
  check "Listens for SSE infra event" "FAIL"
fi

# 2.4 SSE error handler
if grep -q "eventSource.onerror" "$INFRA_HTML" || grep -qP 'eventSource\.onerror' "$INFRA_HTML"; then
  check "SSE error handler defined" "PASS"
else
  check "SSE error handler defined" "FAIL"
fi

# 2.5 Polling fallback on SSE error
if grep -q "startPolling" "$INFRA_HTML" && grep -q "onerror" "$INFRA_HTML"; then
  check "Fallback to polling on SSE error" "PASS"
else
  check "Fallback to polling on SSE error" "FAIL"
fi

# 2.6 SSE reconnect logic
if grep -q "SSE_RECONNECT_DELAY" "$INFRA_HTML" || grep -q "sseReconnectTimer" "$INFRA_HTML"; then
  check "SSE reconnect delay/timer exists" "PASS"
else
  check "SSE reconnect delay/timer exists" "FAIL"
fi

# 2.7 sseConnected state variable
if grep -q "sseConnected" "$INFRA_HTML"; then
  check "sseConnected state tracking" "PASS"
else
  check "sseConnected state tracking" "FAIL"
fi

# 2.8 connectSSE function
if grep -q "function connectSSE" "$INFRA_HTML"; then
  check "connectSSE function defined" "PASS"
else
  check "connectSSE function defined" "FAIL"
fi

# 2.9 disconnectSSE function
if grep -q "function disconnectSSE" "$INFRA_HTML"; then
  check "disconnectSSE function defined" "PASS"
else
  check "disconnectSSE function defined" "FAIL"
fi

# 2.10 handleInfraData shared handler
if grep -q "function handleInfraData" "$INFRA_HTML"; then
  check "handleInfraData shared handler function" "PASS"
else
  check "handleInfraData shared handler function" "FAIL"
fi

# 2.11 Visibility API with SSE
if grep -q "visibilitychange" "$INFRA_HTML" && grep -q "disconnectSSE" "$INFRA_HTML"; then
  check "Visibility API pauses SSE when hidden" "PASS"
else
  check "Visibility API pauses SSE when hidden" "FAIL"
fi

# 2.12 Initial connectSSE call
if grep -q "connectSSE()" "$INFRA_HTML"; then
  check "Initial connectSSE() call on load" "PASS"
else
  check "Initial connectSSE() call on load" "FAIL"
fi

echo ""

# ----------------------------------------------------------------------------
# Section 3: command-center-v2.html SSE Client Checks
# ----------------------------------------------------------------------------
echo "--- Section 3: Shell (command-center-v2.html) SSE ---"

# 3.1 EventSource in shell
if grep -q "EventSource('/api/infrastructure/stream')" "$SHELL_HTML" || grep -qP 'EventSource\s*\(\s*.*infrastructure/stream' "$SHELL_HTML"; then
  check "Shell EventSource connects to SSE stream" "PASS"
else
  check "Shell EventSource connects to SSE stream" "FAIL"
fi

# 3.2 Shell connected event listener
if grep -q "addEventListener.*connected" "$SHELL_HTML"; then
  check "Shell listens for SSE connected event" "PASS"
else
  check "Shell listens for SSE connected event" "FAIL"
fi

# 3.3 Shell infra event listener
if grep -q "addEventListener.*infra" "$SHELL_HTML"; then
  check "Shell listens for SSE infra event" "PASS"
else
  check "Shell listens for SSE infra event" "FAIL"
fi

# 3.4 Shell SSE error handler
if grep -q "infraEventSource.onerror" "$SHELL_HTML" || grep -qP 'infraEventSource\.onerror' "$SHELL_HTML"; then
  check "Shell SSE error handler defined" "PASS"
else
  check "Shell SSE error handler defined" "FAIL"
fi

# 3.5 Shell polling fallback
if grep -q "startInfraPolling" "$SHELL_HTML" && grep -q "onerror" "$SHELL_HTML"; then
  check "Shell fallback to polling on SSE error" "PASS"
else
  check "Shell fallback to polling on SSE error" "FAIL"
fi

# 3.6 Shell SSE reconnect
if grep -q "sseReconnectTimer" "$SHELL_HTML" || grep -q "SSE_RECONNECT_DELAY" "$SHELL_HTML"; then
  check "Shell SSE reconnect mechanism" "PASS"
else
  check "Shell SSE reconnect mechanism" "FAIL"
fi

# 3.7 connectInfraSSE function
if grep -q "function connectInfraSSE" "$SHELL_HTML"; then
  check "Shell connectInfraSSE function" "PASS"
else
  check "Shell connectInfraSSE function" "FAIL"
fi

# 3.8 disconnectInfraSSE function
if grep -q "function disconnectInfraSSE" "$SHELL_HTML"; then
  check "Shell disconnectInfraSSE function" "PASS"
else
  check "Shell disconnectInfraSSE function" "FAIL"
fi

# 3.9 updateConnectionIndicator function
if grep -q "function updateConnectionIndicator" "$SHELL_HTML"; then
  check "Shell updateConnectionIndicator function" "PASS"
else
  check "Shell updateConnectionIndicator function" "FAIL"
fi

# 3.10 Shell initial SSE connect
if grep -q "connectInfraSSE()" "$SHELL_HTML"; then
  check "Shell initial connectInfraSSE() call" "PASS"
else
  check "Shell initial connectInfraSSE() call" "FAIL"
fi

# 3.11 Hysteresis preserved in shell
if grep -q "INFRA_HYSTERESIS" "$SHELL_HTML" && grep -q "infraWarnCounter" "$SHELL_HTML"; then
  check "Shell preserves hysteresis logic" "PASS"
else
  check "Shell preserves hysteresis logic" "FAIL"
fi

echo ""

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
echo "============================================"
echo "GATE_SUMMARY gate=ph11-infra-sse passed=$PASS failed=$FAIL"
echo "============================================"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
