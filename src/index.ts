import { serve } from "@hono/node-server"; // npm i @hono/node-server
import cron from "node-cron";
import { openDb } from "./db.js";
import { config } from "./config.js";
import { ingestBazaar } from "./bazaar.js";
import { runProbes } from "./prober.js";
import { computeScores } from "./score.js";
import { buildApp } from "./server.js";

const db = openDb();

cron.schedule("0 * * * *", () =>
  ingestBazaar(db).then((r) => console.log(`[ingest] upserted ${r.upserted}`))
    .catch((e) => console.error("[ingest]", e))
);

async function probeAndScore() {
  const jitterMs = Math.random() * 3_600_000; // anti-fingerprinting jitter
  await new Promise((r) => setTimeout(r, jitterMs));
  const r = await runProbes(db).catch((e) => (console.error("[probe]", e), null));
  if (r) console.log(`[probe] probed=${r.probed} skipped=${r.skipped ?? "no"}`);
  try {
    console.log(`[score] scored ${computeScores(db)} services`);
  } catch (e) {
    console.error("[score]", e);
  }
}
for (const c of ["15 6 * * *", "15 13 * * *", "15 21 * * *"]) cron.schedule(c, probeAndScore);

serve({ fetch: buildApp(db).fetch, port: config.port }, (i) =>
  console.log(`[assay] listening on :${i.port} payments=${config.paymentsEnabled}`)
);
