import { serve } from "@hono/node-server";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { createApp } from "./server.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
try { process.loadEnvFile(join(root, ".env")); } catch { /* optional */ }
const db = openDb(process.env.LEDGER_DB ?? join(root, "data", "ledger.db"));
const port = Number(process.env.LEDGER_PORT ?? 4100);
const app = createApp(db, { etherscanKey: process.env.ETHERSCAN_API_KEY || undefined });

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`wallet ledger → http://localhost:${port}`);
});
