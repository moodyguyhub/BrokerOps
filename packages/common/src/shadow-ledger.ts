/**
 * Shadow Ledger Module (P0.2)
 * 
 * Real-time exposure tracking for pre-trade risk assessment.
 * Maintains a materialized view of projected client exposure.
 * 
 * Design Decisions (DEC-2026-01-15-SHADOW-LEDGER):
 * - Append-only exposure_events for audit trail
 * - Hash-chained for tamper evidence
 * - Pending exposure updated on AUTHORIZED, settled on FILLED
 * - Supports per-client and per-symbol limits
 */

import { createHash } from "crypto";
import { Pool, PoolClient } from "pg";

export interface ExposureCheck {
  clientId: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price?: number;
  projectedExposure: number;
}

export interface ExposureCheckResult {
  allowed: boolean;
  currentGrossExposure: number;
  currentNetExposure: number;
  pendingExposure: number;
  projectedTotalExposure: number;
  maxGrossExposure: number;
  maxNetExposure: number;
  maxSingleOrderExposure: number;
  breachType?: "GROSS_EXPOSURE" | "NET_EXPOSURE" | "SINGLE_ORDER" | "SYMBOL_LIMIT";
  breachDetails?: string;
}

export interface ClientExposureSummary {
  clientId: string;
  totalGrossExposure: number;
  totalNetExposure: number;
  totalPendingExposure: number;
  maxGrossExposure: number;
  maxNetExposure: number;
  isGrossBreach: boolean;
  isNetBreach: boolean;
  positions: SymbolPosition[];
}

export interface SymbolPosition {
  symbol: string;
  netQuantity: number;
  avgCostBasis: number;
  grossExposure: number;
  netExposure: number;
  pendingExposure: number;
}

export interface ExposureEvent {
  traceId: string;
  clientId: string;
  symbol: string;
  eventType: "AUTHORIZED" | "BLOCKED" | "FILLED" | "CANCELLED" | "POSITION_CLOSED";
  side?: "BUY" | "SELL";
  quantity?: number;
  price?: number;
  exposureDelta: number;
  exposureBefore?: number;
  exposureAfter?: number;
  decisionSignature?: string;
  policyVersion?: string;
}

/**
 * Calculate hash for exposure event chain
 */
export function calculateExposureEventHash(
  prevHash: string | null,
  event: ExposureEvent
): string {
  const payload = `${prevHash ?? "genesis"}:${event.traceId}:${event.clientId}:${event.symbol}:${event.exposureDelta}`;
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Shadow Ledger client for managing exposure state
 */
export class ShadowLedger {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Pre-trade exposure check
   * Returns whether the order would breach any exposure limits
   */
  async checkExposure(check: ExposureCheck): Promise<ExposureCheckResult> {
    const client = await this.pool.connect();
    try {
      // Get client limits
      const limitsResult = await client.query(
        `SELECT max_gross_exposure, max_net_exposure, max_single_order_exposure, symbol_limits
         FROM client_exposure_limits
         WHERE client_id = $1 AND active = TRUE`,
        [check.clientId]
      );

      const limits = limitsResult.rows[0] || {
        max_gross_exposure: 1000000,
        max_net_exposure: 500000,
        max_single_order_exposure: 100000,
        symbol_limits: {}
      };

      // Get current exposure
      const exposureResult = await client.query(
        `SELECT 
           COALESCE(SUM(gross_exposure), 0) as total_gross,
           COALESCE(SUM(net_exposure), 0) as total_net,
           COALESCE(SUM(pending_exposure), 0) as total_pending
         FROM shadow_ledger
         WHERE client_id = $1`,
        [check.clientId]
      );

      const currentExposure = exposureResult.rows[0] || {
        total_gross: 0,
        total_net: 0,
        total_pending: 0
      };

      const projectedOrderExposure = check.projectedExposure;
      const projectedTotalGross = parseFloat(currentExposure.total_gross) + 
                                   parseFloat(currentExposure.total_pending) + 
                                   projectedOrderExposure;
      
      const projectedNetDelta = check.side === "BUY" ? projectedOrderExposure : -projectedOrderExposure;
      const projectedTotalNet = parseFloat(currentExposure.total_net) + projectedNetDelta;

      // Check limits
      let breachType: ExposureCheckResult["breachType"];
      let breachDetails: string | undefined;

      // Check single order limit
      if (projectedOrderExposure > parseFloat(limits.max_single_order_exposure)) {
        breachType = "SINGLE_ORDER";
        breachDetails = `Order exposure ${projectedOrderExposure} exceeds single order limit ${limits.max_single_order_exposure}`;
      }
      // Check gross exposure limit
      else if (projectedTotalGross > parseFloat(limits.max_gross_exposure)) {
        breachType = "GROSS_EXPOSURE";
        breachDetails = `Projected gross exposure ${projectedTotalGross.toFixed(2)} exceeds limit ${limits.max_gross_exposure}`;
      }
      // Check net exposure limit
      else if (Math.abs(projectedTotalNet) > parseFloat(limits.max_net_exposure)) {
        breachType = "NET_EXPOSURE";
        breachDetails = `Projected net exposure ${projectedTotalNet.toFixed(2)} exceeds limit ${limits.max_net_exposure}`;
      }
      // Check symbol-specific limits if configured
      else if (limits.symbol_limits[check.symbol]) {
        const symbolLimit = limits.symbol_limits[check.symbol];
        if (projectedOrderExposure > symbolLimit.max_exposure) {
          breachType = "SYMBOL_LIMIT";
          breachDetails = `Symbol ${check.symbol} exposure ${projectedOrderExposure} exceeds symbol limit ${symbolLimit.max_exposure}`;
        }
      }

      return {
        allowed: !breachType,
        currentGrossExposure: parseFloat(currentExposure.total_gross),
        currentNetExposure: parseFloat(currentExposure.total_net),
        pendingExposure: parseFloat(currentExposure.total_pending),
        projectedTotalExposure: projectedTotalGross,
        maxGrossExposure: parseFloat(limits.max_gross_exposure),
        maxNetExposure: parseFloat(limits.max_net_exposure),
        maxSingleOrderExposure: parseFloat(limits.max_single_order_exposure),
        breachType,
        breachDetails
      };
    } finally {
      client.release();
    }
  }

  /**
   * Record exposure event when order is authorized
   */
  async recordAuthorized(
    traceId: string,
    clientId: string,
    symbol: string,
    side: "BUY" | "SELL",
    quantity: number,
    price: number | undefined,
    decisionSignature: string,
    policyVersion: string
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `SELECT update_shadow_ledger_on_authorized($1, $2, $3, $4, $5, $6, $7, $8)`,
        [clientId, symbol, side, quantity, price ?? 0, traceId, decisionSignature, policyVersion]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Record exposure event when order is filled (position realized)
   */
  async recordFilled(
    traceId: string,
    clientId: string,
    symbol: string,
    side: "BUY" | "SELL",
    quantity: number,
    fillPrice: number
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `SELECT update_shadow_ledger_on_filled($1, $2, $3, $4, $5, $6)`,
        [clientId, symbol, side, quantity, fillPrice, traceId]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Get client exposure summary
   */
  async getClientExposure(clientId: string): Promise<ClientExposureSummary | null> {
    const client = await this.pool.connect();
    try {
      // Get summary from view
      const summaryResult = await client.query(
        `SELECT * FROM client_exposure_summary WHERE client_id = $1`,
        [clientId]
      );

      if (summaryResult.rows.length === 0) {
        return null;
      }

      const summary = summaryResult.rows[0];

      // Get individual positions
      const positionsResult = await client.query(
        `SELECT symbol, net_quantity, avg_cost_basis, gross_exposure, net_exposure, pending_exposure
         FROM shadow_ledger
         WHERE client_id = $1`,
        [clientId]
      );

      return {
        clientId,
        totalGrossExposure: parseFloat(summary.total_gross_exposure),
        totalNetExposure: parseFloat(summary.total_net_exposure),
        totalPendingExposure: parseFloat(summary.total_pending_exposure),
        maxGrossExposure: parseFloat(summary.max_gross_exposure),
        maxNetExposure: parseFloat(summary.max_net_exposure),
        isGrossBreach: summary.is_gross_breach,
        isNetBreach: summary.is_net_breach,
        positions: positionsResult.rows.map(row => ({
          symbol: row.symbol,
          netQuantity: row.net_quantity,
          avgCostBasis: parseFloat(row.avg_cost_basis || 0),
          grossExposure: parseFloat(row.gross_exposure),
          netExposure: parseFloat(row.net_exposure),
          pendingExposure: parseFloat(row.pending_exposure)
        }))
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get exposure event history for a client
   */
  async getExposureHistory(
    clientId: string,
    options?: { limit?: number; sinceTraceId?: string }
  ): Promise<ExposureEvent[]> {
    const client = await this.pool.connect();
    try {
      let query = `
        SELECT trace_id, client_id, symbol, event_type, side, quantity, price,
               exposure_delta, exposure_before, exposure_after,
               decision_signature, policy_version, created_at
        FROM exposure_events
        WHERE client_id = $1
      `;
      const params: any[] = [clientId];

      if (options?.sinceTraceId) {
        query += ` AND id > (SELECT id FROM exposure_events WHERE trace_id = $2)`;
        params.push(options.sinceTraceId);
      }

      query += ` ORDER BY created_at DESC`;

      if (options?.limit) {
        query += ` LIMIT $${params.length + 1}`;
        params.push(options.limit);
      }

      const result = await client.query(query, params);

      return result.rows.map(row => ({
        traceId: row.trace_id,
        clientId: row.client_id,
        symbol: row.symbol,
        eventType: row.event_type,
        side: row.side,
        quantity: row.quantity,
        price: row.price ? parseFloat(row.price) : undefined,
        exposureDelta: parseFloat(row.exposure_delta),
        exposureBefore: row.exposure_before ? parseFloat(row.exposure_before) : undefined,
        exposureAfter: row.exposure_after ? parseFloat(row.exposure_after) : undefined,
        decisionSignature: row.decision_signature,
        policyVersion: row.policy_version
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Set client exposure limits
   */
  async setClientLimits(
    clientId: string,
    limits: {
      maxGrossExposure?: number;
      maxNetExposure?: number;
      maxSingleOrderExposure?: number;
      symbolLimits?: Record<string, { max_exposure: number }>;
    }
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO client_exposure_limits (
           client_id, max_gross_exposure, max_net_exposure, max_single_order_exposure, symbol_limits
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (client_id) DO UPDATE SET
           max_gross_exposure = COALESCE($2, client_exposure_limits.max_gross_exposure),
           max_net_exposure = COALESCE($3, client_exposure_limits.max_net_exposure),
           max_single_order_exposure = COALESCE($4, client_exposure_limits.max_single_order_exposure),
           symbol_limits = COALESCE($5, client_exposure_limits.symbol_limits),
           updated_at = NOW()`,
        [
          clientId,
          limits.maxGrossExposure,
          limits.maxNetExposure,
          limits.maxSingleOrderExposure,
          limits.symbolLimits ? JSON.stringify(limits.symbolLimits) : null
        ]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Expire stale AUTHORIZED holds (P0-R1 fix)
   * Called periodically to revert exposure for tokens that were never executed
   * 
   * @param tokenTtlSeconds - Maximum age of unexpired holds (default: 300s = 5 min)
   * @returns Array of expired trace IDs
   */
  async expireStaleHolds(tokenTtlSeconds: number = 300): Promise<string[]> {
    const client = await this.pool.connect();
    const expiredTraces: string[] = [];
    
    try {
      // Find AUTHORIZED events that haven't been followed by FILLED/CANCELLED
      // and are older than the TTL
      const staleHolds = await client.query(`
        WITH authorized_holds AS (
          SELECT 
            ee.trace_id,
            ee.client_id,
            ee.symbol,
            ee.exposure_delta,
            ee.created_at
          FROM exposure_events ee
          WHERE ee.event_type = 'AUTHORIZED'
            AND ee.created_at < NOW() - INTERVAL '${tokenTtlSeconds} seconds'
        ),
        settled AS (
          SELECT DISTINCT trace_id
          FROM exposure_events
          WHERE event_type IN ('FILLED', 'CANCELLED', 'EXPIRED')
        )
        SELECT ah.*
        FROM authorized_holds ah
        LEFT JOIN settled s ON ah.trace_id = s.trace_id
        WHERE s.trace_id IS NULL
      `);

      for (const hold of staleHolds.rows) {
        // Revert the exposure
        await client.query(`
          UPDATE shadow_ledger
          SET pending_exposure = GREATEST(0, pending_exposure - $1),
              updated_at = NOW()
          WHERE client_id = $2 AND symbol = $3
        `, [Math.abs(hold.exposure_delta), hold.client_id, hold.symbol]);

        // Get prev hash for chain
        const prevHashResult = await client.query(`
          SELECT hash FROM exposure_events
          WHERE client_id = $1
          ORDER BY id DESC LIMIT 1
        `, [hold.client_id]);
        
        const prevHash = prevHashResult.rows[0]?.hash ?? null;
        const reversalDelta = -Math.abs(hold.exposure_delta);
        
        const newHash = createHash("sha256")
          .update(`${prevHash ?? "genesis"}:${hold.trace_id}:${hold.client_id}:${hold.symbol}:${reversalDelta}`)
          .digest("hex");

        // Log expiry event
        await client.query(`
          INSERT INTO exposure_events (
            trace_id, client_id, symbol, event_type, 
            exposure_delta, prev_hash, hash
          ) VALUES ($1, $2, $3, 'EXPIRED', $4, $5, $6)
        `, [hold.trace_id, hold.client_id, hold.symbol, reversalDelta, prevHash, newHash]);

        expiredTraces.push(hold.trace_id);
      }

      return expiredTraces;
    } finally {
      client.release();
    }
  }

  /**
   * Record cancellation of an authorized order
   */
  async recordCancelled(
    traceId: string,
    clientId: string,
    symbol: string,
    originalExposure: number
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Revert pending exposure
      await client.query(`
        UPDATE shadow_ledger
        SET pending_exposure = GREATEST(0, pending_exposure - $1),
            updated_at = NOW()
        WHERE client_id = $2 AND symbol = $3
      `, [originalExposure, clientId, symbol]);

      // Get prev hash
      const prevHashResult = await client.query(`
        SELECT hash FROM exposure_events
        WHERE client_id = $1
        ORDER BY id DESC LIMIT 1
      `, [clientId]);
      
      const prevHash = prevHashResult.rows[0]?.hash ?? null;
      const reversalDelta = -originalExposure;
      
      const newHash = createHash("sha256")
        .update(`${prevHash ?? "genesis"}:${traceId}:${clientId}:${symbol}:${reversalDelta}`)
        .digest("hex");

      // Log cancellation event
      await client.query(`
        INSERT INTO exposure_events (
          trace_id, client_id, symbol, event_type,
          exposure_delta, prev_hash, hash
        ) VALUES ($1, $2, $3, 'CANCELLED', $4, $5, $6)
      `, [traceId, clientId, symbol, reversalDelta, prevHash, newHash]);
    } finally {
      client.release();
    }
  }

  /**
   * Get pending holds that are close to expiry (for monitoring)
   */
  async getPendingHolds(clientId?: string): Promise<Array<{
    traceId: string;
    clientId: string;
    symbol: string;
    exposureDelta: number;
    createdAt: string;
    ageSeconds: number;
  }>> {
    const client = await this.pool.connect();
    try {
      let query = `
        WITH authorized_holds AS (
          SELECT 
            trace_id, client_id, symbol, exposure_delta, created_at,
            EXTRACT(EPOCH FROM (NOW() - created_at)) as age_seconds
          FROM exposure_events
          WHERE event_type = 'AUTHORIZED'
        ),
        settled AS (
          SELECT DISTINCT trace_id
          FROM exposure_events
          WHERE event_type IN ('FILLED', 'CANCELLED', 'EXPIRED')
        )
        SELECT ah.*
        FROM authorized_holds ah
        LEFT JOIN settled s ON ah.trace_id = s.trace_id
        WHERE s.trace_id IS NULL
      `;
      
      const params: any[] = [];
      if (clientId) {
        query += ` AND ah.client_id = $1`;
        params.push(clientId);
      }
      
      query += ` ORDER BY ah.created_at DESC`;
      
      const result = await client.query(query, params);
      
      return result.rows.map(row => ({
        traceId: row.trace_id,
        clientId: row.client_id,
        symbol: row.symbol,
        exposureDelta: parseFloat(row.exposure_delta),
        createdAt: row.created_at,
        ageSeconds: Math.round(parseFloat(row.age_seconds))
      }));
    } finally {
      client.release();
    }
  }
}
