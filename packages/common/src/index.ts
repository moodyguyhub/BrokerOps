import { z } from "zod";
import { v4 as uuidv4 } from "uuid";

// Re-export Decision Token utilities
export {
  issueDecisionToken,
  verifyDecisionToken,
  getCompactSignature,
  computeOrderDigest,
  verifyOrderDigest,
  type DecisionToken,
  type DecisionTokenPayload,
  type OrderDigestInput
} from "./decision-token.js";

// Re-export Shadow Ledger utilities
export {
  ShadowLedger,
  calculateExposureEventHash,
  type ExposureCheck,
  type ExposureCheckResult,
  type ClientExposureSummary,
  type SymbolPosition,
  type ExposureEvent
} from "./shadow-ledger.js";

// Re-export Evidence Pack v1 utilities
export {
  buildEvidencePack,
  verifyEvidencePack,
  verifyPolicyConsistency,
  serializeEvidencePack,
  deserializeEvidencePack,
  hashComponent,
  calculatePackHash,
  extractPolicySnapshot,
  extractDecision,
  extractAuditChain,
  extractOperatorIdentity,
  type EvidencePackV1,
  type EvidenceManifestV1,
  type PolicySnapshotComponent,
  type DecisionComponent,
  type AuditChainComponent,
  type EconomicsComponent,
  type EconomicsComponentV2,
  type EvidenceSnapshotEconomics,
  type EvidencePolicyContext,
  type EvidenceRealizedEconomics,
  type OperatorIdentityComponent
} from "./evidence-pack.js";

// Re-export Snapshot Economics (P1 + P1 Hardening)
export {
  computeSnapshotEconomics,
  aggregateSavedExposure,
  verifySnapshotDeterminism,
  formatSnapshotEconomics,
  validateCurrency,
  computeCoverageStats,
  type SnapshotEconomics,
  type SnapshotEconomicsInput,
  type SnapshotEconomicsResult,
  type PolicyLimitContext,
  type PriceSource,
  type PriceAssertion,
  type SupportedCurrency,
  type CurrencyValidation,
  type CoverageStats,
  type AggregatedSavedExposure
} from "./snapshot-economics.js";

// Re-export Idempotency Store (P2.1)
export {
  IdempotencyStore,
  hashPayload,
  formatIdempotencyKey,
  IDEMPOTENCY_STORE_MIGRATION,
  type IdempotencyKey,
  type IdempotencyRecord,
  type IdempotencyCheckResult
} from "./idempotency-store.js";

// Re-export Lifecycle Events (P2)
export {
  ExecutionReportedSchema,
  PositionClosedSchema,
  EconomicsReconciledSchema,
  LifecycleEventSchema,
  generateIdempotencyKey,
  extractSourceSystem,
  type ExecutionReportedEvent,
  type PositionClosedEvent,
  type EconomicsReconciledEvent,
  type LifecycleEvent,
  type PnLStatus,
  type RealizedEconomics,
  type ExtendedEconomics
} from "./lifecycle-events.js";

// Re-export LP Order Events (Phase 1)
export {
  // Constants
  LP_ORDER_EVENT_VERSION,
  TAXONOMY_VERSION,
  NORMALIZED_STATUSES,
  TERMINAL_STATUSES,
  REASON_CLASSES,
  REASON_CODES,
  SOURCE_KINDS,
  LP_ORDER_EVENT_TYPES,
  // Schemas
  LpOrderEventSchema,
  SourceSchema,
  CorrelationSchema,
  ReasonNormalizationSchema,
  NormalizationSchema,
  IntegritySchema,
  OrderPayloadSchema,
  LpAccountSnapshotPayloadSchema,
  // Functions
  isValidTransition,
  isTerminalStatus,
  canonicalizeJson,
  computePayloadHash,
  computeChainHash,
  sortEventsForTimeline,
  reconstructTimeline,
  mapRejectionReason,
  createLpOrderEvent,
  // Types
  type NormalizedStatus,
  type ReasonClass,
  type ReasonCode,
  type SourceKind,
  type LpOrderEventType,
  type LpOrderEvent,
  type Source,
  type Correlation,
  type ReasonNormalization,
  type Normalization,
  type Integrity,
  type OrderPayload,
  type LpAccountSnapshotPayload,
  type TransitionValidation,
  type TransitionViolation,
  type Timeline,
  type FillSummary
} from "./lp-order-events.js";

export const TraceId = z.string().min(8);

export function newTraceId(): string {
  return uuidv4();
}

export const OrderRequestSchema = z.object({
  clientOrderId: z.string().min(3),
  symbol: z.string().min(1),
  side: z.enum(["BUY", "SELL"]),
  qty: z.number().int().positive(),
  price: z.number().positive().optional()
});

export type OrderRequest = z.infer<typeof OrderRequestSchema>;

export type RiskDecision =
  | { decision: "ALLOW"; reasonCode: string; policyVersion: string }
  | { decision: "BLOCK"; reasonCode: string; policyVersion: string };

export type AuditEvent = {
  traceId: string;
  eventType: string;
  eventVersion: string;
  payload: unknown;
  prevHash: string | null;
  hash: string;      // sha256(prevHash + canonical_json(payload))
  createdAt: string; // ISO
};

// --- Webhook Helper ---

const WEBHOOK_SERVICE_URL = process.env.WEBHOOK_SERVICE_URL ?? "http://localhost:7006";

// Re-export IDataSource interface (PH1-W1-003)
export {
  type IDataSource,
  type DataSourceType,
  type Order,
  type OrderLifecycleEvent,
  type LpAccount,
  type LpSnapshot,
  type Rejection,
  type OrdersQuery,
  type LpHistoryQuery,
  type RejectionsQuery,
  type RejectionRollup,
  type PaginatedResult,
  type OrderStatus,
  type LpStatus,
  OrderStatusSchema,
  LpStatusSchema,
  createDataSource
} from "./data-source.js";

export type WebhookEventType = 
  | "trace.completed"
  | "override.requested"
  | "override.approved"
  | "override.rejected"
  | "economics.recorded";

export async function emitWebhook(
  type: WebhookEventType,
  traceId: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await fetch(`${WEBHOOK_SERVICE_URL}/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type,
        traceId,
        payload,
        timestamp: new Date().toISOString()
      }),
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    // Best effort - don't fail main flow if webhooks are down
    console.warn(`Webhook emit failed for ${type}:${traceId}`);
  }
}
