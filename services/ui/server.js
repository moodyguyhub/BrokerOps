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
  res.json({ ok: true, service: "ui" });
});

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => {
  console.log(`BrokerOps UI running at http://localhost:${port}`);
});
