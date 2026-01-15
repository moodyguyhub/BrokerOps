/**
 * Snapshot Economics Module (P1)
 * 
 * Decision-time economics for deterministic KPI computation.
 * Computes "Saved Exposure" and "Projected Exposure" at gate decision time.
 * 
 * Design Decisions (DEC-2026-01-15-SNAPSHOT-ECONOMICS):
 * - Price source: Platform-provided primary, mark unavailable for market orders
 * - Currency: USD only for P1
 * - Saved exposure: Full notional (not breach-delta)
 */

/**
 * Price source confidence levels
 */
export type PriceSource = 
  | 'FIRM'        // Limit order with explicit price
  | 'INDICATIVE'  // Platform reference price (not execution grade)
  | 'REFERENCE'   // BrokerOps external lookup (v1.1+)
  | 'UNAVAILABLE' // Market order with no price

/**
 * Core snapshot economics computed at decision time
 */
export interface SnapshotEconomics {
  // Core fields
  decision_time: string;              // ISO-8601 timestamp
  decision_time_price: number | null; // Price used for calculation
  qty: number;                        // Order quantity
  notional: number | null;            // qty × price (null if no price)
  
  // Exposure impact (mutually exclusive based on decision)
  projected_exposure_delta: number | null;  // For AUTHORIZED: notional added to exposure
  saved_exposure: number | null;            // For BLOCKED: notional prevented
  
  // Price provenance
  price_source: PriceSource;
  price_unavailable: boolean;
  
  // Shadow ledger context (if available)
  exposure_pre: number | null;        // Client exposure before this decision
  exposure_post: number | null;       // Client exposure after this decision (AUTHORIZED only)
  
  // Currency (USD only for P1)
  currency: 'USD';
}

/**
 * Policy context for evidence pack
 */
export interface PolicyLimitContext {
  limit_type?: string;                // e.g., "GROSS_EXPOSURE", "QTY_LIMIT", "SYMBOL_RESTRICTION"
  limit_value?: number;               // The threshold value
  current_value?: number;             // Value at decision time
  breach_amount?: number;             // How much over the limit
}

/**
 * Input for computing snapshot economics
 */
export interface SnapshotEconomicsInput {
  // Order data
  qty: number;
  price?: number | null;
  referencePrice?: number | null;     // Platform-provided reference (for market orders)
  
  // Decision context
  decision: 'ALLOW' | 'BLOCK';
  decision_time?: string;             // Defaults to now
  
  // Exposure context (from shadow ledger)
  exposure_pre?: number | null;
  
  // Policy context
  policy_context?: PolicyLimitContext;
}

/**
 * Result of snapshot economics computation
 */
export interface SnapshotEconomicsResult {
  economics: SnapshotEconomics;
  policy_context?: PolicyLimitContext;
}

/**
 * Compute snapshot economics for a decision
 * 
 * @param input - Order and decision data
 * @returns SnapshotEconomicsResult with computed fields
 */
export function computeSnapshotEconomics(input: SnapshotEconomicsInput): SnapshotEconomicsResult {
  const decision_time = input.decision_time ?? new Date().toISOString();
  
  // Determine price and source
  let decision_time_price: number | null = null;
  let price_source: PriceSource = 'UNAVAILABLE';
  let price_unavailable = true;
  
  if (input.price !== undefined && input.price !== null && input.price > 0) {
    // Limit order with explicit price
    decision_time_price = input.price;
    price_source = 'FIRM';
    price_unavailable = false;
  } else if (input.referencePrice !== undefined && input.referencePrice !== null && input.referencePrice > 0) {
    // Market order with platform reference
    decision_time_price = input.referencePrice;
    price_source = 'INDICATIVE';
    price_unavailable = false;
  }
  
  // Calculate notional
  const notional = decision_time_price !== null 
    ? input.qty * decision_time_price 
    : null;
  
  // Compute exposure impact based on decision
  let projected_exposure_delta: number | null = null;
  let saved_exposure: number | null = null;
  let exposure_post: number | null = null;
  
  if (input.decision === 'ALLOW') {
    // AUTHORIZED: adds to projected exposure
    projected_exposure_delta = notional;
    if (input.exposure_pre !== null && input.exposure_pre !== undefined && notional !== null) {
      exposure_post = input.exposure_pre + notional;
    }
  } else {
    // BLOCKED: saved exposure = full notional
    saved_exposure = notional;
    // No change to exposure_post (remains null, exposure didn't change)
  }
  
  const economics: SnapshotEconomics = {
    decision_time,
    decision_time_price,
    qty: input.qty,
    notional,
    projected_exposure_delta,
    saved_exposure,
    price_source,
    price_unavailable,
    exposure_pre: input.exposure_pre ?? null,
    exposure_post,
    currency: 'USD'
  };
  
  return {
    economics,
    policy_context: input.policy_context
  };
}

/**
 * Compute aggregate saved exposure from multiple blocked decisions
 * 
 * @param blockedEconomics - Array of snapshot economics from BLOCKED decisions
 * @returns Total saved exposure in USD
 */
export function aggregateSavedExposure(blockedEconomics: SnapshotEconomics[]): number {
  return blockedEconomics.reduce((sum, e) => {
    return sum + (e.saved_exposure ?? 0);
  }, 0);
}

/**
 * Validate snapshot economics for determinism
 * Given a trace bundle, recompute and verify saved_exposure matches
 * 
 * @param stored - Stored snapshot economics
 * @param input - Original input for recomputation
 * @returns true if recomputed value matches stored
 */
export function verifySnapshotDeterminism(
  stored: SnapshotEconomics,
  input: SnapshotEconomicsInput
): boolean {
  const recomputed = computeSnapshotEconomics(input);
  
  // Compare key fields
  if (stored.notional !== recomputed.economics.notional) return false;
  if (stored.saved_exposure !== recomputed.economics.saved_exposure) return false;
  if (stored.projected_exposure_delta !== recomputed.economics.projected_exposure_delta) return false;
  if (stored.price_source !== recomputed.economics.price_source) return false;
  
  return true;
}

/**
 * Format snapshot economics for display
 * 
 * @param economics - Snapshot economics object
 * @returns Human-readable summary
 */
export function formatSnapshotEconomics(economics: SnapshotEconomics): string {
  const parts: string[] = [];
  
  if (economics.notional !== null) {
    parts.push(`Notional: $${economics.notional.toLocaleString()}`);
  } else {
    parts.push('Notional: N/A (price unavailable)');
  }
  
  parts.push(`Price: ${economics.decision_time_price ?? 'N/A'} (${economics.price_source})`);
  parts.push(`Qty: ${economics.qty}`);
  
  if (economics.projected_exposure_delta !== null) {
    parts.push(`Projected Δ: +$${economics.projected_exposure_delta.toLocaleString()}`);
  }
  
  if (economics.saved_exposure !== null) {
    parts.push(`Saved Exposure: $${economics.saved_exposure.toLocaleString()}`);
  }
  
  if (economics.exposure_pre !== null) {
    parts.push(`Exposure Pre: $${economics.exposure_pre.toLocaleString()}`);
  }
  
  if (economics.exposure_post !== null) {
    parts.push(`Exposure Post: $${economics.exposure_post.toLocaleString()}`);
  }
  
  return parts.join(' | ');
}
