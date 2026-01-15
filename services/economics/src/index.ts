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

const port = process.env.PORT ? Number(process.env.PORT) : 7005;
app.listen(port, () => console.log(`economics service listening on :${port}`));
