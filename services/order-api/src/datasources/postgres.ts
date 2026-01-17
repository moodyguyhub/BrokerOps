/**
 * PostgresDataSource - IDataSource implementation for Postgres read models
 * 
 * Reads from the materialized read-model tables populated by audit-writer.
 * This is the default implementation for demo and production.
 */

import pg from "pg";
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

const { Pool } = pg;

export interface PostgresDataSourceConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export class PostgresDataSource implements IDataSource {
  private pool: pg.Pool;
  private connected: boolean = false;

  constructor(config?: Partial<PostgresDataSourceConfig>) {
    this.pool = new Pool({
      host: config?.host ?? process.env.PGHOST ?? "localhost",
      port: config?.port ?? Number(process.env.PGPORT ?? 5434),
      user: config?.user ?? process.env.PGUSER ?? "broker",
      password: config?.password ?? process.env.PGPASSWORD ?? "broker",
      database: config?.database ?? process.env.PGDATABASE ?? "broker"
    });
  }

  async connect(): Promise<void> {
    // Test connection
    await this.pool.query("SELECT 1");
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    await this.pool.end();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ============================================================================
  // Orders
  // ============================================================================

  async getOrders(query?: OrdersQuery): Promise<PaginatedResult<Order>> {
    const { limit = 50, offset = 0, status, symbol, lpId } = query ?? {};
    
    let sql = `
      SELECT id, client_order_id, lp_order_id, symbol, side, order_type, qty, price,
             fill_qty, avg_fill_price, remaining_qty, status, lp_id, server_id, server_name,
             rejection_reason_code, rejection_reason_class, decision_token_id,
             submitted_at, accepted_at, filled_at, rejected_at, canceled_at, created_at, updated_at
      FROM orders
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;
    
    if (status) {
      sql += ` AND status = $${paramIndex++}`;
      params.push(status);
    }
    if (symbol) {
      sql += ` AND symbol = $${paramIndex++}`;
      params.push(symbol);
    }
    if (lpId) {
      sql += ` AND lp_id = $${paramIndex++}`;
      params.push(lpId);
    }
    
    sql += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(limit, offset);
    
    const result = await this.pool.query(sql, params);
    
    // Get total count
    let countSql = `SELECT COUNT(*) FROM orders WHERE 1=1`;
    const countParams: any[] = [];
    let countParamIndex = 1;
    if (status) {
      countSql += ` AND status = $${countParamIndex++}`;
      countParams.push(status);
    }
    if (symbol) {
      countSql += ` AND symbol = $${countParamIndex++}`;
      countParams.push(symbol);
    }
    if (lpId) {
      countSql += ` AND lp_id = $${countParamIndex++}`;
      countParams.push(lpId);
    }
    const countResult = await this.pool.query(countSql, countParams);
    const total = parseInt(countResult.rows[0].count);
    
    return {
      data: result.rows.map(this.mapOrderRow),
      total,
      limit,
      offset,
      hasMore: offset + result.rows.length < total
    };
  }

  async getOrderById(id: string): Promise<Order | null> {
    const result = await this.pool.query(`
      SELECT id, client_order_id, lp_order_id, symbol, side, order_type, qty, price,
             fill_qty, avg_fill_price, remaining_qty, status, lp_id, server_id, server_name,
             rejection_reason_code, rejection_reason_class, decision_token_id,
             submitted_at, accepted_at, filled_at, rejected_at, canceled_at, created_at, updated_at
      FROM orders WHERE id = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return this.mapOrderRow(result.rows[0]);
  }

  async getOrderLifecycle(orderId: string): Promise<OrderLifecycleEvent[]> {
    const result = await this.pool.query(`
      SELECT id, order_id, event_id, event_type, status, qty, price, fill_qty, fill_price,
             remaining_qty, reason_code, reason_class, reason_message, payload_hash,
             prev_event_hash, occurred_at, ingested_at
      FROM order_lifecycle_events
      WHERE order_id = $1
      ORDER BY occurred_at ASC
    `, [orderId]);
    
    return result.rows.map(this.mapLifecycleRow);
  }

  // ============================================================================
  // LP Accounts
  // ============================================================================

  async getLpAccounts(): Promise<LpAccount[]> {
    const result = await this.pool.query(`
      SELECT id, name, server_id, server_name, balance, equity, margin, free_margin,
             margin_level, status, last_heartbeat_at, currency, created_at, updated_at
      FROM lp_accounts
      ORDER BY name ASC
    `);
    
    return result.rows.map(this.mapLpAccountRow);
  }

  async getLpAccountById(id: string): Promise<LpAccount | null> {
    const result = await this.pool.query(`
      SELECT id, name, server_id, server_name, balance, equity, margin, free_margin,
             margin_level, status, last_heartbeat_at, currency, created_at, updated_at
      FROM lp_accounts WHERE id = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return this.mapLpAccountRow(result.rows[0]);
  }

  async getLpAccountHistory(lpId: string, query?: LpHistoryQuery): Promise<LpSnapshot[]> {
    const { limit = 100, from, to } = query ?? {};
    
    let sql = `
      SELECT id, lp_id, balance, equity, margin, free_margin, margin_level,
             source_event_id, source_trace_id, snapshot_at, created_at
      FROM lp_snapshots
      WHERE lp_id = $1
    `;
    const params: any[] = [lpId];
    let paramIndex = 2;
    
    if (from) {
      sql += ` AND snapshot_at >= $${paramIndex++}`;
      params.push(from);
    }
    if (to) {
      sql += ` AND snapshot_at <= $${paramIndex++}`;
      params.push(to);
    }
    
    sql += ` ORDER BY snapshot_at DESC LIMIT $${paramIndex++}`;
    params.push(limit);
    
    const result = await this.pool.query(sql, params);
    
    return result.rows.map(this.mapLpSnapshotRow);
  }

  // ============================================================================
  // Rejections
  // ============================================================================

  async getRejections(query?: RejectionsQuery): Promise<Rejection[]> {
    const { limit = 100, lpId, symbol, reasonCode, reasonClass } = query ?? {};
    
    let sql = `
      SELECT id, order_id, event_id, lp_id, server_id, server_name, symbol,
             raw_code, raw_message, reason_code, reason_class, reason_message,
             normalization_confidence, rejected_at, created_at
      FROM rejections
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;
    
    if (lpId) {
      sql += ` AND lp_id = $${paramIndex++}`;
      params.push(lpId);
    }
    if (symbol) {
      sql += ` AND symbol = $${paramIndex++}`;
      params.push(symbol);
    }
    if (reasonCode) {
      sql += ` AND reason_code = $${paramIndex++}`;
      params.push(reasonCode);
    }
    if (reasonClass) {
      sql += ` AND reason_class = $${paramIndex++}`;
      params.push(reasonClass);
    }
    
    sql += ` ORDER BY rejected_at DESC LIMIT $${paramIndex++}`;
    params.push(limit);
    
    const result = await this.pool.query(sql, params);
    
    return result.rows.map(this.mapRejectionRow);
  }

  async getRejectionRollupByReason(): Promise<RejectionRollup[]> {
    const result = await this.pool.query(`
      SELECT reason_code as key, COUNT(*)::int as count
      FROM rejections
      GROUP BY reason_code
      ORDER BY count DESC
    `);
    return result.rows;
  }

  async getRejectionRollupByLp(): Promise<RejectionRollup[]> {
    const result = await this.pool.query(`
      SELECT COALESCE(lp_id, server_id) as key, COUNT(*)::int as count
      FROM rejections
      GROUP BY COALESCE(lp_id, server_id)
      ORDER BY count DESC
    `);
    return result.rows;
  }

  async getRejectionRollupBySymbol(): Promise<RejectionRollup[]> {
    const result = await this.pool.query(`
      SELECT symbol as key, COUNT(*)::int as count
      FROM rejections
      GROUP BY symbol
      ORDER BY count DESC
    `);
    return result.rows;
  }

  // ============================================================================
  // Row Mappers
  // ============================================================================

  private mapOrderRow(row: any): Order {
    return {
      id: row.id,
      clientOrderId: row.client_order_id,
      lpOrderId: row.lp_order_id,
      symbol: row.symbol,
      side: row.side,
      orderType: row.order_type,
      qty: parseFloat(row.qty),
      price: row.price ? parseFloat(row.price) : null,
      fillQty: parseFloat(row.fill_qty || 0),
      avgFillPrice: row.avg_fill_price ? parseFloat(row.avg_fill_price) : null,
      remainingQty: row.remaining_qty ? parseFloat(row.remaining_qty) : null,
      status: row.status,
      lpId: row.lp_id,
      serverId: row.server_id,
      serverName: row.server_name,
      rejectionReasonCode: row.rejection_reason_code,
      rejectionReasonClass: row.rejection_reason_class,
      decisionTokenId: row.decision_token_id,
      submittedAt: row.submitted_at ? new Date(row.submitted_at) : null,
      acceptedAt: row.accepted_at ? new Date(row.accepted_at) : null,
      filledAt: row.filled_at ? new Date(row.filled_at) : null,
      rejectedAt: row.rejected_at ? new Date(row.rejected_at) : null,
      canceledAt: row.canceled_at ? new Date(row.canceled_at) : null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  private mapLifecycleRow(row: any): OrderLifecycleEvent {
    return {
      id: row.id.toString(),
      orderId: row.order_id,
      eventId: row.event_id,
      eventType: row.event_type,
      status: row.status,
      qty: row.qty ? parseFloat(row.qty) : null,
      price: row.price ? parseFloat(row.price) : null,
      fillQty: row.fill_qty ? parseFloat(row.fill_qty) : null,
      fillPrice: row.fill_price ? parseFloat(row.fill_price) : null,
      remainingQty: row.remaining_qty ? parseFloat(row.remaining_qty) : null,
      reasonCode: row.reason_code,
      reasonClass: row.reason_class,
      reasonMessage: row.reason_message,
      payloadHash: row.payload_hash,
      prevEventHash: row.prev_event_hash,
      occurredAt: new Date(row.occurred_at),
      ingestedAt: new Date(row.ingested_at)
    };
  }

  private mapLpAccountRow(row: any): LpAccount {
    return {
      id: row.id,
      name: row.name,
      serverId: row.server_id,
      serverName: row.server_name,
      balance: parseFloat(row.balance),
      equity: parseFloat(row.equity),
      margin: parseFloat(row.margin),
      freeMargin: parseFloat(row.free_margin),
      marginLevel: row.margin_level ? parseFloat(row.margin_level) : null,
      status: row.status,
      lastHeartbeatAt: row.last_heartbeat_at ? new Date(row.last_heartbeat_at) : null,
      currency: row.currency,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  private mapLpSnapshotRow(row: any): LpSnapshot {
    return {
      id: row.id.toString(),
      lpId: row.lp_id,
      balance: parseFloat(row.balance),
      equity: parseFloat(row.equity),
      margin: parseFloat(row.margin),
      freeMargin: parseFloat(row.free_margin),
      marginLevel: row.margin_level ? parseFloat(row.margin_level) : null,
      sourceEventId: row.source_event_id,
      sourceTraceId: row.source_trace_id,
      snapshotAt: new Date(row.snapshot_at),
      createdAt: new Date(row.created_at)
    };
  }

  private mapRejectionRow(row: any): Rejection {
    return {
      id: row.id.toString(),
      orderId: row.order_id,
      eventId: row.event_id,
      lpId: row.lp_id,
      serverId: row.server_id,
      serverName: row.server_name,
      symbol: row.symbol,
      rawCode: row.raw_code,
      rawMessage: row.raw_message,
      reasonCode: row.reason_code,
      reasonClass: row.reason_class,
      reasonMessage: row.reason_message,
      normalizationConfidence: row.normalization_confidence,
      rejectedAt: new Date(row.rejected_at),
      createdAt: new Date(row.created_at)
    };
  }
}
