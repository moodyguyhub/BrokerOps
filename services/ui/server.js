import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// API proxy configuration
const API_URLS = {
  reconstruction: process.env.RECONSTRUCTION_URL ?? "http://localhost:7004",
  economics: process.env.ECONOMICS_URL ?? "http://localhost:7005",
  webhooks: process.env.WEBHOOKS_URL ?? "http://localhost:7006",
  riskGate: process.env.RISK_GATE_URL ?? "http://localhost:7002",
  orderApi: process.env.ORDER_API_URL ?? "http://localhost:7001"
};

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// API proxy endpoints (to avoid CORS issues)
app.get("/api/traces/recent", async (req, res) => {
  try {
    const resp = await fetch(`${API_URLS.reconstruction}/traces/recent?limit=${req.query.limit || 50}`);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch traces" });
  }
});

app.get("/api/lp-timelines/recent", async (req, res) => {
  try {
    const url = new URL(`${API_URLS.reconstruction}/lp-timelines/recent`);
    if (req.query.limit) url.searchParams.set("limit", String(req.query.limit));
    if (req.query.server_id) url.searchParams.set("server_id", String(req.query.server_id));
    const resp = await fetch(url.toString());
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch lp timelines" });
  }
});

app.get("/api/lp-timeline/:traceId", async (req, res) => {
  try {
    const resp = await fetch(`${API_URLS.reconstruction}/lp-timeline/${req.params.traceId}`);
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch lp timeline" });
  }
});

app.get("/api/trace/:traceId/bundle", async (req, res) => {
  try {
    const resp = await fetch(`${API_URLS.reconstruction}/trace/${req.params.traceId}/bundle`);
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch bundle" });
  }
});

app.get("/api/economics/trace/:traceId", async (req, res) => {
  try {
    const resp = await fetch(`${API_URLS.economics}/economics/trace/${req.params.traceId}`);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch economics" });
  }
});

app.get("/api/economics/summary", async (req, res) => {
  try {
    const resp = await fetch(`${API_URLS.economics}/economics/summary`);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch economics summary", estimatedLostRevenue: 0 });
  }
});

// P1: Saved Exposure KPI endpoint
app.get("/api/economics/saved-exposure", async (req, res) => {
  try {
    const url = new URL(`${API_URLS.economics}/economics/saved-exposure`);
    if (req.query.hours) url.searchParams.set("hours", String(req.query.hours));
    const resp = await fetch(url.toString());
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    // Return zero if endpoint not available yet
    res.json({ 
      saved_exposure: 0, 
      blocked_count: 0, 
      currency: 'USD',
      period_hours: 24,
      change_percent: 0,
      by_policy: []
    });
  }
});

// P1-R2: Coverage Statistics endpoint
app.get("/api/economics/coverage", async (req, res) => {
  try {
    const url = new URL(`${API_URLS.economics}/economics/coverage`);
    if (req.query.hours) url.searchParams.set("hours", String(req.query.hours));
    const resp = await fetch(url.toString());
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    // Return 100% coverage if endpoint not available yet
    res.json({ 
      total_decisions: 0, 
      decisions_with_price: 0,
      coverage_percent: 100,
      decisions_usd: 0,
      decisions_non_usd: 0,
      usd_percent: 100,
      period_hours: 24
    });
  }
});

app.get("/api/webhooks", async (req, res) => {
  try {
    const resp = await fetch(`${API_URLS.webhooks}/webhooks`);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch webhooks" });
  }
});

app.get("/api/webhooks/deliveries", async (req, res) => {
  try {
    const url = new URL(`${API_URLS.webhooks}/webhooks/deliveries`);
    if (req.query.limit) url.searchParams.set("limit", String(req.query.limit));
    if (req.query.webhookId) url.searchParams.set("webhookId", String(req.query.webhookId));
    const resp = await fetch(url.toString());
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch deliveries" });
  }
});

// P2: Policy Playground - dry run evaluation (via risk-gate direct)
app.post("/api/risk/evaluate", async (req, res) => {
  try {
    const resp = await fetch(`${API_URLS.riskGate}/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body)
    });
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to evaluate policy" });
  }
});

// Policy Playground - full dry-run via order-api (includes preview economics)
app.post("/api/dry-run", async (req, res) => {
  try {
    const resp = await fetch(`${API_URLS.orderApi}/dry-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body)
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to run dry-run evaluation", dryRun: true });
  }
});

// Pending overrides endpoint (returns count for KPI)
app.get("/api/overrides/pending", async (req, res) => {
  try {
    const resp = await fetch(`${API_URLS.reconstruction}/overrides/pending`);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    // Return 0 if endpoint not available yet
    res.json({ count: 0, pendingOverrides: [] });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({ 
    ok: true, 
    service: "ui",
    version: "0.2.0",
    apiBase: API_URLS.orderApi
  });
});

// ============================================================================
// Week 4 API Proxies - Dashboard, Alerts, LP Accounts, Orders
// ============================================================================

// Dashboard KPIs
app.get("/api/dashboard/kpis", async (req, res) => {
  try {
    const url = new URL(`${API_URLS.orderApi}/api/dashboard/kpis`);
    if (req.query.window) url.searchParams.set("window", String(req.query.window));
    const resp = await fetch(url.toString());
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch dashboard KPIs" });
  }
});

// Dashboard Timeline
app.get("/api/dashboard/timeline", async (req, res) => {
  try {
    const url = new URL(`${API_URLS.orderApi}/api/dashboard/timeline`);
    if (req.query.window) url.searchParams.set("window", String(req.query.window));
    if (req.query.bucket) url.searchParams.set("bucket", String(req.query.bucket));
    const resp = await fetch(url.toString());
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch dashboard timeline" });
  }
});

// Alerts list
app.get("/api/alerts", async (req, res) => {
  try {
    const url = new URL(`${API_URLS.orderApi}/api/alerts`);
    for (const [key, value] of Object.entries(req.query)) {
      url.searchParams.set(key, String(value));
    }
    const resp = await fetch(url.toString());
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch alerts" });
  }
});

// Acknowledge alert
app.post("/api/alerts/:id/ack", async (req, res) => {
  try {
    const resp = await fetch(`${API_URLS.orderApi}/api/alerts/${req.params.id}/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body)
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to acknowledge alert" });
  }
});

// Alert settings
app.get("/api/alert-settings", async (req, res) => {
  try {
    const resp = await fetch(`${API_URLS.orderApi}/api/alert-settings`);
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch alert settings" });
  }
});

app.put("/api/alert-settings", async (req, res) => {
  try {
    const resp = await fetch(`${API_URLS.orderApi}/api/alert-settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body)
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to update alert settings" });
  }
});

// LP Accounts
app.get("/api/lp-accounts", async (req, res) => {
  try {
    const resp = await fetch(`${API_URLS.orderApi}/api/lp-accounts`);
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch LP accounts" });
  }
});

app.get("/api/lp-accounts/:id/history", async (req, res) => {
  try {
    const url = new URL(`${API_URLS.orderApi}/api/lp-accounts/${req.params.id}/history`);
    if (req.query.limit) url.searchParams.set("limit", String(req.query.limit));
    const resp = await fetch(url.toString());
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch LP history" });
  }
});

// Orders
app.get("/api/orders", async (req, res) => {
  try {
    const url = new URL(`${API_URLS.orderApi}/api/orders`);
    for (const [key, value] of Object.entries(req.query)) {
      url.searchParams.set(key, String(value));
    }
    const resp = await fetch(url.toString());
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch orders" });
  }
});

app.get("/api/orders/:id", async (req, res) => {
  try {
    const resp = await fetch(`${API_URLS.orderApi}/api/orders/${req.params.id}`);
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch order" });
  }
});

app.get("/api/orders/:id/lifecycle", async (req, res) => {
  try {
    const resp = await fetch(`${API_URLS.orderApi}/api/orders/${req.params.id}/lifecycle`);
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch order lifecycle" });
  }
});

// Evidence and Dispute Pack exports (proxied to reconstruction API)
app.get("/api/orders/:id/evidence-pack", async (req, res) => {
  try {
    const resp = await fetch(`${API_URLS.reconstruction}/orders/${req.params.id}/evidence-pack`);
    if (!resp.ok) {
      return res.status(resp.status).json({ success: false, error: "Failed to generate evidence pack" });
    }
    const contentType = resp.headers.get('content-type');
    res.setHeader('Content-Type', contentType || 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="evidence-${req.params.id}.zip"`);
    const buffer = await resp.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to generate evidence pack" });
  }
});

app.get("/api/orders/:id/dispute-pack", async (req, res) => {
  try {
    const resp = await fetch(`${API_URLS.reconstruction}/orders/${req.params.id}/dispute-pack`);
    if (!resp.ok) {
      return res.status(resp.status).json({ success: false, error: "Failed to generate dispute pack" });
    }
    const contentType = resp.headers.get('content-type');
    res.setHeader('Content-Type', contentType || 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="dispute-${req.params.id}.zip"`);
    const buffer = await resp.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to generate dispute pack" });
  }
});

// Rejections
app.get("/api/rejections", async (req, res) => {
  try {
    const url = new URL(`${API_URLS.orderApi}/api/rejections`);
    for (const [key, value] of Object.entries(req.query)) {
      url.searchParams.set(key, String(value));
    }
    const resp = await fetch(url.toString());
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch rejections" });
  }
});

// Demo trigger proxy
app.get("/api/demo/scenarios", async (req, res) => {
  try {
    const resp = await fetch(`${API_URLS.orderApi}/api/demo/scenarios`);
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch demo scenarios" });
  }
});

app.post("/api/demo/trigger/:scenario_id", async (req, res) => {
  try {
    const resp = await fetch(`${API_URLS.orderApi}/api/demo/trigger/${req.params.scenario_id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body)
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to trigger demo scenario" });
  }
});

// Truvesta Command Center route
app.get("/truvesta", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "truvesta.html"));
});

// Week 4 Operations Dashboard route
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// Phase 1: Command Center v2 (UI Shell with tab navigation)
app.get("/command-center-v2", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "command-center-v2.html"));
});

// Phase 3: Orders page
app.get("/orders", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "orders.html"));
});

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
const server = app.listen(port, () => {
  console.log(`BrokerOps UI running at http://localhost:${port}`);
});

// Handle port collision gracefully
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use.`);
    console.error('To fix: fuser -k ' + port + '/tcp');
    console.error('Or set PORT environment variable to use a different port.');
    process.exit(1);
  }
  throw err;});