/**
 * IDataSource Interface
 * 
 * Abstraction layer for data sources in BrokerOps.
 * Demo uses Postgres read models; production can swap to MT5 or other sources.
 * 
 * Decision: IDataSource is a READ interface. Write/ingest path remains separate.
 * Per PH1-W1-003: This preserves the proven simulator→audit-writer→postgres pipeline.
 */

import { z } from "zod";

// ============================================================================
// Common Types
// ============================================================================

export const OrderStatusSchema = z.enum([
  "SUBMITTED",
  "ACCEPTED",
  "REJECTED",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCELED",
  "EXPIRED",
  "UNKNOWN"
]);

export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const LpStatusSchema = z.enum([
  "CONNECTED",
  "DISCONNECTED",
  "UNKNOWN"
]);

export type LpStatus = z.infer<typeof LpStatusSchema>;

// ============================================================================
// Read Model Types
// ============================================================================

export interface Order {
  id: string;
  clientOrderId: string | null;
  lpOrderId: string | null;
  symbol: string;
  side: "BUY" | "SELL";
  orderType: string;
  qty: number;
  price: number | null;
  fillQty: number;
  avgFillPrice: number | null;
  remainingQty: number | null;
  status: OrderStatus;
  lpId: string | null;
  serverId: string;
  serverName: string;
  rejectionReasonCode: string | null;
  rejectionReasonClass: string | null;
  decisionTokenId: string | null;
  submittedAt: Date | null;
  acceptedAt: Date | null;
  filledAt: Date | null;
  rejectedAt: Date | null;
  canceledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderLifecycleEvent {
  id: string;
  orderId: string;
  eventId: string;
  eventType: string;
  status: OrderStatus;
  qty: number | null;
  price: number | null;
  fillQty: number | null;
  fillPrice: number | null;
  remainingQty: number | null;
  reasonCode: string | null;
  reasonClass: string | null;
  reasonMessage: string | null;
  payloadHash: string | null;
  prevEventHash: string | null;
  occurredAt: Date;
  ingestedAt: Date;
}

export interface LpAccount {
  id: string;
  name: string;
  serverId: string;
  serverName: string;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  marginLevel: number | null;
  status: LpStatus;
  lastHeartbeatAt: Date | null;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface LpSnapshot {
  id: string;
  lpId: string;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  marginLevel: number | null;
  sourceEventId: string | null;
  sourceTraceId: string | null;
  snapshotAt: Date;
  createdAt: Date;
}

export interface Rejection {
  id: string;
  orderId: string;
  eventId: string;
  lpId: string | null;
  serverId: string;
  serverName: string;
  symbol: string;
  rawCode: string | null;
  rawMessage: string | null;
  reasonCode: string;
  reasonClass: string;
  reasonMessage: string | null;
  normalizationConfidence: string | null;
  rejectedAt: Date;
  createdAt: Date;
}

// ============================================================================
// Query Parameters
// ============================================================================

export interface OrdersQuery {
  limit?: number;
  offset?: number;
  status?: OrderStatus;
  symbol?: string;
  lpId?: string;
}

export interface LpHistoryQuery {
  limit?: number;
  from?: Date;
  to?: Date;
}

export interface RejectionsQuery {
  limit?: number;
  lpId?: string;
  symbol?: string;
  reasonCode?: string;
  reasonClass?: string;
}

export interface RejectionRollup {
  key: string;
  count: number;
}

// ============================================================================
// Result Types
// ============================================================================

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

// ============================================================================
// IDataSource Interface
// ============================================================================

/**
 * Read-only data source interface for BrokerOps.
 * 
 * Implementations:
 * - PostgresDataSource: Reads from Postgres read-model tables (demo/production)
 * - MT5DataSource: Direct MT5 Manager API queries (future)
 * 
 * Write path is separate - events flow through:
 * simulator/MT5 → audit-writer → postgres (materialization)
 */
export interface IDataSource {
  // Connection lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Orders
  getOrders(query?: OrdersQuery): Promise<PaginatedResult<Order>>;
  getOrderById(id: string): Promise<Order | null>;
  getOrderLifecycle(orderId: string): Promise<OrderLifecycleEvent[]>;

  // LP Accounts
  getLpAccounts(): Promise<LpAccount[]>;
  getLpAccountById(id: string): Promise<LpAccount | null>;
  getLpAccountHistory(lpId: string, query?: LpHistoryQuery): Promise<LpSnapshot[]>;

  // Rejections
  getRejections(query?: RejectionsQuery): Promise<Rejection[]>;
  getRejectionRollupByReason(): Promise<RejectionRollup[]>;
  getRejectionRollupByLp(): Promise<RejectionRollup[]>;
  getRejectionRollupBySymbol(): Promise<RejectionRollup[]>;
}

// ============================================================================
// Factory Function
// ============================================================================

export type DataSourceType = "postgres" | "mt5";

/**
 * Factory for creating data source instances.
 * Implementations are in services/order-api/src/datasources/
 */
export function createDataSource(type: DataSourceType): IDataSource {
  switch (type) {
    case "postgres":
      // Import dynamically to avoid circular dependencies
      throw new Error("Use PostgresDataSource directly from services/order-api/src/datasources/postgres.ts");
    case "mt5":
      throw new Error("MT5DataSource not yet implemented");
    default:
      throw new Error(`Unknown data source type: ${type}`);
  }
}
