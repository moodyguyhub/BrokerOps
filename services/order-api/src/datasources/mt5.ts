/**
 * MT5DataSource - IDataSource stub implementation
 * 
 * Placeholder for future MT5 Manager API integration.
 * Currently throws UNIMPLEMENTED for all methods.
 */

import type {
  IDataSource,
  Order,
  OrderLifecycleEvent,
  LpAccount,
  LpSnapshot,
  Rejection,
  OrdersQuery,
  LpHistoryQuery,
  RejectionsQuery,
  RejectionRollup,
  PaginatedResult
} from "@broker/common";

export class MT5DataSourceError extends Error {
  constructor(method: string) {
    super(`MT5DataSource.${method}() not yet implemented. MT5 Manager API integration pending.`);
    this.name = "MT5DataSourceError";
  }
}

export interface MT5DataSourceConfig {
  // Future: MT5 Manager API connection settings
  server: string;
  login: number;
  password: string;
}

/**
 * MT5DataSource - Stub implementation
 * 
 * This data source will be implemented when MT5 Manager API integration is ready.
 * All methods currently throw UNIMPLEMENTED errors.
 * 
 * Integration plan:
 * 1. Use MetaTrader 5 Manager API (C++ with SWIG bindings or REST proxy)
 * 2. Map MT5 order states to BrokerOps OrderStatus
 * 3. Transform MT5 deal/position data to Order format
 * 4. Subscribe to real-time events via MT5 Manager events
 */
export class MT5DataSource implements IDataSource {
  private config: MT5DataSourceConfig | null = null;
  private connected: boolean = false;

  constructor(config?: MT5DataSourceConfig) {
    this.config = config ?? null;
  }

  async connect(): Promise<void> {
    throw new MT5DataSourceError("connect");
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ============================================================================
  // Orders - All throw UNIMPLEMENTED
  // ============================================================================

  async getOrders(_query?: OrdersQuery): Promise<PaginatedResult<Order>> {
    throw new MT5DataSourceError("getOrders");
  }

  async getOrderById(_id: string): Promise<Order | null> {
    throw new MT5DataSourceError("getOrderById");
  }

  async getOrderLifecycle(_orderId: string): Promise<OrderLifecycleEvent[]> {
    throw new MT5DataSourceError("getOrderLifecycle");
  }

  // ============================================================================
  // LP Accounts - All throw UNIMPLEMENTED
  // ============================================================================

  async getLpAccounts(): Promise<LpAccount[]> {
    throw new MT5DataSourceError("getLpAccounts");
  }

  async getLpAccountById(_id: string): Promise<LpAccount | null> {
    throw new MT5DataSourceError("getLpAccountById");
  }

  async getLpAccountHistory(_lpId: string, _query?: LpHistoryQuery): Promise<LpSnapshot[]> {
    throw new MT5DataSourceError("getLpAccountHistory");
  }

  // ============================================================================
  // Rejections - All throw UNIMPLEMENTED
  // ============================================================================

  async getRejections(_query?: RejectionsQuery): Promise<Rejection[]> {
    throw new MT5DataSourceError("getRejections");
  }

  async getRejectionRollupByReason(): Promise<RejectionRollup[]> {
    throw new MT5DataSourceError("getRejectionRollupByReason");
  }

  async getRejectionRollupByLp(): Promise<RejectionRollup[]> {
    throw new MT5DataSourceError("getRejectionRollupByLp");
  }

  async getRejectionRollupBySymbol(): Promise<RejectionRollup[]> {
    throw new MT5DataSourceError("getRejectionRollupBySymbol");
  }
}
