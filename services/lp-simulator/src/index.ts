/**
 * Phase 1 LP Simulator
 * 
 * Emits lp.order.* events per PH1-unified-data-layer.md spec.
 * Used for demo/testing before real LP integration.
 * 
 * Modes:
 * - API mode: POST /simulate to trigger scenarios
 * - Programmatic: import and call scenario functions
 * - Background: Emits LP account snapshots every LP_SNAPSHOT_INTERVAL_MS
 */

import express, { type Express } from "express";
import {
  createLpOrderEvent,
  type LpOrderEvent,
  type Source,
  type Correlation,
  type OrderPayload,
  type NormalizedStatus,
  type LpOrderEventType,
  type SourceKind,
  type LpAccountSnapshotPayload
} from "@broker/common";
import { v4 as uuidv4 } from "uuid";

const app: Express = express();
app.use(express.json());

// ============================================================================
// Configuration
// ============================================================================

const AUDIT_WRITER_URL = process.env.AUDIT_WRITER_URL ?? "http://localhost:7003";
const SIM_PORT = process.env.SIM_PORT ? Number(process.env.SIM_PORT) : 7010;
const LP_SNAPSHOT_INTERVAL_MS = process.env.LP_SNAPSHOT_INTERVAL_MS 
  ? Number(process.env.LP_SNAPSHOT_INTERVAL_MS) 
  : 5000; // Default 5 seconds
const LP_SNAPSHOT_ENABLED = process.env.LP_SNAPSHOT_ENABLED !== "false"; // Default enabled

// Simulated LP accounts with realistic state
interface SimulatedLpAccount {
  lp_id: string;
  lp_name: string;
  server_id: string;
  server_name: string;
  balance: number;
  equity: number;
  margin: number;
  free_margin: number;
  margin_level: number | null;
  currency: string;
  status: "CONNECTED" | "DISCONNECTED" | "UNKNOWN";
  open_positions: number;
  open_orders: number;
  // Drift parameters for realistic simulation
  balanceDrift: number;
  volatility: number;
}

const LP_ACCOUNTS: SimulatedLpAccount[] = [
  {
    lp_id: "LP-A",
    lp_name: "Prime Broker Alpha",
    server_id: "srv-1",
    server_name: "Server 1",
    balance: 100000.00,
    equity: 98500.00,
    margin: 12000.00,
    free_margin: 86500.00,
    margin_level: 820.83,
    currency: "USD",
    status: "CONNECTED",
    open_positions: 3,
    open_orders: 5,
    balanceDrift: 0.0001,
    volatility: 0.005
  },
  {
    lp_id: "LP-B",
    lp_name: "Global Markets Beta",
    server_id: "srv-1",
    server_name: "Server 1",
    balance: 250000.00,
    equity: 248000.00,
    margin: 45000.00,
    free_margin: 203000.00,
    margin_level: 551.11,
    currency: "USD",
    status: "CONNECTED",
    open_positions: 8,
    open_orders: 12,
    balanceDrift: 0.00015,
    volatility: 0.008
  },
  {
    lp_id: "LP-C",
    lp_name: "Institutional Gamma",
    server_id: "srv-2",
    server_name: "Server 2",
    balance: 500000.00,
    equity: 495000.00,
    margin: 75000.00,
    free_margin: 420000.00,
    margin_level: 660.00,
    currency: "USD",
    status: "CONNECTED",
    open_positions: 15,
    open_orders: 20,
    balanceDrift: 0.0002,
    volatility: 0.01
  }
];

const SIM_SOURCE: Source = {
  kind: "SIM" as SourceKind,
  name: "truvesta-sim-v1",
  adapter_version: "1.0.0",
  server_id: "srv-1",
  server_name: "Server 1"
};

function buildSource(serverId?: string, serverName?: string): Source {
  return {
    ...SIM_SOURCE,
    server_id: serverId ?? SIM_SOURCE.server_id,
    server_name: serverName ?? SIM_SOURCE.server_name
  };
}

// ============================================================================
// Event Emission
// ============================================================================

interface EmitResult {
  success: boolean;
  event_id: string;
  hash?: string;
  error?: string;
}

async function emitToAuditWriter(event: LpOrderEvent): Promise<EmitResult> {
  try {
    const response = await fetch(`${AUDIT_WRITER_URL}/lp-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, event_id: event.event_id, error };
    }

    const result = await response.json() as { hash?: string };
    return { success: true, event_id: event.event_id, hash: result.hash };
  } catch (err) {
    return { 
      success: false, 
      event_id: event.event_id, 
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

// ============================================================================
// LP Account Snapshot Emission
// ============================================================================

interface LpAccountSnapshotEvent {
  event_id: string;
  event_type: "lp.account.snapshot";
  event_version: number;
  source: Source;
  occurred_at: string;
  payload: LpAccountSnapshotPayload;
}

/**
 * Update LP account state with realistic drift/volatility
 */
function updateLpAccountState(account: SimulatedLpAccount): void {
  // Random walk for equity
  const equityChange = account.equity * account.volatility * (Math.random() - 0.5) * 2;
  account.equity = Math.max(account.equity + equityChange, 0);
  
  // Gradual balance drift
  account.balance += account.balance * account.balanceDrift * (Math.random() - 0.3);
  
  // Margin fluctuates with positions
  const marginChange = account.margin * 0.02 * (Math.random() - 0.5) * 2;
  account.margin = Math.max(account.margin + marginChange, 0);
  
  // Recalculate derived values
  account.free_margin = account.equity - account.margin;
  account.margin_level = account.margin > 0 
    ? (account.equity / account.margin) * 100 
    : null;
  
  // Occasionally change position/order counts
  if (Math.random() > 0.9) {
    account.open_positions = Math.max(0, account.open_positions + Math.floor(Math.random() * 3) - 1);
  }
  if (Math.random() > 0.8) {
    account.open_orders = Math.max(0, account.open_orders + Math.floor(Math.random() * 5) - 2);
  }
}

/**
 * Create and emit LP account snapshot event
 */
async function emitLpAccountSnapshot(account: SimulatedLpAccount): Promise<EmitResult> {
  const eventId = uuidv4();
  const now = new Date().toISOString();
  
  const event: LpAccountSnapshotEvent = {
    event_id: eventId,
    event_type: "lp.account.snapshot",
    event_version: 1,
    source: {
      kind: "SIM" as SourceKind,
      name: "truvesta-sim-v1",
      adapter_version: "1.0.0",
      server_id: account.server_id,
      server_name: account.server_name
    },
    occurred_at: now,
    payload: {
      lp_id: account.lp_id,
      lp_name: account.lp_name,
      balance: Math.round(account.balance * 100) / 100,
      equity: Math.round(account.equity * 100) / 100,
      margin: Math.round(account.margin * 100) / 100,
      free_margin: Math.round(account.free_margin * 100) / 100,
      margin_level: account.margin_level ? Math.round(account.margin_level * 100) / 100 : null,
      currency: account.currency,
      status: account.status,
      open_positions: account.open_positions,
      open_orders: account.open_orders
    }
  };

  try {
    const response = await fetch(`${AUDIT_WRITER_URL}/lp-account-snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, event_id: eventId, error };
    }

    return { success: true, event_id: eventId };
  } catch (err) {
    return { 
      success: false, 
      event_id: eventId, 
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * Background loop to emit LP account snapshots
 */
let snapshotIntervalId: ReturnType<typeof setInterval> | null = null;
let snapshotEmitCount = 0;

function startLpSnapshotLoop(): void {
  if (!LP_SNAPSHOT_ENABLED) {
    console.log("LP snapshot emission disabled");
    return;
  }
  
  console.log(`Starting LP snapshot loop (interval: ${LP_SNAPSHOT_INTERVAL_MS}ms)`);
  
  snapshotIntervalId = setInterval(async () => {
    for (const account of LP_ACCOUNTS) {
      // Update state with realistic drift
      updateLpAccountState(account);
      
      // Emit snapshot
      const result = await emitLpAccountSnapshot(account);
      if (result.success) {
        snapshotEmitCount++;
      } else {
        console.error(`Failed to emit snapshot for ${account.lp_id}: ${result.error}`);
      }
    }
  }, LP_SNAPSHOT_INTERVAL_MS);
}

function stopLpSnapshotLoop(): void {
  if (snapshotIntervalId) {
    clearInterval(snapshotIntervalId);
    snapshotIntervalId = null;
    console.log("Stopped LP snapshot loop");
  }
}

// ============================================================================
// Scenario Definitions
// ============================================================================

export interface ScenarioResult {
  scenario_id: string;
  trace_id: string;
  events: LpOrderEvent[];
  emit_results: EmitResult[];
  final_status: NormalizedStatus;
  success: boolean;
}

/**
 * Scenario: Submit → Accept → Fill (happy path)
 */
export async function scenarioFullFill(
  traceId: string,
  order: { symbol: string; side: "BUY" | "SELL"; qty: number; price: number },
  clientOrderId?: string,
  serverId?: string,
  serverName?: string
): Promise<ScenarioResult> {
  const source = buildSource(serverId, serverName);
  const events: LpOrderEvent[] = [];
  const results: EmitResult[] = [];
  let prevHash: string | null = null;

  const correlation: Correlation = {
    trace_id: traceId,
    client_order_id: clientOrderId ?? `SIM-${Date.now()}`,
    lp_order_id: null,
    order_digest: null,
    decision_token_id: traceId
  };

  const payload: OrderPayload = {
    symbol: order.symbol,
    side: order.side,
    qty: order.qty,
    price: order.price,
    order_type: "LIMIT"
  };

  // Event 1: Submitted
  const submitted = createLpOrderEvent({
    event_type: "lp.order.submitted",
    source,
    correlation,
    payload,
    status: "SUBMITTED",
    prev_event_hash: prevHash
  });
  events.push(submitted);
  const r1 = await emitToAuditWriter(submitted);
  results.push(r1);
  prevHash = submitted.integrity?.payload_hash ?? null;

  // Simulate LP processing delay
  await sleep(50);

  // Event 2: Accepted
  const lpOrderId = `LP-${Date.now()}`;
  const accepted = createLpOrderEvent({
    event_type: "lp.order.accepted",
    source,
    correlation: { ...correlation, lp_order_id: lpOrderId },
    payload,
    status: "ACCEPTED",
    prev_event_hash: prevHash
  });
  events.push(accepted);
  const r2 = await emitToAuditWriter(accepted);
  results.push(r2);
  prevHash = accepted.integrity?.payload_hash ?? null;

  // Simulate fill delay
  await sleep(100);

  // Event 3: Filled
  const fillPrice = order.price * (1 + (Math.random() * 0.001 - 0.0005)); // Small slippage
  const filled = createLpOrderEvent({
    event_type: "lp.order.filled",
    source,
    correlation: { ...correlation, lp_order_id: lpOrderId },
    payload: {
      ...payload,
      fill_qty: order.qty,
      fill_price: fillPrice,
      remaining_qty: 0
    },
    status: "FILLED",
    prev_event_hash: prevHash
  });
  events.push(filled);
  const r3 = await emitToAuditWriter(filled);
  results.push(r3);

  return {
    scenario_id: "full-fill",
    trace_id: traceId,
    events,
    emit_results: results,
    final_status: "FILLED",
    success: results.every(r => r.success)
  };
}

/**
 * Scenario: Submit → Reject (with normalized reason)
 */
export async function scenarioRejection(
  traceId: string,
  order: { symbol: string; side: "BUY" | "SELL"; qty: number; price: number },
  rejectReason: {
    code: string;
    message: string;
    fields?: Record<string, unknown>;
  },
  clientOrderId?: string,
  serverId?: string,
  serverName?: string
): Promise<ScenarioResult> {
  const source = buildSource(serverId, serverName);
  const events: LpOrderEvent[] = [];
  const results: EmitResult[] = [];
  let prevHash: string | null = null;

  const correlation: Correlation = {
    trace_id: traceId,
    client_order_id: clientOrderId ?? `SIM-${Date.now()}`,
    lp_order_id: null,
    order_digest: null,
    decision_token_id: traceId
  };

  const payload: OrderPayload = {
    symbol: order.symbol,
    side: order.side,
    qty: order.qty,
    price: order.price,
    order_type: "LIMIT"
  };

  // Event 1: Submitted
  const submitted = createLpOrderEvent({
    event_type: "lp.order.submitted",
    source,
    correlation,
    payload,
    status: "SUBMITTED",
    prev_event_hash: prevHash
  });
  events.push(submitted);
  const r1 = await emitToAuditWriter(submitted);
  results.push(r1);
  prevHash = submitted.integrity?.payload_hash ?? null;

  // Simulate LP processing delay
  await sleep(50);

  // Event 2: Rejected
  const rejected = createLpOrderEvent({
    event_type: "lp.order.rejected",
    source,
    correlation: { ...correlation, lp_order_id: `LP-${Date.now()}` },
    payload,
    status: "REJECTED",
    reason: {
      source_kind: "SIM",
      provider_code: rejectReason.code,
      provider_message: rejectReason.message,
      provider_fields: rejectReason.fields
    },
    prev_event_hash: prevHash
  });
  events.push(rejected);
  const r2 = await emitToAuditWriter(rejected);
  results.push(r2);

  return {
    scenario_id: "rejection",
    trace_id: traceId,
    events,
    emit_results: results,
    final_status: "REJECTED",
    success: results.every(r => r.success)
  };
}

/**
 * Scenario: Submit → Accept → Partial Fill → Partial Fill → Fill
 */
export async function scenarioPartialFills(
  traceId: string,
  order: { symbol: string; side: "BUY" | "SELL"; qty: number; price: number },
  fillPcts: number[] = [0.4, 0.35, 0.25], // Must sum to 1
  clientOrderId?: string,
  serverId?: string,
  serverName?: string
): Promise<ScenarioResult> {
  const source = buildSource(serverId, serverName);
  const events: LpOrderEvent[] = [];
  const results: EmitResult[] = [];
  let prevHash: string | null = null;

  const correlation: Correlation = {
    trace_id: traceId,
    client_order_id: clientOrderId ?? `SIM-${Date.now()}`,
    lp_order_id: null,
    order_digest: null,
    decision_token_id: traceId
  };

  const payload: OrderPayload = {
    symbol: order.symbol,
    side: order.side,
    qty: order.qty,
    price: order.price,
    order_type: "LIMIT"
  };

  // Event 1: Submitted
  const submitted = createLpOrderEvent({
    event_type: "lp.order.submitted",
    source,
    correlation,
    payload,
    status: "SUBMITTED",
    prev_event_hash: prevHash
  });
  events.push(submitted);
  results.push(await emitToAuditWriter(submitted));
  prevHash = submitted.integrity?.payload_hash ?? null;

  await sleep(30);

  // Event 2: Accepted
  const lpOrderId = `LP-${Date.now()}`;
  const accepted = createLpOrderEvent({
    event_type: "lp.order.accepted",
    source,
    correlation: { ...correlation, lp_order_id: lpOrderId },
    payload,
    status: "ACCEPTED",
    prev_event_hash: prevHash
  });
  events.push(accepted);
  results.push(await emitToAuditWriter(accepted));
  prevHash = accepted.integrity?.payload_hash ?? null;

  // Partial fills
  let filledQty = 0;
  for (let i = 0; i < fillPcts.length; i++) {
    await sleep(50 + Math.random() * 50);
    
    const fillQty = Math.floor(order.qty * fillPcts[i]);
    filledQty += fillQty;
    const remaining = order.qty - filledQty;
    const isLast = i === fillPcts.length - 1 || remaining <= 0;
    
    const fillPrice = order.price * (1 + (Math.random() * 0.002 - 0.001));
    
    const fillEvent = createLpOrderEvent({
      event_type: isLast ? "lp.order.filled" : "lp.order.partially_filled",
      source,
      correlation: { ...correlation, lp_order_id: lpOrderId },
      payload: {
        ...payload,
        fill_qty: fillQty,
        fill_price: fillPrice,
        remaining_qty: Math.max(0, remaining)
      },
      status: isLast ? "FILLED" : "PARTIALLY_FILLED",
      prev_event_hash: prevHash
    });
    events.push(fillEvent);
    results.push(await emitToAuditWriter(fillEvent));
    prevHash = fillEvent.integrity?.payload_hash ?? null;
    
    if (isLast) break;
  }

  return {
    scenario_id: "partial-fills",
    trace_id: traceId,
    events,
    emit_results: results,
    final_status: "FILLED",
    success: results.every(r => r.success)
  };
}

/**
 * Scenario: Submit → Accept → Cancel
 */
export async function scenarioCancellation(
  traceId: string,
  order: { symbol: string; side: "BUY" | "SELL"; qty: number; price: number },
  clientOrderId?: string,
  serverId?: string,
  serverName?: string
): Promise<ScenarioResult> {
  const source = buildSource(serverId, serverName);
  const events: LpOrderEvent[] = [];
  const results: EmitResult[] = [];
  let prevHash: string | null = null;

  const correlation: Correlation = {
    trace_id: traceId,
    client_order_id: clientOrderId ?? `SIM-${Date.now()}`,
    lp_order_id: null,
    order_digest: null,
    decision_token_id: traceId
  };

  const payload: OrderPayload = {
    symbol: order.symbol,
    side: order.side,
    qty: order.qty,
    price: order.price,
    order_type: "LIMIT"
  };

  // Submitted
  const submitted = createLpOrderEvent({
    event_type: "lp.order.submitted",
    source,
    correlation,
    payload,
    status: "SUBMITTED",
    prev_event_hash: prevHash
  });
  events.push(submitted);
  results.push(await emitToAuditWriter(submitted));
  prevHash = submitted.integrity?.payload_hash ?? null;

  await sleep(30);

  // Accepted
  const lpOrderId = `LP-${Date.now()}`;
  const accepted = createLpOrderEvent({
    event_type: "lp.order.accepted",
    source,
    correlation: { ...correlation, lp_order_id: lpOrderId },
    payload,
    status: "ACCEPTED",
    prev_event_hash: prevHash
  });
  events.push(accepted);
  results.push(await emitToAuditWriter(accepted));
  prevHash = accepted.integrity?.payload_hash ?? null;

  await sleep(100);

  // Canceled
  const canceled = createLpOrderEvent({
    event_type: "lp.order.canceled",
    source,
    correlation: { ...correlation, lp_order_id: lpOrderId },
    payload: { ...payload, remaining_qty: order.qty },
    status: "CANCELED",
    prev_event_hash: prevHash
  });
  events.push(canceled);
  results.push(await emitToAuditWriter(canceled));

  return {
    scenario_id: "cancellation",
    trace_id: traceId,
    events,
    emit_results: results,
    final_status: "CANCELED",
    success: results.every(r => r.success)
  };
}

// ============================================================================
// Golden Path Scenario (Deterministic)
// ============================================================================

/**
 * Golden Path scenario for acceptance testing
 * Uses fixed timestamps and IDs for deterministic replay
 */
export async function goldenPathScenario(
  baseTimestamp: string = "2026-01-16T10:00:00.000Z",
  traceIdOverride?: string,
  serverId?: string,
  serverName?: string
): Promise<ScenarioResult> {
  const traceId = traceIdOverride ?? "gp-001-test-trace-id-fixed";
  const source = buildSource(serverId, serverName);
  const clientOrderId = "GP-ORDER-001";
  const events: LpOrderEvent[] = [];
  const results: EmitResult[] = [];

  const correlation: Correlation = {
    trace_id: traceId,
    client_order_id: clientOrderId,
    lp_order_id: null,
    order_digest: "abc123def456...",
    decision_token_id: traceId
  };

  const payload: OrderPayload = {
    symbol: "EURUSD",
    side: "BUY",
    qty: 100000,
    price: 1.085,
    order_type: "LIMIT"
  };

  // Event 1: Submitted (T+100ms)
  const submitted = createLpOrderEvent({
    event_type: "lp.order.submitted",
    source,
    correlation,
    payload,
    status: "SUBMITTED",
    occurred_at: new Date(new Date(baseTimestamp).getTime() + 100).toISOString(),
    prev_event_hash: null
  });
  events.push(submitted);
  results.push(await emitToAuditWriter(submitted));

  // Event 2: Rejected with INSUFFICIENT_MARGIN (T+250ms)
  const rejected = createLpOrderEvent({
    event_type: "lp.order.rejected",
    source,
    correlation: { ...correlation, lp_order_id: "SIM-LP-00001" },
    payload,
    status: "REJECTED",
    reason: {
      source_kind: "SIM",
      provider_code: "MARGIN_001",
      provider_message: "Not enough money for order",
      provider_fields: {
        required_margin: 5000.0,
        available_margin: 3200.5,
        margin_level_percent: 64.01
      }
    },
    occurred_at: new Date(new Date(baseTimestamp).getTime() + 250).toISOString(),
    prev_event_hash: submitted.integrity?.payload_hash ?? null
  });
  events.push(rejected);
  results.push(await emitToAuditWriter(rejected));

  return {
    scenario_id: "golden-path",
    trace_id: traceId,
    events,
    emit_results: results,
    final_status: "REJECTED",
    success: results.every(r => r.success)
  };
}

// ============================================================================
// Demo Scenarios for UI Integration (Week 4)
// ============================================================================

export interface DemoScenarioResult {
  scenario_id: string;
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Scenario: Margin Warning
 * Emits a low margin snapshot that should trigger a MARGIN_* alert
 */
export async function scenarioMarginWarning(
  lpId: string = "LP-A",
  marginLevel: number = 45 // Below CRITICAL threshold of 50%
): Promise<DemoScenarioResult> {
  const account = LP_ACCOUNTS.find(a => a.lp_id === lpId);
  if (!account) {
    return {
      scenario_id: "margin-warning",
      success: false,
      message: `LP account ${lpId} not found`
    };
  }

  // Temporarily set margin level to trigger alert
  const originalMarginLevel = account.margin_level;
  const originalEquity = account.equity;
  const originalFreeMargin = account.free_margin;
  
  // Calculate values that produce the desired margin level
  // margin_level = (equity / margin) * 100
  account.margin_level = marginLevel;
  account.equity = (marginLevel / 100) * account.margin;
  account.free_margin = account.equity - account.margin;

  // Emit snapshot with low margin
  const result = await emitLpAccountSnapshot(account);

  // Schedule recovery after 30 seconds (for demo purposes)
  setTimeout(() => {
    account.margin_level = originalMarginLevel;
    account.equity = originalEquity;
    account.free_margin = originalFreeMargin;
    console.log(`[Demo] Restored ${lpId} margin level to ${originalMarginLevel}%`);
  }, 30000);

  return {
    scenario_id: "margin-warning",
    success: result.success,
    message: result.success 
      ? `Emitted low margin snapshot for ${lpId} (margin_level: ${marginLevel}%)`
      : `Failed to emit snapshot: ${result.error}`,
    data: {
      lp_id: lpId,
      margin_level: marginLevel,
      equity: account.equity,
      margin: account.margin,
      expected_alert: marginLevel < 50 ? "MARGIN_CRITICAL" : marginLevel < 100 ? "MARGIN_WARNING" : "none"
    }
  };
}

/**
 * Scenario: Rejection Spike
 * Emits multiple rejections in quick succession to trigger REJECT_SPIKE alert
 */
export async function scenarioRejectionSpike(
  count: number = 5,
  symbol: string = "EURUSD"
): Promise<DemoScenarioResult> {
  const results: EmitResult[] = [];
  const source = buildSource();

  for (let i = 0; i < count; i++) {
    const traceId = `reject-spike-${Date.now()}-${i}`;
    const correlation: Correlation = {
      trace_id: traceId,
      client_order_id: `SPIKE-${Date.now()}-${i}`,
      lp_order_id: null,
      order_digest: null,
      decision_token_id: traceId
    };

    const payload: OrderPayload = {
      symbol,
      side: i % 2 === 0 ? "BUY" : "SELL",
      qty: 100000,
      price: 1.085,
      order_type: "LIMIT"
    };

    // Submit
    const submitted = createLpOrderEvent({
      event_type: "lp.order.submitted",
      source,
      correlation,
      payload,
      status: "SUBMITTED",
      prev_event_hash: null
    });
    await emitToAuditWriter(submitted);

    // Immediate rejection
    const rejected = createLpOrderEvent({
      event_type: "lp.order.rejected",
      source,
      correlation: { ...correlation, lp_order_id: `LP-SPIKE-${i}` },
      payload,
      status: "REJECTED",
      reason: {
        source_kind: "SIM",
        provider_code: "MARGIN_001",
        provider_message: "Insufficient margin for order",
        provider_fields: { spike_test: true, sequence: i }
      },
      prev_event_hash: submitted.integrity?.payload_hash ?? null
    });
    const r = await emitToAuditWriter(rejected);
    results.push(r);

    // Small delay between rejections
    await sleep(100);
  }

  return {
    scenario_id: "rejection-spike",
    success: results.every(r => r.success),
    message: `Emitted ${count} rejections for ${symbol}`,
    data: {
      count,
      symbol,
      successful_emits: results.filter(r => r.success).length,
      expected_alert: "REJECT_SPIKE"
    }
  };
}

/**
 * Scenario: Recovery
 * Restores LP accounts to healthy state
 */
export async function scenarioRecovery(): Promise<DemoScenarioResult> {
  // Reset all LP accounts to healthy state
  for (const account of LP_ACCOUNTS) {
    account.margin_level = 500 + Math.random() * 300; // 500-800%
    account.equity = account.balance * (0.98 + Math.random() * 0.04);
    account.free_margin = account.equity - account.margin;
    
    await emitLpAccountSnapshot(account);
  }

  return {
    scenario_id: "recovery",
    success: true,
    message: "All LP accounts restored to healthy margin levels",
    data: {
      accounts: LP_ACCOUNTS.map(a => ({
        lp_id: a.lp_id,
        margin_level: Math.round(a.margin_level ?? 0)
      }))
    }
  };
}

// ============================================================================
// API Endpoints
// ============================================================================

app.get("/health", (_, res) => {
  res.json({ ok: true, service: "lp-simulator", version: "1.0.0" });
});

app.post("/simulate/full-fill", async (req, res) => {
  const { trace_id, order, client_order_id, server_id, server_name } = req.body;
  if (!trace_id || !order) {
    return res.status(400).json({ error: "trace_id and order required" });
  }
  
  const result = await scenarioFullFill(trace_id, order, client_order_id, server_id, server_name);
  res.json(result);
});

app.post("/simulate/rejection", async (req, res) => {
  const { trace_id, order, reason, client_order_id, server_id, server_name } = req.body;
  if (!trace_id || !order || !reason) {
    return res.status(400).json({ error: "trace_id, order, and reason required" });
  }
  
  const result = await scenarioRejection(trace_id, order, reason, client_order_id, server_id, server_name);
  res.json(result);
});

app.post("/simulate/partial-fills", async (req, res) => {
  const { trace_id, order, fill_pcts, client_order_id, server_id, server_name } = req.body;
  if (!trace_id || !order) {
    return res.status(400).json({ error: "trace_id and order required" });
  }
  
  const result = await scenarioPartialFills(trace_id, order, fill_pcts, client_order_id, server_id, server_name);
  res.json(result);
});

app.post("/simulate/cancellation", async (req, res) => {
  const { trace_id, order, client_order_id, server_id, server_name } = req.body;
  if (!trace_id || !order) {
    return res.status(400).json({ error: "trace_id and order required" });
  }
  
  const result = await scenarioCancellation(trace_id, order, client_order_id, server_id, server_name);
  res.json(result);
});

app.post("/simulate/golden-path", async (req, res) => {
  const { base_timestamp, trace_id, server_id, server_name } = req.body ?? {};
  const result = await goldenPathScenario(base_timestamp, trace_id, server_id, server_name);
  res.json(result);
});

// Demo scenarios for UI integration (Week 4)
app.post("/simulate/margin-warning", async (req, res) => {
  const { lp_id, margin_level } = req.body ?? {};
  const result = await scenarioMarginWarning(lp_id, margin_level);
  res.json(result);
});

app.post("/simulate/rejection-spike", async (req, res) => {
  const { count, symbol } = req.body ?? {};
  const result = await scenarioRejectionSpike(count, symbol);
  res.json(result);
});

app.post("/simulate/recovery", async (_, res) => {
  const result = await scenarioRecovery();
  res.json(result);
});

// List available scenarios
app.get("/scenarios", (_, res) => {
  res.json({
    scenarios: [
      {
        id: "full-fill",
        endpoint: "POST /simulate/full-fill",
        description: "Submit → Accept → Fill (happy path)",
        body: { trace_id: "string", order: { symbol: "EURUSD", side: "BUY", qty: 100000, price: 1.085 } }
      },
      {
        id: "rejection",
        endpoint: "POST /simulate/rejection",
        description: "Submit → Reject with normalized reason",
        body: { 
          trace_id: "string", 
          order: { symbol: "EURUSD", side: "BUY", qty: 100000, price: 1.085 },
          reason: { code: "MARGIN_001", message: "Not enough money" }
        }
      },
      {
        id: "partial-fills",
        endpoint: "POST /simulate/partial-fills",
        description: "Submit → Accept → Partial fills → Fill",
        body: { trace_id: "string", order: {}, fill_pcts: [0.4, 0.35, 0.25] }
      },
      {
        id: "cancellation",
        endpoint: "POST /simulate/cancellation",
        description: "Submit → Accept → Cancel",
        body: { trace_id: "string", order: {} }
      },
      {
        id: "golden-path",
        endpoint: "POST /simulate/golden-path",
        description: "Deterministic scenario for acceptance testing",
        body: { base_timestamp: "2026-01-16T10:00:00.000Z" }
      },
      {
        id: "margin-warning",
        endpoint: "POST /simulate/margin-warning",
        description: "Emit low margin snapshot to trigger MARGIN_* alert",
        body: { lp_id: "LP-A", margin_level: 45 }
      },
      {
        id: "rejection-spike",
        endpoint: "POST /simulate/rejection-spike",
        description: "Emit multiple rejections to trigger REJECT_SPIKE alert",
        body: { count: 5, symbol: "EURUSD" }
      },
      {
        id: "recovery",
        endpoint: "POST /simulate/recovery",
        description: "Restore all LP accounts to healthy margin levels",
        body: {}
      }
    ]
  });
});

// LP Account Snapshot control endpoints
app.get("/lp-accounts", (_, res) => {
  res.json({
    accounts: LP_ACCOUNTS.map(a => ({
      lp_id: a.lp_id,
      lp_name: a.lp_name,
      server_id: a.server_id,
      server_name: a.server_name,
      balance: Math.round(a.balance * 100) / 100,
      equity: Math.round(a.equity * 100) / 100,
      margin: Math.round(a.margin * 100) / 100,
      free_margin: Math.round(a.free_margin * 100) / 100,
      margin_level: a.margin_level ? Math.round(a.margin_level * 100) / 100 : null,
      currency: a.currency,
      status: a.status,
      open_positions: a.open_positions,
      open_orders: a.open_orders
    }))
  });
});

app.get("/lp-snapshots/status", (_, res) => {
  res.json({
    enabled: LP_SNAPSHOT_ENABLED,
    running: snapshotIntervalId !== null,
    interval_ms: LP_SNAPSHOT_INTERVAL_MS,
    emit_count: snapshotEmitCount,
    accounts_count: LP_ACCOUNTS.length
  });
});

app.post("/lp-snapshots/emit-now", async (_, res) => {
  const results: EmitResult[] = [];
  for (const account of LP_ACCOUNTS) {
    updateLpAccountState(account);
    const result = await emitLpAccountSnapshot(account);
    results.push(result);
  }
  res.json({ 
    success: results.every(r => r.success),
    results 
  });
});

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Start Server
// ============================================================================

app.listen(SIM_PORT, () => {
  console.log(`LP Simulator listening on :${SIM_PORT}`);
  console.log(`Audit writer URL: ${AUDIT_WRITER_URL}`);
  
  // Start LP snapshot emission background loop
  startLpSnapshotLoop();
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down...");
  stopLpSnapshotLoop();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("Received SIGINT, shutting down...");
  stopLpSnapshotLoop();
  process.exit(0);
});

export { app };
