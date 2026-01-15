/**
 * Snapshot Economics Module (P1)
 * 
 * Decision-time economics for deterministic KPI computation.
 * Computes "Saved Exposure" and "Projected Exposure" at gate decision time.
 * 
 * Design Decisions (DEC-2026-01-15-SNAPSHOT-ECONOMICS):
 * - Price source: Platform-provided primary, mark unavailable for market orders
 * - Currency: USD only for P1 (warn-only enforcement)
 * - Saved exposure: Full notional (not breach-delta)
 * 
 * P1 Hardening (DEC-2026-01-15-P1-HARDENING):
 * - P1-R1: Price trust boundary (price_asserted_by, price_asserted_at)
 * - P1-R2: Coverage tracking (decisions_with_price / total_decisions)
 * - P1-R3: USD-only enforcement (warn-only for demo, fail-fast for prod)
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
 * Supported currencies for P1
 */
export type SupportedCurrency = 'USD';

/**
 * Currency validation result
 */
export interface CurrencyValidation {
  supported: boolean;
  original_currency?: string;
  warning?: string;
}

/**
 * Price trust boundary metadata (P1-R1)
 * Tracks who asserted the price and when
 */
export interface PriceAssertion {
  price_asserted_by: string;          // Platform/adapter identifier (e.g., "alpaca", "ibkr")
  price_asserted_at: string;          // ISO-8601 timestamp when price was provided
  price_signature?: string;           // Optional cryptographic signature from platform
}

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
  
  // P1-R1: Price trust boundary (flat fields for convenience)
  price_asserted_by?: string;         // Platform/adapter that provided the price
  price_asserted_at?: string;         // When the price was asserted
  price_signature?: string;           // Optional platform signature
  
  // Shadow ledger context (if available)
  exposure_pre: number | null;        // Client exposure before this decision
  exposure_post: number | null;       // Client exposure after this decision (AUTHORIZED only)
  
  // Currency (USD only for P1)
  currency: SupportedCurrency;
  
  // P1-R3: Currency validation (warn-only for demo)
  currency_validation?: CurrencyValidation;
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
  
  // P1-R1: Price trust boundary
  price_asserted_by?: string;         // Platform/adapter that provided the price
  price_asserted_at?: string;         // When the price was asserted
  price_signature?: string;           // Optional platform signature
  
  // P1-R3: Currency (for validation)
  currency?: string;                  // Original currency from order (default: USD)
}

/**
 * Result of snapshot economics computation
 */
export interface SnapshotEconomicsResult {
  economics: SnapshotEconomics;
  policy_context?: PolicyLimitContext;
}

/**
 * Coverage statistics for KPI tracking (P1-R2)
 */
export interface CoverageStats {
  total_decisions: number;
  decisions_with_price: number;
  coverage_percent: number;
  decisions_usd: number;
  decisions_non_usd: number;
  usd_percent: number;
}

/**
 * Aggregated saved exposure result
 */
export interface AggregatedSavedExposure {
  saved_exposure: number;
  blocked_count: number;
  excluded_count: number;
}

/**
 * Validate currency for P1 (warn-only mode for demo)
 * 
 * @param currency - Currency from order
 * @returns CurrencyValidation result
 */
export function validateCurrency(currency?: string): CurrencyValidation {
  const normalized = (currency ?? 'USD').toUpperCase();
  
  if (normalized === 'USD') {
    return { supported: true };
  }
  
  // P1-R3: Warn-only mode for demo
  return {
    supported: false,
    original_currency: normalized,
    warning: `Currency ${normalized} not supported in P1. Economics excluded from USD aggregation.`
  };
}

/**
 * Compute snapshot economics for a decision
 * 
 * @param input - Order and decision data
 * @returns SnapshotEconomicsResult with computed fields
 */
export function computeSnapshotEconomics(input: SnapshotEconomicsInput): SnapshotEconomicsResult {
  const decision_time = input.decision_time ?? new Date().toISOString();
  
  // P1-R3: Validate currency
  const currency_validation = validateCurrency(input.currency);
  
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
  
  // P1-R1: Build price assertion if price available and assertion metadata provided
  let price_asserted_by: string | undefined;
  let price_asserted_at: string | undefined;
  let price_signature: string | undefined;
  if (!price_unavailable && input.price_asserted_by) {
    price_asserted_by = input.price_asserted_by;
    price_asserted_at = input.price_asserted_at ?? decision_time;
    price_signature = input.price_signature;
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
    price_asserted_by,
    price_asserted_at,
    price_signature,
    exposure_pre: input.exposure_pre ?? null,
    exposure_post,
    currency: 'USD',
    currency_validation: currency_validation.supported ? undefined : currency_validation
  };
  
  return {
    economics,
    policy_context: input.policy_context
  };
}

/**
 * Compute aggregate saved exposure from multiple blocked decisions
 * P1-R3: Excludes non-USD decisions from aggregation
 * 
 * @param blockedEconomics - Array of snapshot economics from BLOCKED decisions
 * @returns AggregatedSavedExposure with total and counts
 */
export function aggregateSavedExposure(blockedEconomics: SnapshotEconomics[]): AggregatedSavedExposure {
  const usdDecisions = blockedEconomics.filter(e => !e.currency_validation);
  const nonUsdDecisions = blockedEconomics.filter(e => e.currency_validation);
  
  return {
    saved_exposure: usdDecisions.reduce((sum, e) => sum + (e.saved_exposure ?? 0), 0),
    blocked_count: usdDecisions.length,
    excluded_count: nonUsdDecisions.length
  };
}

/**
 * Compute coverage statistics for KPI (P1-R2)
 * 
 * @param economicsList - Array of all snapshot economics
 * @returns CoverageStats with counts and percentages
 */
export function computeCoverageStats(economicsList: SnapshotEconomics[]): CoverageStats {
  const total_decisions = economicsList.length;
  const decisions_with_price = economicsList.filter(e => !e.price_unavailable).length;
  const decisions_usd = economicsList.filter(e => !e.currency_validation).length;
  const decisions_non_usd = economicsList.filter(e => e.currency_validation).length;
  
  return {
    total_decisions,
    decisions_with_price,
    coverage_percent: total_decisions > 0 
      ? Math.round((decisions_with_price / total_decisions) * 1000) / 10 
      : 0,
    decisions_usd,
    decisions_non_usd,
    usd_percent: total_decisions > 0 
      ? (decisions_usd / total_decisions) * 100 
      : 0
  };
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
