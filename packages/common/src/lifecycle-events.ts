/**
 * P2 Lifecycle Events Module
 * 
 * Defines event schemas for post-trade economics integration.
 * Based on P2-event-contract-spec.md
 * 
 * Event Flow:
 * AUTHORIZED_HOLD → execution.reported → EXECUTED → position.closed → CLOSED
 *                                                 → economics.reconciled (T+1)
 */

import { z } from "zod";

/**
 * Event envelope base schema
 */
export const EventEnvelopeSchema = z.object({
  event_type: z.string(),
  event_id: z.string().uuid(),
  event_timestamp: z.string().datetime(),
  idempotency_key: z.string()
});

/**
 * execution.reported - Trade fill notification from platform
 */
export const ExecutionReportedSchema = z.object({
  // Event envelope
  event_type: z.literal('execution.reported'),
  event_id: z.string().uuid(),
  event_timestamp: z.string().datetime(),
  idempotency_key: z.string(),
  
  // Correlation
  decision_token: z.string(),
  client_order_id: z.string(),
  
  // Execution details
  exec_id: z.string(),
  symbol: z.string(),
  side: z.enum(['BUY', 'SELL']),
  fill_qty: z.number().positive(),
  fill_price: z.number().positive(),
  fill_currency: z.string().default('USD'),
  fill_timestamp: z.string().datetime(),
  
  // Economics
  realized_notional: z.number(),
  commission: z.number().optional(),
  fees: z.number().optional(),
  
  // Source metadata
  source: z.enum(['PLATFORM', 'BACKOFFICE']),
  source_timestamp: z.string().datetime(),
  source_sequence: z.number().optional()
});

export type ExecutionReportedEvent = z.infer<typeof ExecutionReportedSchema>;

/**
 * position.closed - Position closure for P&L calculation
 */
export const PositionClosedSchema = z.object({
  // Event envelope
  event_type: z.literal('position.closed'),
  event_id: z.string().uuid(),
  event_timestamp: z.string().datetime(),
  idempotency_key: z.string(),
  
  // Correlation
  decision_token: z.string(),
  closing_decision_token: z.string().optional(),
  
  // Position details
  close_id: z.string(),
  symbol: z.string(),
  entry_price: z.number().positive(),
  exit_price: z.number().positive(),
  qty: z.number().positive(),
  side: z.enum(['BUY', 'SELL']),
  
  // Realized P&L
  realized_pnl: z.number(),
  realized_pnl_currency: z.string().default('USD'),
  pnl_source: z.enum(['PLATFORM', 'BACKOFFICE']),
  
  // Timing
  entry_timestamp: z.string().datetime(),
  exit_timestamp: z.string().datetime(),
  holding_period_days: z.number().optional(),
  
  // Reconciliation
  reconciliation_status: z.enum(['PENDING', 'CONFIRMED', 'DISCREPANCY']).optional(),
  backoffice_pnl: z.number().optional(),
  discrepancy_amount: z.number().optional()
});

export type PositionClosedEvent = z.infer<typeof PositionClosedSchema>;

/**
 * economics.reconciled - Back-office T+1 reconciliation
 */
export const EconomicsReconciledSchema = z.object({
  // Event envelope
  event_type: z.literal('economics.reconciled'),
  event_id: z.string().uuid(),
  event_timestamp: z.string().datetime(),
  idempotency_key: z.string(),
  
  // Correlation
  decision_tokens: z.array(z.string()),
  
  // Reconciliation scope
  trade_date: z.string(), // YYYY-MM-DD
  symbol: z.string(),
  account_id: z.string(),
  
  // Comparison
  platform_pnl: z.number(),
  backoffice_pnl: z.number(),
  discrepancy: z.number(),
  discrepancy_percent: z.number(),
  
  // Resolution
  authoritative_pnl: z.number(),
  adjustment_required: z.boolean(),
  adjustment_reason: z.string().optional()
});

export type EconomicsReconciledEvent = z.infer<typeof EconomicsReconciledSchema>;

/**
 * Union of all P2 lifecycle events
 */
export const LifecycleEventSchema = z.discriminatedUnion('event_type', [
  ExecutionReportedSchema,
  PositionClosedSchema,
  EconomicsReconciledSchema
]);

export type LifecycleEvent = z.infer<typeof LifecycleEventSchema>;

/**
 * P&L status for trace economics
 */
export type PnLStatus = 
  | 'PROJECTED'      // Decision-time only (no execution yet)
  | 'PROVISIONAL'    // Platform-reported (near real-time)
  | 'FINAL';         // Back-office confirmed (T+1)

/**
 * Realized economics for a decision
 */
export interface RealizedEconomics {
  decision_token: string;
  
  // Execution details
  fill_price?: number;
  fill_qty?: number;
  fill_timestamp?: string;
  
  // P&L
  realized_pnl?: number;
  pnl_status: PnLStatus;
  pnl_source?: 'PLATFORM' | 'BACKOFFICE';
  
  // If finalized
  final_pnl?: number;
  finalized_at?: string;
  
  // Accuracy metrics (when both platform and backoffice available)
  platform_pnl?: number;
  discrepancy?: number;
  discrepancy_percent?: number;
}

/**
 * Extended snapshot economics with realized data
 */
export interface ExtendedEconomics {
  // Projected (from decision time)
  projected_exposure_delta: number | null;
  projected_at: string;
  
  // Realized (from lifecycle events)
  realized?: RealizedEconomics;
  
  // Accuracy (when position closed)
  projection_accuracy?: number;  // 1 - |realized - projected| / projected
  slippage_bps?: number;         // (fill_price - decision_price) / decision_price * 10000
}

/**
 * Helper to generate idempotency key from event
 */
export function generateIdempotencyKey(event: LifecycleEvent): string {
  switch (event.event_type) {
    case 'execution.reported':
      return `exec:${event.exec_id}`;
    case 'position.closed':
      return `close:${event.close_id}`;
    case 'economics.reconciled':
      return `recon:${event.trade_date}:${event.symbol}:${event.account_id}`;
  }
}

/**
 * Extract source system from event
 */
export function extractSourceSystem(event: LifecycleEvent): string {
  switch (event.event_type) {
    case 'execution.reported':
      return event.source.toLowerCase();
    case 'position.closed':
      return event.pnl_source.toLowerCase();
    case 'economics.reconciled':
      return 'backoffice';
  }
}
