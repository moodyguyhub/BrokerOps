import express from "express";
import crypto from "crypto";
import pg from "pg";

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

function canonicalJson(x: unknown): string {
  // Minimal canonicalization for v0: stable key order via JSON stringify of sorted keys.
  // (Not perfect; good enough for demo; replace with proper canonical JSON later.)
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

async function getLastHash(traceId: string): Promise<string | null> {
  const r = await pool.query(
    "SELECT hash FROM audit_events WHERE trace_id=$1 ORDER BY id DESC LIMIT 1",
    [traceId]
  );
  return r.rowCount ? (r.rows[0].hash as string) : null;
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

app.post("/append", async (req, res) => {
  const { traceId, eventType, eventVersion = "v1", payload } = req.body ?? {};
  if (!traceId || !eventType) return res.status(400).json({ error: "traceId and eventType required" });

  const prevHash = await getLastHash(traceId);
  const payloadJson = payload ?? {};
  const material = (prevHash ?? "") + "|" + eventType + "|" + eventVersion + "|" + canonicalJson(payloadJson);
  const hash = sha256(material);

  await pool.query(
    "INSERT INTO audit_events(trace_id,event_type,event_version,payload_json,prev_hash,hash) VALUES($1,$2,$3,$4,$5,$6)",
    [traceId, eventType, eventVersion, payloadJson, prevHash, hash]
  );

  res.json({ ok: true, traceId, prevHash, hash });
});

app.get("/health", async (_, res) => {
  const r = await pool.query("SELECT 1 as ok");
  res.json({ ok: r.rows?.[0]?.ok === 1 });
});

const port = process.env.PORT ? Number(process.env.PORT) : 7003;
app.listen(port, () => console.log(`audit-writer listening on :${port}`));
