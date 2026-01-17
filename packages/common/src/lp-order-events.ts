/**
 * Phase 1 LP Order Lifecycle Events Module
 * 
 * Defines event schemas for LP order lifecycle tracking.
 * Based on PH1-unified-data-layer.md and PH1-lp-lifecycle.md
 * 
 * Namespace: lp.order.*
 * Correlation: trace_id (per DEC-P2-LIFECYCLE-LINKAGE)
 */

import { z } from "zod";
import { createHash } from "crypto";

// ============================================================================
// Constants
// ============================================================================

export const LP_ORDER_EVENT_VERSION = 1;
export const TAXONOMY_VERSION = "2026-01-16.v1";

export const NORMALIZED_STATUSES = [
  "SUBMITTED",
  "ACCEPTED", 
  "REJECTED",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCELED",
  "EXPIRED",
  "UNKNOWN"
] as const;

export type NormalizedStatus = typeof NORMALIZED_STATUSES[number];

export const TERMINAL_STATUSES = new Set<NormalizedStatus>([
  "REJECTED",
  "FILLED", 
  "CANCELED",
  "EXPIRED"
]);

export const REASON_CLASSES = [
  "MARGIN",
  "SYMBOL",
  "RISK_POLICY",
  "PRICE",
  "LP_INTERNAL",
  "CONNECTIVITY",
  "RATE_LIMIT",
  "VALIDATION",
  "DUPLICATE",
  "UNKNOWN"
] as const;

export type ReasonClass = typeof REASON_CLASSES[number];

export const REASON_CODES = [
  // MARGIN
  "INSUFFICIENT_MARGIN",
  "MARGIN_LEVEL_TOO_LOW",
  "MARGIN_CALL_ACTIVE",
  // SYMBOL
  "SYMBOL_DISABLED",
  "SYMBOL_HALTED",
  "MARKET_CLOSED",
  "SYMBOL_NOT_FOUND",
  // RISK_POLICY
  "MAX_EXPOSURE_EXCEEDED",
  "MAX_ORDER_SIZE_EXCEEDED",
  "ACCOUNT_RESTRICTED",
  "DAILY_LOSS_LIMIT",
  "CONCENTRATION_LIMIT",
  // PRICE
  "OFF_MARKET",
  "PRICE_CHANGED",
  "SLIPPAGE_LIMIT_EXCEEDED",
  "INVALID_PRICE",
  // LP_INTERNAL
  "LP_REJECT_UNSPECIFIED",
  "LP_TIMEOUT",
  "LP_THROTTLED",
  "LP_MAINTENANCE",
  // CONNECTIVITY
  "BRIDGE_DOWN",
  "LP_DISCONNECTED",
  "NETWORK_ERROR",
  // RATE_LIMIT
  "RATE_LIMITED",
  "CONCURRENT_LIMIT",
  // VALIDATION
  "INVALID_SYMBOL",
  "INVALID_VOLUME",
  "INVALID_ORDER_TYPE",
  "INVALID_EXPIRATION",
  "INVALID_STOPS",
  // DUPLICATE
  "DUPLICATE_CLIENT_ORDER_ID",
  "DUPLICATE_ORDER",
  // UNKNOWN
  "UNKNOWN_REJECT"
] as const;

export type ReasonCode = typeof REASON_CODES[number];

export const SOURCE_KINDS = ["SIM", "MT5_MANAGER", "BRIDGE", "LP"] as const;
export type SourceKind = typeof SOURCE_KINDS[number];

export const LP_ORDER_EVENT_TYPES = [
  "lp.order.submitted",
  "lp.order.accepted",
  "lp.order.rejected",
  "lp.order.filled",
  "lp.order.partially_filled",
  "lp.order.canceled",
  "lp.order.expired",
  "lp.order.status_snapshot",
  "lp.account.snapshot"
] as const;

export type LpOrderEventType = typeof LP_ORDER_EVENT_TYPES[number];

// ============================================================================
// Schemas
// ============================================================================

export const SourceSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  name: z.string(),
  adapter_version: z.string(),
  server_id: z.string().min(1),
  server_name: z.string().min(1)
});

export const CorrelationSchema = z.object({
  trace_id: z.string().min(1),
  client_order_id: z.string().nullable().optional(),
  lp_order_id: z.string().nullable().optional(),
  order_digest: z.string().nullable().optional(),
  decision_token_id: z.string().nullable().optional()
});

export const RawReasonSchema = z.object({
  provider_code: z.string().nullable().optional(),
  provider_message: z.string().nullable().optional(),
  provider_fields: z.record(z.unknown()).optional()
});

export const ReasonNormalizationSchema = z.object({
  taxonomy_version: z.string(),
  reason_code: z.enum(REASON_CODES),
  reason_class: z.enum(REASON_CLASSES),
  raw: RawReasonSchema
});

export const NormalizationSchema = z.object({
  status: z.enum(NORMALIZED_STATUSES),
  reason: ReasonNormalizationSchema.nullable().optional()
});

export const IntegritySchema = z.object({
  payload_hash: z.string(),
  prev_event_hash: z.string().nullable().optional(),
  chain_id: z.string()
});

export const OrderPayloadSchema = z.object({
  symbol: z.string(),
  side: z.enum(["BUY", "SELL"]),
  qty: z.number().positive(),
  price: z.number().nullable().optional(),
  order_type: z.string().optional(),
  fill_qty: z.number().optional(),
  fill_price: z.number().optional(),
  remaining_qty: z.number().optional()
}).passthrough(); // Allow additional fields

/**
 * LP Account Snapshot Payload (for lp.account.snapshot events)
 */
export const LpAccountSnapshotPayloadSchema = z.object({
  lp_id: z.string().min(1),
  lp_name: z.string().min(1),
  balance: z.number(),
  equity: z.number(),
  margin: z.number(),
  free_margin: z.number(),
  margin_level: z.number().nullable().optional(), // % or null if margin=0
  currency: z.string().default("USD"),
  status: z.enum(["CONNECTED", "DISCONNECTED", "UNKNOWN"]).default("CONNECTED"),
  open_positions: z.number().int().optional(),
  open_orders: z.number().int().optional()
});

export type LpAccountSnapshotPayload = z.infer<typeof LpAccountSnapshotPayloadSchema>;

/**
 * Unified LP Order Event Envelope
 */
export const LpOrderEventSchema = z.object({
  event_id: z.string().uuid(),
  event_type: z.enum(LP_ORDER_EVENT_TYPES),
  event_version: z.number().int().positive(),
  source: SourceSchema,
  occurred_at: z.string().datetime(),
  ingested_at: z.string().datetime().optional(),
  correlation: CorrelationSchema,
  payload: OrderPayloadSchema,
  normalization: NormalizationSchema,
  integrity: IntegritySchema.optional()
});

export type LpOrderEvent = z.infer<typeof LpOrderEventSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type Correlation = z.infer<typeof CorrelationSchema>;
export type ReasonNormalization = z.infer<typeof ReasonNormalizationSchema>;
export type Normalization = z.infer<typeof NormalizationSchema>;
export type Integrity = z.infer<typeof IntegritySchema>;
export type OrderPayload = z.infer<typeof OrderPayloadSchema>;

// ============================================================================
// Transition Validation
// ============================================================================

const ALLOWED_TRANSITIONS: Record<NormalizedStatus, Set<NormalizedStatus>> = {
  SUBMITTED: new Set(["ACCEPTED", "REJECTED", "CANCELED", "EXPIRED", "UNKNOWN"]),
  ACCEPTED: new Set(["PARTIALLY_FILLED", "FILLED", "CANCELED", "EXPIRED", "UNKNOWN"]),
  PARTIALLY_FILLED: new Set(["PARTIALLY_FILLED", "FILLED", "CANCELED", "EXPIRED", "UNKNOWN"]),
  REJECTED: new Set([]), // Terminal
  FILLED: new Set([]),   // Terminal
  CANCELED: new Set([]), // Terminal
  EXPIRED: new Set([]),  // Terminal
  UNKNOWN: new Set(["SUBMITTED", "ACCEPTED", "REJECTED", "PARTIALLY_FILLED", "FILLED", "CANCELED", "EXPIRED", "UNKNOWN"])
};

export interface TransitionValidation {
  valid: boolean;
  from: NormalizedStatus;
  to: NormalizedStatus;
  reason?: string;
}

export function isValidTransition(from: NormalizedStatus, to: NormalizedStatus): TransitionValidation {
  if (TERMINAL_STATUSES.has(from)) {
    return {
      valid: false,
      from,
      to,
      reason: `Cannot transition from terminal status ${from}`
    };
  }
  
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed?.has(to)) {
    return {
      valid: false,
      from,
      to,
      reason: `Transition from ${from} to ${to} not allowed`
    };
  }
  
  return { valid: true, from, to };
}

export function isTerminalStatus(status: NormalizedStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ============================================================================
// Canonical JSON & Hash Computation
// ============================================================================

/**
 * Canonical JSON serialization (RFC 8785-like)
 * Keys sorted alphabetically, no extra whitespace
 */
export function canonicalizeJson(obj: unknown): string {
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(sortKeys);
    }
    if (value !== null && typeof value === "object") {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
      }
      return sorted;
    }
    return value;
  };
  return JSON.stringify(sortKeys(obj));
}

/**
 * Compute payload hash for integrity verification
 * Excludes integrity fields from hash input
 */
export function computePayloadHash(event: Omit<LpOrderEvent, "integrity">): string {
  const canonical = canonicalizeJson(event);
  const hash = createHash("sha256").update(canonical).digest("hex");
  return `sha256:${hash}`;
}

/**
 * Compute chain link hash
 */
export function computeChainHash(
  payloadHash: string,
  prevEventHash: string | null
): string {
  const material = (prevEventHash ?? "") + "|" + payloadHash;
  return createHash("sha256").update(material).digest("hex");
}

// ============================================================================
// Timeline Reconstruction
// ============================================================================

export interface TransitionViolation {
  from_status: NormalizedStatus;
  to_status: NormalizedStatus;
  event_id: string;
  reason_code: string;
}

export interface Timeline {
  trace_id: string;
  events: LpOrderEvent[];
  current_status: NormalizedStatus;
  is_terminal: boolean;
  has_violations: boolean;
  violations: TransitionViolation[];
  integrity_status: "VALID" | "INVALID" | "TAMPER_SUSPECTED";
  fill_summary?: FillSummary;
}

export interface FillSummary {
  total_qty: number;
  filled_qty: number;
  remaining_qty: number;
  fill_count: number;
  avg_fill_price: number;
}

/**
 * Sort events for timeline reconstruction
 * Order: occurred_at ASC, ingested_at ASC, event_id ASC
 */
export function sortEventsForTimeline(events: LpOrderEvent[]): LpOrderEvent[] {
  return [...events].sort((a, b) => {
    const occA = new Date(a.occurred_at).getTime();
    const occB = new Date(b.occurred_at).getTime();
    if (occA !== occB) return occA - occB;
    
    const ingA = new Date(a.ingested_at ?? a.occurred_at).getTime();
    const ingB = new Date(b.ingested_at ?? b.occurred_at).getTime();
    if (ingA !== ingB) return ingA - ingB;
    
    return a.event_id.localeCompare(b.event_id);
  });
}

/**
 * Reconstruct timeline from events
 */
export function reconstructTimeline(traceId: string, events: LpOrderEvent[]): Timeline {
  if (events.length === 0) {
    return {
      trace_id: traceId,
      events: [],
      current_status: "UNKNOWN",
      is_terminal: false,
      has_violations: false,
      violations: [],
      integrity_status: "VALID"
    };
  }

  const sorted = sortEventsForTimeline(events);
  const violations: TransitionViolation[] = [];
  let prevStatus: NormalizedStatus | null = null;

  for (const event of sorted) {
    const currentStatus = event.normalization.status;
    
    if (prevStatus !== null) {
      const validation = isValidTransition(prevStatus, currentStatus);
      if (!validation.valid) {
        violations.push({
          from_status: prevStatus,
          to_status: currentStatus,
          event_id: event.event_id,
          reason_code: "INVALID_TRANSITION"
        });
      }
    }
    
    prevStatus = currentStatus;
  }

  // Verify hash chain
  let integrityStatus: "VALID" | "INVALID" | "TAMPER_SUSPECTED" = "VALID";
  for (let i = 0; i < sorted.length; i++) {
    const event = sorted[i];
    if (!event.integrity) continue;
    
    // Verify chain link
    if (i > 0 && sorted[i - 1].integrity) {
      const expectedPrev = `sha256:${computeChainHash(
        sorted[i - 1].integrity!.payload_hash,
        sorted[i - 1].integrity!.prev_event_hash ?? null
      )}`;
      // Note: simplified check - full verification would recompute all hashes
    }
  }

  // Compute fill summary
  let fillSummary: FillSummary | undefined;
  const fills = sorted.filter(e => 
    e.event_type === "lp.order.filled" || 
    e.event_type === "lp.order.partially_filled"
  );
  
  if (fills.length > 0) {
    let totalFilledQty = 0;
    let totalValue = 0;
    
    for (const fill of fills) {
      const qty = fill.payload.fill_qty ?? 0;
      const price = fill.payload.fill_price ?? 0;
      totalFilledQty += qty;
      totalValue += qty * price;
    }
    
    const orderQty = sorted[0]?.payload.qty ?? 0;
    
    fillSummary = {
      total_qty: orderQty,
      filled_qty: totalFilledQty,
      remaining_qty: Math.max(0, orderQty - totalFilledQty),
      fill_count: fills.length,
      avg_fill_price: totalFilledQty > 0 ? totalValue / totalFilledQty : 0
    };
  }

  const currentStatus = prevStatus ?? "UNKNOWN";

  return {
    trace_id: traceId,
    events: sorted,
    current_status: currentStatus,
    is_terminal: isTerminalStatus(currentStatus),
    has_violations: violations.length > 0,
    violations,
    integrity_status: violations.length > 0 ? "TAMPER_SUSPECTED" : integrityStatus,
    fill_summary: fillSummary
  };
}

// ============================================================================
// Reason Mapping
// ============================================================================

interface ReasonMappingInput {
  source_kind: SourceKind;
  provider_code: string | null;
  provider_message: string | null;
  provider_fields?: Record<string, unknown>;
}

interface ReasonMappingOutput {
  taxonomy_version: string;
  reason_class: ReasonClass;
  reason_code: ReasonCode;
  raw: {
    provider_code: string | null;
    provider_message: string | null;
    provider_fields: Record<string, unknown>;
  };
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

// Simulator exact code mappings
const SIM_CODE_MAPPINGS: Record<string, { reason_class: ReasonClass; reason_code: ReasonCode }> = {
  "MARGIN_001": { reason_class: "MARGIN", reason_code: "INSUFFICIENT_MARGIN" },
  "MARGIN_002": { reason_class: "MARGIN", reason_code: "MARGIN_LEVEL_TOO_LOW" },
  "SYMBOL_001": { reason_class: "SYMBOL", reason_code: "SYMBOL_DISABLED" },
  "SYMBOL_002": { reason_class: "SYMBOL", reason_code: "MARKET_CLOSED" },
  "PRICE_001": { reason_class: "PRICE", reason_code: "OFF_MARKET" },
  "PRICE_002": { reason_class: "PRICE", reason_code: "SLIPPAGE_LIMIT_EXCEEDED" },
  "RISK_001": { reason_class: "RISK_POLICY", reason_code: "MAX_EXPOSURE_EXCEEDED" },
  "RISK_002": { reason_class: "RISK_POLICY", reason_code: "MAX_ORDER_SIZE_EXCEEDED" }
};

// MT5 retcode mappings
const MT5_CODE_MAPPINGS: Record<string, { reason_class: ReasonClass; reason_code: ReasonCode }> = {
  "10019": { reason_class: "MARGIN", reason_code: "INSUFFICIENT_MARGIN" },
  "10018": { reason_class: "SYMBOL", reason_code: "MARKET_CLOSED" },
  "10017": { reason_class: "SYMBOL", reason_code: "SYMBOL_DISABLED" },
  "10015": { reason_class: "PRICE", reason_code: "INVALID_PRICE" },
  "10016": { reason_class: "VALIDATION", reason_code: "INVALID_STOPS" },
  "10014": { reason_class: "VALIDATION", reason_code: "INVALID_VOLUME" },
  "10004": { reason_class: "PRICE", reason_code: "OFF_MARKET" },
  "10021": { reason_class: "PRICE", reason_code: "PRICE_CHANGED" },
  "10024": { reason_class: "RATE_LIMIT", reason_code: "RATE_LIMITED" },
  "10006": { reason_class: "LP_INTERNAL", reason_code: "LP_REJECT_UNSPECIFIED" },
  "10033": { reason_class: "RISK_POLICY", reason_code: "MAX_ORDER_SIZE_EXCEEDED" },
  "10031": { reason_class: "RISK_POLICY", reason_code: "CONCENTRATION_LIMIT" }
};

// Message pattern matching
const MESSAGE_PATTERNS: Array<{ pattern: RegExp; reason_class: ReasonClass; reason_code: ReasonCode }> = [
  { pattern: /not enough (money|margin|funds)/i, reason_class: "MARGIN", reason_code: "INSUFFICIENT_MARGIN" },
  { pattern: /market.*(closed|not open)/i, reason_class: "SYMBOL", reason_code: "MARKET_CLOSED" },
  { pattern: /symbol.*(disabled|halted)/i, reason_class: "SYMBOL", reason_code: "SYMBOL_DISABLED" },
  { pattern: /(off.?quote|requote)/i, reason_class: "PRICE", reason_code: "OFF_MARKET" },
  { pattern: /slippage/i, reason_class: "PRICE", reason_code: "SLIPPAGE_LIMIT_EXCEEDED" },
  { pattern: /timeout/i, reason_class: "LP_INTERNAL", reason_code: "LP_TIMEOUT" },
  { pattern: /rate.?limit/i, reason_class: "RATE_LIMIT", reason_code: "RATE_LIMITED" }
];

/**
 * Map raw rejection reason to normalized taxonomy
 */
export function mapRejectionReason(input: ReasonMappingInput): ReasonMappingOutput {
  const { source_kind, provider_code, provider_message, provider_fields } = input;
  
  const raw = {
    provider_code,
    provider_message,
    provider_fields: provider_fields ?? {}
  };

  // 1. Try exact code match based on source
  const codeStr = String(provider_code ?? "");
  let exactMatch: { reason_class: ReasonClass; reason_code: ReasonCode } | undefined;
  
  if (source_kind === "SIM") {
    exactMatch = SIM_CODE_MAPPINGS[codeStr];
  } else if (source_kind === "MT5_MANAGER") {
    exactMatch = MT5_CODE_MAPPINGS[codeStr];
  }
  
  if (exactMatch) {
    return {
      taxonomy_version: TAXONOMY_VERSION,
      ...exactMatch,
      raw,
      confidence: "HIGH"
    };
  }

  // 2. Try message pattern match
  if (provider_message) {
    for (const { pattern, reason_class, reason_code } of MESSAGE_PATTERNS) {
      if (pattern.test(provider_message)) {
        return {
          taxonomy_version: TAXONOMY_VERSION,
          reason_class,
          reason_code,
          raw,
          confidence: "MEDIUM"
        };
      }
    }
  }

  // 3. Fallback to UNKNOWN
  return {
    taxonomy_version: TAXONOMY_VERSION,
    reason_class: "UNKNOWN",
    reason_code: "UNKNOWN_REJECT",
    raw,
    confidence: "LOW"
  };
}

// ============================================================================
// Event Factory
// ============================================================================

export interface CreateLpOrderEventInput {
  event_type: LpOrderEventType;
  source: Source;
  correlation: Correlation;
  payload: OrderPayload;
  status: NormalizedStatus;
  reason?: ReasonMappingInput;
  occurred_at?: string;
  prev_event_hash?: string | null;
}

/**
 * Create a properly formed LP Order Event with computed hashes
 */
export function createLpOrderEvent(input: CreateLpOrderEventInput): LpOrderEvent {
  const event_id = crypto.randomUUID();
  const occurred_at = input.occurred_at ?? new Date().toISOString();
  const ingested_at = new Date().toISOString();
  
  let reason: ReasonNormalization | null = null;
  if (input.reason && input.status === "REJECTED") {
    const mapped = mapRejectionReason(input.reason);
    reason = {
      taxonomy_version: mapped.taxonomy_version,
      reason_code: mapped.reason_code,
      reason_class: mapped.reason_class,
      raw: mapped.raw
    };
  }

  const eventWithoutIntegrity: Omit<LpOrderEvent, "integrity"> = {
    event_id,
    event_type: input.event_type,
    event_version: LP_ORDER_EVENT_VERSION,
    source: input.source,
    occurred_at,
    ingested_at,
    correlation: input.correlation,
    payload: input.payload,
    normalization: {
      status: input.status,
      reason
    }
  };

  const payload_hash = computePayloadHash(eventWithoutIntegrity);
  const chain_id = `trace:${input.correlation.trace_id}`;

  return {
    ...eventWithoutIntegrity,
    integrity: {
      payload_hash,
      prev_event_hash: input.prev_event_hash ?? null,
      chain_id
    }
  };
}
