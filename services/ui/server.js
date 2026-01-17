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

// Provenance endpoint - single source of truth for build info
// Returns kernel version, UI version, and build timestamp
app.get("/api/provenance", (req, res) => {
  const kernelSha = process.env.BROKEROPS_SHA || process.env.GIT_SHA || "dev";
  const kernelTag = process.env.BROKEROPS_TAG || process.env.GIT_TAG || "";
  const uiVersion = "0.2.0";
  const buildTs = process.env.BUILD_TIMESTAMP || new Date().toISOString();
  
  res.json({
    kernel: kernelTag || `brokerops@${kernelSha}`,
    kernelSha,
    kernelTag,
    ui: `ui@${uiVersion}`,
    uiVersion,
    buildTs,
    environment: process.env.NODE_ENV || "development"
  });
});

// ============================================================================
// Phase 13: Policy Status Endpoint
// ============================================================================

import { createHash } from "crypto";
import { readdirSync, readFileSync, existsSync } from "fs";

const OPA_URL = process.env.OPA_URL ?? "http://localhost:8181";
const POLICIES_DIR = path.join(__dirname, "..", "..", "policies");

// Known rules from policies/order.rego (static until we parse Rego dynamically)
const KNOWN_RULES = [
  { id: "qty_limit", condition: "qty > 1000", action: "BLOCK" },
  { id: "symbol_gme", condition: "symbol = GME ∧ qty > 10", action: "BLOCK" },
  { id: "penny_stock", condition: "price < 1.0 ∧ qty > 100", action: "BLOCK" },
  { id: "allow_default", condition: "otherwise", action: "ALLOW" }
];

// Normalization boundary: ensures stable JSON schema with safe defaults
function normalizePolicyStatus(raw) {
  return {
    schema_version: "1.0.0",
    status: raw?.status ?? "loading",
    checked_at: raw?.checked_at ?? new Date().toISOString(),
    bundle: {
      policy_version: raw?.bundle?.policy_version ?? null,
      sha256: raw?.bundle?.sha256 ?? null,
      rules_count: raw?.bundle?.rules_count ?? 0,
      files_count: raw?.bundle?.files_count ?? 0
    },
    compile: {
      state: raw?.compile?.state ?? "unknown",
      message: raw?.compile?.message ?? null
    },
    rules: raw?.rules ?? [],
    error: raw?.error ?? null
  };
}

// Compute policy bundle metadata from local files
function computePolicyBundle() {
  try {
    if (!existsSync(POLICIES_DIR)) {
      return { policy_version: null, sha256: null, rules_count: 0, files_count: 0 };
    }

    const files = readdirSync(POLICIES_DIR).filter(f => f.endsWith(".rego"));
    if (files.length === 0) {
      return { policy_version: null, sha256: null, rules_count: 0, files_count: 0 };
    }

    // Read and concatenate all .rego files for hash (sorted, normalized line endings)
    let concatenated = "";
    let policyVersion = null;
    
    for (const file of files.sort()) {
      // Normalize CRLF to LF for cross-platform determinism
      const content = readFileSync(path.join(POLICIES_DIR, file), "utf8").replace(/\r\n/g, "\n");
      concatenated += content;
      
      // Extract policy_version if present
      const versionMatch = content.match(/policy_version\s*:=\s*"([^"]+)"/);
      if (versionMatch && !policyVersion) {
        policyVersion = versionMatch[1];
      }
    }

    const sha256 = createHash("sha256").update(concatenated).digest("hex");

    return {
      policy_version: policyVersion,
      sha256,
      rules_count: KNOWN_RULES.length,
      files_count: files.length
    };
  } catch (err) {
    console.error("[Policies] Error computing bundle:", err.message);
    return { policy_version: null, sha256: null, rules_count: 0, files_count: 0 };
  }
}

// Check OPA reachability
async function checkOpaHealth() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    
    const resp = await fetch(`${OPA_URL}/health`, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (resp.ok) {
      return { state: "ok", message: "OPA is reachable and healthy" };
    } else {
      return { state: "warn", message: `OPA returned HTTP ${resp.status}` };
    }
  } catch (err) {
    return { 
      state: "error", 
      message: err.name === "AbortError" ? "OPA health check timeout" : `OPA unreachable: ${err.message}` 
    };
  }
}

// GET /api/policies/status - Policy status with provable minimal truth
app.get("/api/policies/status", async (req, res) => {
  try {
    const bundle = computePolicyBundle();
    const compile = await checkOpaHealth();
    
    // Determine overall status
    let status = "ready";
    if (compile.state === "error") {
      status = "error";
    } else if (bundle.rules_count === 0) {
      status = "empty";
    }

    const response = normalizePolicyStatus({
      status,
      checked_at: new Date().toISOString(),
      bundle,
      compile,
      rules: KNOWN_RULES,
      error: compile.state === "error" ? compile.message : null
    });

    res.set("Cache-Control", "public, max-age=5");
    res.json(response);
  } catch (err) {
    console.error("[Policies] Status error:", err);
    res.status(500).json(normalizePolicyStatus({
      status: "error",
      error: err.message
    }));
  }
});

// ============================================================================
// Phase 14: Policies Dealer View (additive to Phase 13 contract)
// ============================================================================

// Allowed policy files (fail-closed: unknown files return 404)
const POLICY_FILE_ALLOWLIST = ["order.rego"];

// GET /api/policies/list - List all policy files with metadata
app.get("/api/policies/list", (req, res) => {
  try {
    if (!existsSync(POLICIES_DIR)) {
      return res.json({
        schema_version: "1.0.0",
        files: [],
        total_count: 0,
        fetched_at: new Date().toISOString()
      });
    }

    const regoFiles = readdirSync(POLICIES_DIR).filter(f => f.endsWith(".rego")).sort();
    
    const files = regoFiles.map(filename => {
      const filePath = path.join(POLICIES_DIR, filename);
      const content = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
      const lines = content.split("\n").length;
      
      // Extract policy_version if present
      const versionMatch = content.match(/policy_version\s*:=\s*"([^"]+)"/);
      const packageMatch = content.match(/^package\s+(\S+)/m);
      
      // Count rule definitions (rough heuristic)
      const ruleCount = (content.match(/^\s*\w+\s*:?=/gm) || []).length;
      
      return {
        filename,
        package: packageMatch ? packageMatch[1] : null,
        policy_version: versionMatch ? versionMatch[1] : null,
        line_count: lines,
        rule_count_estimate: ruleCount,
        sha256: createHash("sha256").update(content).digest("hex")
      };
    });

    res.json({
      schema_version: "1.0.0",
      files,
      total_count: files.length,
      fetched_at: new Date().toISOString()
    });
  } catch (err) {
    console.error("[Policies] List error:", err);
    res.status(500).json({
      schema_version: "1.0.0",
      files: [],
      total_count: 0,
      fetched_at: new Date().toISOString(),
      error: err.message
    });
  }
});

// GET /api/policies/detail - Get single policy file content (allowlisted)
app.get("/api/policies/detail", (req, res) => {
  try {
    const filename = req.query.file;
    
    // Validate filename parameter
    if (!filename || typeof filename !== "string") {
      return res.status(400).json({
        schema_version: "1.0.0",
        error: "Missing required query parameter: file",
        allowed_files: POLICY_FILE_ALLOWLIST
      });
    }

    // Fail-closed: only serve allowlisted files
    if (!POLICY_FILE_ALLOWLIST.includes(filename)) {
      return res.status(404).json({
        schema_version: "1.0.0",
        error: `File not in allowlist: ${filename}`,
        allowed_files: POLICY_FILE_ALLOWLIST
      });
    }

    const filePath = path.join(POLICIES_DIR, filename);
    
    if (!existsSync(filePath)) {
      return res.status(404).json({
        schema_version: "1.0.0",
        error: `Policy file not found: ${filename}`,
        allowed_files: POLICY_FILE_ALLOWLIST
      });
    }

    const content = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
    const lines = content.split("\n");
    
    // Extract metadata
    const versionMatch = content.match(/policy_version\s*:=\s*"([^"]+)"/);
    const packageMatch = content.match(/^package\s+(\S+)/m);

    res.json({
      schema_version: "1.0.0",
      filename,
      package: packageMatch ? packageMatch[1] : null,
      policy_version: versionMatch ? versionMatch[1] : null,
      line_count: lines.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      content,
      fetched_at: new Date().toISOString()
    });
  } catch (err) {
    console.error("[Policies] Detail error:", err);
    res.status(500).json({
      schema_version: "1.0.0",
      error: err.message
    });
  }
});

// ============================================================================
// Phase 10: Infrastructure Status Aggregator
// ============================================================================

// Service health check targets (extend API_URLS with additional services)
const INFRA_TARGETS = {
  orderApi: { name: "Order API", url: process.env.ORDER_API_URL ?? "http://localhost:7001", path: "/health" },
  riskGate: { name: "Risk Gate", url: process.env.RISK_GATE_URL ?? "http://localhost:7002", path: "/health" },
  auditWriter: { name: "Audit Writer", url: process.env.AUDIT_WRITER_URL ?? "http://localhost:7003", path: "/health" },
  reconstruction: { name: "Reconstruction API", url: process.env.RECONSTRUCTION_URL ?? "http://localhost:7004", path: "/health" },
  economics: { name: "Economics", url: process.env.ECONOMICS_URL ?? "http://localhost:7005", path: "/health" },
  webhooks: { name: "Webhooks", url: process.env.WEBHOOKS_URL ?? "http://localhost:7006", path: "/health" },
  opa: { name: "OPA", url: process.env.OPA_URL ?? "http://localhost:8181", path: "/health" }
};

// Check a single service health
async function checkServiceHealth(key, target) {
  const startTime = Date.now();
  const checkedAt = new Date().toISOString();
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    
    const resp = await fetch(`${target.url}${target.path}`, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    
    const latencyMs = Date.now() - startTime;
    
    if (!resp.ok) {
      return {
        name: target.name,
        url: target.url,
        status: "down",
        latency_ms: latencyMs,
        checked_at: checkedAt,
        message: `HTTP ${resp.status}`
      };
    }
    
    // Degraded if latency > 200ms
    const status = latencyMs > 200 ? "degraded" : "up";
    
    return {
      name: target.name,
      url: target.url,
      status,
      latency_ms: latencyMs,
      checked_at: checkedAt,
      message: status === "degraded" ? "High latency" : "OK"
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    return {
      name: target.name,
      url: target.url,
      status: "down",
      latency_ms: latencyMs,
      checked_at: checkedAt,
      message: err.name === "AbortError" ? "Timeout" : err.message
    };
  }
}

// Aggregated infrastructure status endpoint
app.get("/api/infrastructure/status", async (req, res) => {
  const timestamp = new Date().toISOString();
  
  // Check all services in parallel
  const servicePromises = Object.entries(INFRA_TARGETS).map(([key, target]) => 
    checkServiceHealth(key, target)
  );
  
  const services = await Promise.all(servicePromises);
  
  // Compute aggregate status (worst-case)
  let aggregateStatus = "ok";
  for (const svc of services) {
    if (svc.status === "down") {
      aggregateStatus = "error";
      break;
    }
    if (svc.status === "degraded") {
      aggregateStatus = "warn";
    }
  }
  
  // Compute metrics
  const upServices = services.filter(s => s.status === "up" || s.status === "degraded");
  const avgLatency = upServices.length > 0 
    ? Math.round(upServices.reduce((sum, s) => sum + s.latency_ms, 0) / upServices.length)
    : 0;
  
  res.set("Cache-Control", "public, max-age=5");
  res.json({
    success: true,
    schema_version: 1,
    status: aggregateStatus,
    timestamp,
    data: {
      services,
      sidecars: [], // Phase 10: show empty; demo mode would populate
      metrics: {
        avg_latency_ms: avgLatency,
        active_services: upServices.length,
        total_services: services.length
      }
    }
  });
});

// Helper to build infrastructure status payload (shared by REST and SSE)
async function buildInfrastructurePayload() {
  const timestamp = new Date().toISOString();
  
  const servicePromises = Object.entries(INFRA_TARGETS).map(([key, target]) => 
    checkServiceHealth(key, target)
  );
  
  const services = await Promise.all(servicePromises);
  
  let aggregateStatus = "ok";
  for (const svc of services) {
    if (svc.status === "down") {
      aggregateStatus = "error";
      break;
    }
    if (svc.status === "degraded") {
      aggregateStatus = "warn";
    }
  }
  
  const upServices = services.filter(s => s.status === "up" || s.status === "degraded");
  const avgLatency = upServices.length > 0 
    ? Math.round(upServices.reduce((sum, s) => sum + s.latency_ms, 0) / upServices.length)
    : 0;

  return {
    success: true,
    schema_version: 1,
    status: aggregateStatus,
    timestamp,
    data: {
      services,
      sidecars: [],
      metrics: {
        avg_latency_ms: avgLatency,
        active_services: upServices.length,
        total_services: services.length
      }
    }
  };
}

// ============================================================================
// Phase 11A: Infrastructure SSE Stream
// ============================================================================
const SSE_PUSH_INTERVAL = 2000; // Push every 2 seconds
const sseClients = new Set();

app.get("/api/infrastructure/stream", (req, res) => {
  // SSE headers
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no" // Disable nginx buffering
  });
  res.flushHeaders();

  // Send initial connection event
  res.write("event: connected\ndata: {\"message\":\"SSE stream connected\"}\n\n");

  // Track this client
  const clientId = Date.now() + Math.random().toString(36).substring(2, 9);
  const client = { id: clientId, res };
  sseClients.add(client);

  // Send immediate status on connect
  buildInfrastructurePayload().then(payload => {
    res.write(`event: infra\ndata: ${JSON.stringify(payload)}\n\n`);
  }).catch(() => {});

  // Heartbeat every 5 seconds (keep-alive)
  const heartbeatTimer = setInterval(() => {
    res.write(`:heartbeat ${new Date().toISOString()}\n\n`);
  }, 5000);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(heartbeatTimer);
    sseClients.delete(client);
  });
});

// Push infrastructure updates to all SSE clients
let ssePushTimer = null;

function startSSEBroadcast() {
  if (ssePushTimer) return;
  
  ssePushTimer = setInterval(async () => {
    if (sseClients.size === 0) return;
    
    try {
      const payload = await buildInfrastructurePayload();
      const data = `event: infra\ndata: ${JSON.stringify(payload)}\n\n`;
      
      for (const client of sseClients) {
        try {
          client.res.write(data);
        } catch (err) {
          sseClients.delete(client);
        }
      }
    } catch (err) {
      console.error("SSE broadcast error:", err.message);
    }
  }, SSE_PUSH_INTERVAL);
}

// Start SSE broadcast on server startup
startSSEBroadcast();

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

app.get("/api/lp-accounts/:id", async (req, res) => {
  try {
    const resp = await fetch(`${API_URLS.orderApi}/api/lp-accounts/${req.params.id}`);
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch LP account" });
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

// Evidence and Dispute Pack exports (proxied to order-api)
app.get("/api/orders/:id/evidence-pack", async (req, res) => {
  try {
    const resp = await fetch(`${API_URLS.orderApi}/api/orders/${req.params.id}/evidence-pack`);
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
    const resp = await fetch(`${API_URLS.orderApi}/api/orders/${req.params.id}/dispute-pack`);
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

// Phase 4: LP Accounts page
app.get("/lp-accounts", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "lp-accounts.html"));
});

// Phase 5: Alerts page
app.get("/alerts", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "alerts.html"));
});

// Phase 10: Infrastructure Status page
app.get("/infrastructure", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "infrastructure.html"));
});

// Phase 13: Policies page
app.get("/policies", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "policies.html"));
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