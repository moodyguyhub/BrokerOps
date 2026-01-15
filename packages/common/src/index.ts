import { z } from "zod";
import { v4 as uuidv4 } from "uuid";

// Re-export Decision Token utilities
export {
  issueDecisionToken,
  verifyDecisionToken,
  getCompactSignature,
  type DecisionToken,
  type DecisionTokenPayload
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
