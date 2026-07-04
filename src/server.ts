import { Hono } from "hono";
import type Database from "better-sqlite3";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { config } from "./config.js";
import { latestScore, tierFor } from "./score.js";
import { spentTodayUsdc } from "./prober.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildApp(db: Database.Database): Hono {
  const app = new Hono();

  if (config.paymentsEnabled) {
    // Real @x402/hono v2 API (confirmed against node_modules/@x402/hono/README.md and the
    // @x402/core type defs) differs from the brief's sketch: `paymentMiddleware(routes, server)`
    // requires a pre-built `x402ResourceServer` (a facilitator client with per-network payment
    // schemes registered), not a bare `{ address }` config, and `network` is a CAIP-2 chain id
    // (`eip155:8453` for Base mainnet), not the literal string "base". Built lazily here, inside
    // the flag branch, since this only ever runs when paymentsEnabled=true.
    const facilitatorClient = new HTTPFacilitatorClient({ url: "https://facilitator.x402.org" });
    const resourceServer = new x402ResourceServer(facilitatorClient).register(
      "eip155:8453",
      new ExactEvmScheme()
    );
    app.use(
      paymentMiddleware(
        {
          "GET /score/*": {
            accepts: {
              scheme: "exact",
              price: "$0.005",
              network: "eip155:8453",
              payTo: config.receiveWalletAddress,
            },
          },
        },
        resourceServer
      )
    );
  }

  app.get("/tier/:id", (c) => {
    const id = c.req.param("id");
    const s = latestScore(db, id);
    if (!s) return c.json({ error: "unknown service" }, 404);
    c.header("Cache-Control", "public, max-age=3600");
    return c.json({ service: id, tier: tierFor(s.composite) });
  });

  app.get("/score/:id", (c) => {
    const id = c.req.param("id");
    const s = latestScore(db, id);
    if (!s) return c.json({ error: "unknown service" }, 404);
    return c.json({ service: id, ...s });
  });

  app.get("/leaderboard", (c) => {
    const rows = db
      .prepare(
        `SELECT s.service_id, s.composite, s.n_probes, sv.domain
         FROM scores s JOIN services sv ON sv.id = s.service_id
         WHERE s.ts = (SELECT MAX(ts) FROM scores WHERE service_id = s.service_id)
         ORDER BY s.composite DESC NULLS LAST`
      )
      .all() as any[];
    const tr = rows
      .map(
        (r) =>
          `<tr><td>${escapeHtml(r.domain)}</td><td>${r.composite?.toFixed(1) ?? "unrated"}</td><td>${tierFor(r.composite)}</td><td>${r.n_probes}</td></tr>`
      )
      .join("");
    return c.html(
      `<!doctype html><title>Assay Leaderboard</title><h1>Assay — x402 Quality Scores</h1>
       <table border=1 cellpadding=6><tr><th>Service</th><th>Score</th><th>Tier</th><th>Probes</th></tr>${tr}</table>`
    );
  });

  app.get("/healthz", (c) => {
    const services = (db.prepare("SELECT COUNT(*) c FROM services WHERE status='curated'").get() as any).c;
    const probes24h = (db
      .prepare("SELECT COUNT(*) c FROM probes WHERE ts >= ?")
      .get(Date.now() - 86_400_000) as any).c;
    return c.json({ ok: true, spentToday: spentTodayUsdc(db, Date.now()), services, probes24h });
  });

  return app;
}
