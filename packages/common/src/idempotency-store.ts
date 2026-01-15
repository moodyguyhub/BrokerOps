/**
 * Idempotency Store Module (P2.1)
 * 
 * Provides exactly-once event processing guarantees for inbound lifecycle events.
 * Events are deduplicated by {source_system, event_type, event_id}.
 * 
 * Design Decisions (DEC-2026-01-15-IDEMPOTENCY):
 * - First-seen wins: duplicate events are acknowledged but not reprocessed
 * - Payload hash stored for debugging discrepancies
 * - 7-day retention window (configurable)
 * - Returns previous result for duplicates (replay-safe)
 */

import { createHash } from "crypto";
import { Pool } from "pg";

/**
 * Unique key for event deduplication
 */
export interface IdempotencyKey {
  source_system: string;    // e.g., "alpaca", "ibkr", "backoffice"
  event_type: string;       // e.g., "execution.reported", "position.closed"
  event_id: string;         // Source-provided unique ID
}

/**
 * Stored idempotency record
 */
export interface IdempotencyRecord {
  key: IdempotencyKey;
  payload_hash: string;
  first_seen_at: string;
  processing_result: 'SUCCESS' | 'FAILED' | 'DUPLICATE';
  result_data?: Record<string, unknown>;
  attempt_count: number;
}

/**
 * Result of checking idempotency
 */
export interface IdempotencyCheckResult {
  is_duplicate: boolean;
  first_seen_at?: string;
  previous_result?: 'SUCCESS' | 'FAILED';
  previous_data?: Record<string, unknown>;
  attempt_count?: number;
  payload_mismatch?: boolean;  // Same key but different payload hash
}

/**
 * Hash payload for consistency check
 */
export function hashPayload(payload: unknown): string {
  const canonical = JSON.stringify(payload, Object.keys(payload as object).sort());
  return createHash("sha256").update(canonical).digest("hex").substring(0, 16);
}

/**
 * Format idempotency key as string
 */
export function formatIdempotencyKey(key: IdempotencyKey): string {
  return `${key.source_system}:${key.event_type}:${key.event_id}`;
}

/**
 * Idempotency Store for exactly-once event processing
 */
export class IdempotencyStore {
  private pool: Pool;
  private retentionDays: number;

  constructor(pool: Pool, retentionDays: number = 7) {
    this.pool = pool;
    this.retentionDays = retentionDays;
  }

  /**
   * Check if an event has been seen before
   * Returns duplicate status and previous result if exists
   */
  async check(key: IdempotencyKey, payload: unknown): Promise<IdempotencyCheckResult> {
    const payloadHash = hashPayload(payload);
    const keyString = formatIdempotencyKey(key);

    const result = await this.pool.query(`
      SELECT 
        payload_hash, 
        first_seen_at, 
        processing_result, 
        result_data,
        attempt_count
      FROM idempotency_store
      WHERE source_system = $1 
        AND event_type = $2 
        AND event_id = $3
        AND first_seen_at > NOW() - INTERVAL '${this.retentionDays} days'
    `, [key.source_system, key.event_type, key.event_id]);

    if (result.rows.length === 0) {
      return { is_duplicate: false };
    }

    const record = result.rows[0];
    const payloadMismatch = record.payload_hash !== payloadHash;

    // Increment attempt count for monitoring
    await this.pool.query(`
      UPDATE idempotency_store
      SET attempt_count = attempt_count + 1,
          last_attempt_at = NOW()
      WHERE source_system = $1 AND event_type = $2 AND event_id = $3
    `, [key.source_system, key.event_type, key.event_id]);

    return {
      is_duplicate: true,
      first_seen_at: record.first_seen_at,
      previous_result: record.processing_result === 'DUPLICATE' ? undefined : record.processing_result,
      previous_data: record.result_data,
      attempt_count: record.attempt_count + 1,
      payload_mismatch: payloadMismatch
    };
  }

  /**
   * Reserve a slot for processing (atomic check-and-set)
   * Returns true if this call wins the race and should process
   */
  async reserve(key: IdempotencyKey, payload: unknown): Promise<boolean> {
    const payloadHash = hashPayload(payload);

    try {
      await this.pool.query(`
        INSERT INTO idempotency_store (
          source_system, event_type, event_id, 
          payload_hash, first_seen_at, processing_result, attempt_count
        ) VALUES ($1, $2, $3, $4, NOW(), 'PENDING', 1)
      `, [key.source_system, key.event_type, key.event_id, payloadHash]);

      return true; // We won the race
    } catch (err: any) {
      // Unique constraint violation = someone else got there first
      if (err.code === '23505') {
        return false;
      }
      throw err;
    }
  }

  /**
   * Mark processing as complete
   */
  async complete(
    key: IdempotencyKey, 
    result: 'SUCCESS' | 'FAILED',
    resultData?: Record<string, unknown>
  ): Promise<void> {
    await this.pool.query(`
      UPDATE idempotency_store
      SET processing_result = $4,
          result_data = $5,
          completed_at = NOW()
      WHERE source_system = $1 
        AND event_type = $2 
        AND event_id = $3
    `, [
      key.source_system, 
      key.event_type, 
      key.event_id, 
      result,
      resultData ? JSON.stringify(resultData) : null
    ]);
  }

  /**
   * Combined check-and-reserve for typical use
   * Returns { should_process: true } if caller should process
   * Returns { should_process: false, ... } with previous result if duplicate
   */
  async checkAndReserve(
    key: IdempotencyKey, 
    payload: unknown
  ): Promise<{
    should_process: boolean;
    first_seen_at?: string;
    previous_result?: 'SUCCESS' | 'FAILED';
    previous_data?: Record<string, unknown>;
    payload_mismatch?: boolean;
  }> {
    // Try to reserve first (optimistic path)
    const reserved = await this.reserve(key, payload);
    
    if (reserved) {
      return { should_process: true };
    }

    // Someone else got there first - check what happened
    const checkResult = await this.check(key, payload);
    
    return {
      should_process: false,
      first_seen_at: checkResult.first_seen_at,
      previous_result: checkResult.previous_result,
      previous_data: checkResult.previous_data,
      payload_mismatch: checkResult.payload_mismatch
    };
  }

  /**
   * Clean up old records beyond retention window
   */
  async cleanup(): Promise<number> {
    const result = await this.pool.query(`
      DELETE FROM idempotency_store
      WHERE first_seen_at < NOW() - INTERVAL '${this.retentionDays} days'
    `);
    return result.rowCount ?? 0;
  }

  /**
   * Get stats for monitoring
   */
  async getStats(hoursBack: number = 24): Promise<{
    total_events: number;
    successful: number;
    failed: number;
    duplicates_blocked: number;
    by_source: Record<string, number>;
    by_event_type: Record<string, number>;
  }> {
    const result = await this.pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE processing_result = 'SUCCESS') as successful,
        COUNT(*) FILTER (WHERE processing_result = 'FAILED') as failed,
        SUM(attempt_count - 1) as duplicate_attempts,
        source_system,
        event_type
      FROM idempotency_store
      WHERE first_seen_at > NOW() - INTERVAL '${hoursBack} hours'
      GROUP BY source_system, event_type
    `);

    const bySource: Record<string, number> = {};
    const byEventType: Record<string, number> = {};
    let total = 0, successful = 0, failed = 0, duplicates = 0;

    for (const row of result.rows) {
      total += parseInt(row.total);
      successful += parseInt(row.successful);
      failed += parseInt(row.failed);
      duplicates += parseInt(row.duplicate_attempts ?? 0);
      
      bySource[row.source_system] = (bySource[row.source_system] ?? 0) + parseInt(row.total);
      byEventType[row.event_type] = (byEventType[row.event_type] ?? 0) + parseInt(row.total);
    }

    return {
      total_events: total,
      successful,
      failed,
      duplicates_blocked: duplicates,
      by_source: bySource,
      by_event_type: byEventType
    };
  }
}

/**
 * SQL migration for idempotency store table
 */
export const IDEMPOTENCY_STORE_MIGRATION = `
-- Idempotency store for exactly-once event processing (P2.1)
CREATE TABLE IF NOT EXISTS idempotency_store (
  id SERIAL PRIMARY KEY,
  source_system VARCHAR(64) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  event_id VARCHAR(256) NOT NULL,
  payload_hash VARCHAR(32) NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  processing_result VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  result_data JSONB,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  
  CONSTRAINT idempotency_unique_event 
    UNIQUE (source_system, event_type, event_id)
);

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_idempotency_first_seen 
  ON idempotency_store (first_seen_at);

-- Index for stats queries
CREATE INDEX IF NOT EXISTS idx_idempotency_source_type 
  ON idempotency_store (source_system, event_type, first_seen_at);
`;
