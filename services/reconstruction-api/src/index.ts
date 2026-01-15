import express from "express";
import pg from "pg";
const { Pool } = pg;

const app = express();

const pool = new Pool({
  host: process.env.PGHOST ?? "localhost",
  port: Number(process.env.PGPORT ?? 5434),
  user: process.env.PGUSER ?? "broker",
  password: process.env.PGPASSWORD ?? "broker",
  database: process.env.PGDATABASE ?? "broker"
});

app.get("/trace/:traceId", async (req, res) => {
  const traceId = req.params.traceId;
  const r = await pool.query(
    "SELECT id, trace_id, event_type, event_version, payload_json, prev_hash, hash, created_at FROM audit_events WHERE trace_id=$1 ORDER BY id ASC",
    [traceId]
  );
  res.json({ traceId, count: r.rowCount, events: r.rows });
});

app.get("/health", async (_, res) => {
  const r = await pool.query("SELECT 1 as ok");
  res.json({ ok: r.rows?.[0]?.ok === 1 });
});

const port = process.env.PORT ? Number(process.env.PORT) : 7004;
app.listen(port, () => console.log(`reconstruction-api listening on :${port}`));
