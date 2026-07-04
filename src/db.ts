import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,            -- Bazaar resource URL
  domain TEXT NOT NULL,
  name TEXT,
  category TEXT,
  price_usdc REAL,
  network TEXT,
  status TEXT NOT NULL DEFAULT 'discovered', -- discovered|curated|retired
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  raw TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS probe_templates (
  service_id TEXT PRIMARY KEY REFERENCES services(id),
  method TEXT NOT NULL CHECK (method IN ('GET','POST')),
  url TEXT NOT NULL,
  headers TEXT NOT NULL DEFAULT '{}',
  body TEXT,                       -- JSON string or NULL
  response_schema TEXT NOT NULL,   -- JSON Schema
  ground_truth TEXT,               -- JSON config or NULL
  llm_rubric TEXT,                 -- rubric string or NULL
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS probes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id TEXT NOT NULL REFERENCES services(id),
  ts INTEGER NOT NULL,
  ok_settlement INTEGER NOT NULL,  -- 1|0
  ok_schema INTEGER,               -- 1|0|NULL(not run)
  gt_deviation_pct REAL,           -- NULL if not run
  llm_score REAL,                  -- 0..1, NULL if not run
  http_status INTEGER,
  latency_ms INTEGER,
  usdc_cost REAL NOT NULL DEFAULT 0,
  payment_tx TEXT,
  response_hash TEXT,
  response_excerpt TEXT,           -- first 2000 chars
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_probes_service_ts ON probes(service_id, ts);
CREATE TABLE IF NOT EXISTS scores (
  service_id TEXT NOT NULL REFERENCES services(id),
  ts INTEGER NOT NULL,
  composite REAL,                  -- NULL until n_probes >= 20
  components TEXT NOT NULL,        -- JSON
  n_probes INTEGER NOT NULL,
  trend REAL,
  PRIMARY KEY (service_id, ts)
);
CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('probe','receive')),
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);
`;

export function openDb(path?: string): Database.Database {
  const p = path ?? process.env.DB_PATH ?? "data/assay.db";
  if (p !== ":memory:") mkdirSync(dirname(p), { recursive: true });
  const db = new Database(p);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
