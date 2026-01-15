import express from "express";
import crypto from "crypto";
import pg from "pg";
import { z } from "zod";
import { emitWebhook } from "@broker/common";

const { Pool } = pg;

const app = express();
app.use(express.json({ limit: "1mb" }));

const pool = new Pool({
  host: process.env.PGHOST ?? "localhost",
  port: Number(process.env.PGPORT ?? 5434),
  user: process.env.PGUSER ?? "broker",
  password: process.env.PGPASSWORD ?? "broker",
  database: process.env.PGDATABASE ?? "broker"
});

// --- Schema for economic events ---

const EconomicEventSchema = z.object({
  traceId: z.string().min(8),
  type: z.enum(["TRADE_EXECUTED", "TRADE_BLOCKED", "OVERRIDE_APPROVED", "OVERRIDE_DENIED"]),
  grossRevenue: z.number().optional(),
  fees: z.number().optional(),
  costs: z.number().optional(),
  estimatedLostRevenue: z.number().optional(),
  currency: z.string().default("USD"),
  source: z.string().optional(),
  policyId: z.string().optional() // For aggregation by policy
});

type EconomicEvent = z.infer<typeof EconomicEventSchema>;

// --- Hash chain helpers (same pattern as audit-writer) ---

function canonicalJson(x: unknown): string {
  const sort = (v: any): any => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.keys(v).sort().reduce((acc: any, k) => {
        acc[k] = sort(v[k]);
        return acc;
      }, {});
    }
    return v;
  };
  return JSON.stringify(sort(x));
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

async function getLastHash(): Promise<string | null> {
  const r = await pool.query(
    "SELECT hash FROM economic_events ORDER BY id DESC LIMIT 1"
  );
  return r.rowCount ? (r.rows[0].hash as string) : null;
}

// --- Endpoints ---

// 1. Record an economic event (append-only, hash-chained)
app.post("/economics/event", async (req, res) => {
  const parsed = EconomicEventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid event", details: parsed.error.format() });
  }

  const evt = parsed.data;
  const prevHash = await getLastHash();
  const material = (prevHash ?? "") + "|" + canonicalJson(evt);
  const hash = sha256(material);

  await pool.query(
    `INSERT INTO economic_events(
      trace_id, event_type, gross_revenue, fees, costs, estimated_lost_revenue,
      currency, source, policy_id, prev_hash, hash
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      evt.traceId,
      evt.type,
      evt.grossRevenue ?? null,
      evt.fees ?? null,
      evt.costs ?? null,
      evt.estimatedLostRevenue ?? null,
      evt.currency,
      evt.source ?? null,
      evt.policyId ?? null,
      prevHash,
      hash
    ]
  );

  // Emit webhook
  await emitWebhook("economics.recorded", evt.traceId, {
    type: evt.type,
    grossRevenue: evt.grossRevenue,
    estimatedLostRevenue: evt.estimatedLostRevenue,
    currency: evt.currency,
    policyId: evt.policyId
  });

  res.json({ ok: true, traceId: evt.traceId, hash });
});

// 2. Aggregate summary (read-only)
app.get("/economics/summary", async (_, res) => {
  // Total aggregates
  const totals = await pool.query(`
    SELECT 
      COALESCE(SUM(gross_revenue), 0) as total_revenue,
      COALESCE(SUM(fees), 0) as total_fees,
      COALESCE(SUM(costs), 0) as total_costs,
      COALESCE(SUM(estimated_lost_revenue), 0) as lost_revenue
    FROM economic_events
  `);

  // By policy (for blocks)
  const byPolicy = await pool.query(`
    SELECT 
      policy_id,
      COALESCE(SUM(estimated_lost_revenue), 0) as lost_revenue
    FROM economic_events
    WHERE policy_id IS NOT NULL
    GROUP BY policy_id
  `);

  // By override type
  const byOverride = await pool.query(`
    SELECT 
      event_type,
      COALESCE(SUM(gross_revenue), 0) - COALESCE(SUM(costs), 0) as net_impact
    FROM economic_events
    WHERE event_type IN ('OVERRIDE_APPROVED', 'OVERRIDE_DENIED')
    GROUP BY event_type
  `);

  const t = totals.rows[0];
  const totalRevenue = parseFloat(t.total_revenue);
  const totalCosts = parseFloat(t.total_costs) + parseFloat(t.total_fees);
  const lostRevenue = parseFloat(t.lost_revenue);

  res.json({
    totalRevenue,
    totalCosts,
    netImpact: totalRevenue - totalCosts,
    lostRevenue,
    byPolicy: byPolicy.rows.reduce((acc: Record<string, number>, row) => {
      if (row.policy_id) acc[row.policy_id] = -parseFloat(row.lost_revenue);
      return acc;
    }, {}),
    byOverride: byOverride.rows.reduce((acc: Record<string, number>, row) => {
      const key = row.event_type === "OVERRIDE_APPROVED" ? "approved" : "denied";
      acc[key] = parseFloat(row.net_impact);
      return acc;
    }, {})
  });
});

// 3. Trace-level economics
app.get("/economics/trace/:traceId", async (req, res) => {
  const { traceId } = req.params;
  
  const result = await pool.query(
    `SELECT 
      event_type as type,
      gross_revenue,
      fees,
      costs,
      estimated_lost_revenue,
      currency,
      source,
      policy_id,
      created_at
    FROM economic_events
    WHERE trace_id = $1
    ORDER BY id ASC`,
    [traceId]
  );

  if (result.rowCount === 0) {
    return res.json({ traceId, events: [] });
  }

  const events = result.rows.map(row => ({
    type: row.type,
    grossRevenue: row.gross_revenue ? parseFloat(row.gross_revenue) : undefined,
    fees: row.fees ? parseFloat(row.fees) : undefined,
    costs: row.costs ? parseFloat(row.costs) : undefined,
    estimatedLostRevenue: row.estimated_lost_revenue ? parseFloat(row.estimated_lost_revenue) : undefined,
    currency: row.currency,
    source: row.source,
    policyId: row.policy_id,
    createdAt: row.created_at
  }));

  // Calculate trace-level summary
  const summary = {
    totalRevenue: events.reduce((sum, e) => sum + (e.grossRevenue ?? 0), 0),
    totalCosts: events.reduce((sum, e) => sum + (e.costs ?? 0) + (e.fees ?? 0), 0),
    estimatedLostRevenue: events.reduce((sum, e) => sum + (e.estimatedLostRevenue ?? 0), 0),
    currency: events[0]?.currency ?? "USD"
  };

  res.json({ traceId, events, summary });
});

// 4. Saved Exposure KPI (P1) - Total blocked notional
app.get("/economics/saved-exposure", async (req, res) => {
  // Time window filter (default: last 24h)
  const hoursBack = parseInt(req.query.hours as string) || 24;
  const sinceTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  
  // Total saved exposure (sum of blocked notional)
  const totals = await pool.query(`
    SELECT 
      COALESCE(SUM(estimated_lost_revenue), 0) as saved_exposure,
      COUNT(*) as blocked_count
    FROM economic_events
    WHERE event_type = 'TRADE_BLOCKED'
      AND created_at >= $1
  `, [sinceTime]);

  // Previous period for comparison
  const previousSinceTime = new Date(Date.now() - 2 * hoursBack * 60 * 60 * 1000).toISOString();
  const previousEndTime = sinceTime;
  
  const previousTotals = await pool.query(`
    SELECT 
      COALESCE(SUM(estimated_lost_revenue), 0) as saved_exposure
    FROM economic_events
    WHERE event_type = 'TRADE_BLOCKED'
      AND created_at >= $1
      AND created_at < $2
  `, [previousSinceTime, previousEndTime]);

  const current = parseFloat(totals.rows[0].saved_exposure);
  const previous = parseFloat(previousTotals.rows[0].saved_exposure);
  const change = previous > 0 ? ((current - previous) / previous) * 100 : 0;

  // By policy breakdown
  const byPolicy = await pool.query(`
    SELECT 
      policy_id,
      COALESCE(SUM(estimated_lost_revenue), 0) as saved_exposure,
      COUNT(*) as count
    FROM economic_events
    WHERE event_type = 'TRADE_BLOCKED'
      AND created_at >= $1
    GROUP BY policy_id
    ORDER BY saved_exposure DESC
  `, [sinceTime]);

  res.json({
    saved_exposure: current,
    blocked_count: parseInt(totals.rows[0].blocked_count),
    currency: 'USD',
    period_hours: hoursBack,
    change_percent: Math.round(change * 10) / 10,
    previous_period: previous,
    by_policy: byPolicy.rows.map(r => ({
      policy_id: r.policy_id ?? 'UNKNOWN',
      saved_exposure: parseFloat(r.saved_exposure),
      count: parseInt(r.count)
    }))
  });
});

// 5. Coverage Statistics (P1-R2) - Price coverage %
app.get("/economics/coverage", async (req, res) => {
  // Time window filter (default: last 24h)
  const hoursBack = parseInt(req.query.hours as string) || 24;
  const sinceTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  
  // Total decisions (TRADE_EXECUTED + TRADE_BLOCKED)
  const totals = await pool.query(`
    SELECT 
      COUNT(*) as total_decisions,
      COUNT(*) FILTER (WHERE estimated_lost_revenue > 0 OR gross_revenue > 0) as decisions_with_value,
      COUNT(*) FILTER (WHERE currency = 'USD') as decisions_usd,
      COUNT(*) FILTER (WHERE currency != 'USD') as decisions_non_usd
    FROM economic_events
    WHERE event_type IN ('TRADE_EXECUTED', 'TRADE_BLOCKED')
      AND created_at >= $1
  `, [sinceTime]);

  const total = parseInt(totals.rows[0].total_decisions);
  const withValue = parseInt(totals.rows[0].decisions_with_value);
  const usd = parseInt(totals.rows[0].decisions_usd);
  const nonUsd = parseInt(totals.rows[0].decisions_non_usd);

  res.json({
    total_decisions: total,
    decisions_with_price: withValue,
    coverage_percent: total > 0 ? Math.round((withValue / total) * 1000) / 10 : 0,
    decisions_usd: usd,
    decisions_non_usd: nonUsd,
    usd_percent: total > 0 ? Math.round((usd / total) * 1000) / 10 : 100,
    period_hours: hoursBack,
    warning: nonUsd > 0 ? `${nonUsd} non-USD decisions excluded from aggregation` : undefined
  });
});

// Health check
app.get("/health", async (_, res) => {
  const r = await pool.query("SELECT 1 as ok");
  res.json({ ok: r.rows?.[0]?.ok === 1 });
});

// --- P2.3: Provisional P&L (Platform Layer) ---

/**
 * POST /economics/realized - Record provisional P&L from platform
 */
app.post("/economics/realized", async (req, res) => {
  const { decision_token, trace_id, fill_price, fill_qty, realized_pnl, source } = req.body;

  if (!decision_token || !trace_id) {
    return res.status(400).json({ error: "Missing decision_token or trace_id" });
  }

  try {
    await pool.query(`
      INSERT INTO realized_economics (
        decision_token, trace_id, fill_price, fill_qty, fill_timestamp,
        realized_pnl, pnl_status, pnl_source, platform_pnl
      ) VALUES ($1, $2, $3, $4, NOW(), $5, 'PROVISIONAL', $6, $5)
      ON CONFLICT (decision_token) DO UPDATE SET
        fill_price = COALESCE($3, realized_economics.fill_price),
        fill_qty = COALESCE($4, realized_economics.fill_qty),
        fill_timestamp = NOW(),
        realized_pnl = $5,
        pnl_source = $6,
        platform_pnl = $5,
        updated_at = NOW()
    `, [decision_token, trace_id, fill_price, fill_qty, realized_pnl, source ?? 'PLATFORM']);

    res.json({
      status: "recorded",
      decision_token,
      pnl_status: "PROVISIONAL",
      realized_pnl
    });
  } catch (err) {
    console.error("Failed to record realized P&L:", err);
    res.status(500).json({ error: "Recording failed" });
  }
});

/**
 * GET /economics/realized/:decisionToken - Get realized economics for a decision
 */
app.get("/economics/realized/:decisionToken", async (req, res) => {
  const { decisionToken } = req.params;

  try {
    const result = await pool.query(`
      SELECT 
        decision_token, trace_id, fill_price, fill_qty, fill_timestamp,
        realized_pnl, pnl_status, pnl_source, final_pnl, finalized_at,
        platform_pnl, discrepancy, discrepancy_percent, created_at, updated_at
      FROM realized_economics
      WHERE decision_token = $1
    `, [decisionToken]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "No realized economics found" });
    }

    const row = result.rows[0];
    res.json({
      decision_token: row.decision_token,
      trace_id: row.trace_id,
      fill_price: row.fill_price ? parseFloat(row.fill_price) : null,
      fill_qty: row.fill_qty,
      fill_timestamp: row.fill_timestamp,
      realized_pnl: row.realized_pnl ? parseFloat(row.realized_pnl) : null,
      pnl_status: row.pnl_status,
      pnl_source: row.pnl_source,
      final_pnl: row.final_pnl ? parseFloat(row.final_pnl) : null,
      finalized_at: row.finalized_at,
      platform_pnl: row.platform_pnl ? parseFloat(row.platform_pnl) : null,
      discrepancy: row.discrepancy ? parseFloat(row.discrepancy) : null,
      discrepancy_percent: row.discrepancy_percent ? parseFloat(row.discrepancy_percent) : null
    });
  } catch {
    res.status(500).json({ error: "Query failed" });
  }
});

// --- P2.4: Back-office Finalization (Settlement Layer) ---

/**
 * POST /economics/finalize - Finalize P&L from back-office (T+1)
 */
app.post("/economics/finalize", async (req, res) => {
  const { decision_token, authoritative_pnl, trade_date, adjustment_reason } = req.body;

  if (!decision_token || authoritative_pnl === undefined) {
    return res.status(400).json({ error: "Missing decision_token or authoritative_pnl" });
  }

  try {
    // Get current state
    const current = await pool.query(`
      SELECT platform_pnl, pnl_status
      FROM realized_economics
      WHERE decision_token = $1
    `, [decision_token]);

    if (current.rows.length === 0) {
      // Create new record if no provisional exists
      await pool.query(`
        INSERT INTO realized_economics (
          decision_token, trace_id, final_pnl, finalized_at,
          pnl_status, pnl_source
        ) VALUES ($1, $1, $2, NOW(), 'FINAL', 'BACKOFFICE')
      `, [decision_token, authoritative_pnl]);

      return res.json({
        status: "created",
        decision_token,
        pnl_status: "FINAL",
        final_pnl: authoritative_pnl,
        discrepancy: null
      });
    }

    const platformPnl = current.rows[0].platform_pnl ? parseFloat(current.rows[0].platform_pnl) : 0;
    const discrepancy = authoritative_pnl - platformPnl;
    const discrepancyPercent = platformPnl !== 0 ? (discrepancy / platformPnl) * 100 : 0;

    await pool.query(`
      UPDATE realized_economics
      SET final_pnl = $2,
          finalized_at = NOW(),
          pnl_status = 'FINAL',
          discrepancy = $3,
          discrepancy_percent = $4,
          updated_at = NOW()
      WHERE decision_token = $1
    `, [decision_token, authoritative_pnl, discrepancy, discrepancyPercent]);

    // Log if significant discrepancy (>1%)
    if (Math.abs(discrepancyPercent) > 1) {
      console.warn(`P&L discrepancy for ${decision_token}: platform=${platformPnl}, backoffice=${authoritative_pnl}, diff=${discrepancy} (${discrepancyPercent.toFixed(2)}%)`);
    }

    res.json({
      status: "finalized",
      decision_token,
      pnl_status: "FINAL",
      final_pnl: authoritative_pnl,
      platform_pnl: platformPnl,
      discrepancy,
      discrepancy_percent: Math.round(discrepancyPercent * 100) / 100
    });
  } catch (err) {
    console.error("Failed to finalize P&L:", err);
    res.status(500).json({ error: "Finalization failed" });
  }
});

/**
 * GET /economics/accuracy - P&L accuracy metrics
 */
app.get("/economics/accuracy", async (req, res) => {
  const hoursBack = parseInt(req.query.hours as string) || 24;
  const sinceTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_finalized,
        COUNT(*) FILTER (WHERE ABS(discrepancy_percent) <= 1) as within_1pct,
        COUNT(*) FILTER (WHERE ABS(discrepancy_percent) > 1 AND ABS(discrepancy_percent) <= 5) as within_5pct,
        COUNT(*) FILTER (WHERE ABS(discrepancy_percent) > 5) as over_5pct,
        AVG(ABS(discrepancy_percent)) as avg_discrepancy_pct,
        SUM(ABS(discrepancy)) as total_discrepancy_usd
      FROM realized_economics
      WHERE pnl_status = 'FINAL'
        AND finalized_at >= $1
    `, [sinceTime]);

    const row = result.rows[0];
    const total = parseInt(row.total_finalized);

    res.json({
      period_hours: hoursBack,
      total_finalized: total,
      accuracy_breakdown: {
        within_1pct: parseInt(row.within_1pct),
        within_1pct_pct: total > 0 ? Math.round((parseInt(row.within_1pct) / total) * 1000) / 10 : 0,
        within_5pct: parseInt(row.within_5pct),
        over_5pct: parseInt(row.over_5pct)
      },
      avg_discrepancy_percent: row.avg_discrepancy_pct ? parseFloat(row.avg_discrepancy_pct).toFixed(2) : 0,
      total_discrepancy_usd: row.total_discrepancy_usd ? parseFloat(row.total_discrepancy_usd) : 0
    });
  } catch {
    res.json({
      period_hours: hoursBack,
      total_finalized: 0,
      accuracy_breakdown: { within_1pct: 0, within_1pct_pct: 0, within_5pct: 0, over_5pct: 0 },
      avg_discrepancy_percent: 0,
      total_discrepancy_usd: 0
    });
  }
});

const port = process.env.PORT ? Number(process.env.PORT) : 7005;
app.listen(port, () => console.log(`economics service listening on :${port}`));
