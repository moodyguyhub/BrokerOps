import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// API proxy configuration
const API_URLS = {
  reconstruction: process.env.RECONSTRUCTION_URL ?? "http://localhost:7004",
  economics: process.env.ECONOMICS_URL ?? "http://localhost:7005",
  webhooks: process.env.WEBHOOKS_URL ?? "http://localhost:7006"
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

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => {
  console.log(`BrokerOps UI running at http://localhost:${port}`);
});
