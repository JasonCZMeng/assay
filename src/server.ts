import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import type Database from "better-sqlite3";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { config } from "./config.js";
import { latestScore, tierFor } from "./score.js";
import { spentTodayUsdc } from "./prober.js";
import { getSetting, setSetting } from "./db.js";
import { DASHBOARD_HTML } from "./dashboard.js";
import { LANDING_HTML } from "./landing.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Callbacks the long-running process wires in; absent in tests and the API-only surface.
export type AppOpts = {
  probeNow?: () => Promise<{ probed: number; skipped: string | null } | null>;
  ingestNow?: () => Promise<{ upserted: number }>;
  wallet?: () => Promise<{ address: string; usdc: number }>;
  // Test overrides; production values come from config.
  rateLimitRpm?: number;
  controlToken?: string;
};

export function buildApp(db: Database.Database, opts: AppOpts = {}): Hono {
  const app = new Hono();
  const rateLimitRpm = opts.rateLimitRpm ?? config.rateLimitRpm;
  const controlToken = opts.controlToken ?? config.controlToken;

  // Fixed-window per-IP rate limit for public exposure. In-memory is deliberate: one
  // process owns the port, and losing counters on restart is harmless.
  if (rateLimitRpm > 0) {
    const windows = new Map<string, { count: number; resetAt: number }>();
    app.use(async (c, next) => {
      const xff = config.trustProxy ? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() : undefined;
      let ip = xff;
      if (!ip) {
        try {
          ip = getConnInfo(c).remote.address ?? "unknown";
        } catch {
          ip = "unknown"; // no socket in test harness
        }
      }
      const now = Date.now();
      let w = windows.get(ip);
      if (!w || now >= w.resetAt) {
        w = { count: 0, resetAt: now + 60_000 };
        windows.set(ip, w);
        if (windows.size > 50_000) windows.clear(); // memory backstop under address-spoof flood
      }
      if (++w.count > rateLimitRpm) {
        c.header("Retry-After", String(Math.ceil((w.resetAt - now) / 1000)));
        return c.json({ error: "rate limited" }, 429);
      }
      await next();
    });
  }

  if (config.paymentsEnabled) {
    // Real @x402/hono v2 API (confirmed against node_modules/@x402/hono/README.md and the
    // @x402/core type defs) differs from the brief's sketch: `paymentMiddleware(routes, server)`
    // requires a pre-built `x402ResourceServer` (a facilitator client with per-network payment
    // schemes registered), not a bare `{ address }` config, and `network` is a CAIP-2 chain id
    // (`eip155:8453` for Base mainnet), not the literal string "base". Built lazily here, inside
    // the flag branch, since this only ever runs when paymentsEnabled=true.
    // CDP facilitator (Base mainnet settlement + Bazaar listing eligibility) when keys are
    // present; otherwise the plain facilitator URL (testnet default — see config).
    const facilitatorClient =
      config.cdpApiKeyId && config.cdpApiKeySecret
        ? new HTTPFacilitatorClient(createFacilitatorConfig(config.cdpApiKeyId, config.cdpApiKeySecret))
        : new HTTPFacilitatorClient({ url: config.facilitatorUrl });
    const resourceServer = new x402ResourceServer(facilitatorClient)
      .register("eip155:8453", new ExactEvmScheme())
      // Bazaar discovery: enriches our 402 challenges with the declared metadata below so the
      // CDP facilitator can catalog /score in the marketplace agents query.
      .registerExtension(bazaarResourceServerExtension);
    app.use(
      paymentMiddleware(
        {
          // Named param (not /score/*) so Bazaar discovery shows a meaningful parameter name.
          // Service IDs are URL-encoded (slashes → %2F), so they're always a single segment.
          "GET /score/:serviceUrl": {
            accepts: {
              scheme: "exact",
              price: "$0.005",
              network: "eip155:8453",
              payTo: config.receiveWalletAddress,
            },
            serviceName: "Assay",
            description:
              "Quality score for any x402 service, earned by real paid probes with on-chain " +
              "receipts: composite 0-100, component breakdown (payment settlement, schema " +
              "conformance, ground-truth accuracy, LLM-judged quality), 7-day trend, and probe " +
              "count. Scores publish only after 20+ probes spread across days; daily corpus " +
              "digests are Bitcoin-anchored via OpenTimestamps. Path: /score/{url-encoded " +
              "service resource URL}. Free tier verdict at /tier/{url}; leaderboard at /leaderboard.",
            mimeType: "application/json",
            tags: ["trust", "reputation", "quality", "score", "oracle", "verification", "ratings", "data"],
            // NB: no `method` field — DeclareDiscoveryExtensionInput omits it; the middleware
            // infers it from the route key ("GET /score/*").
            extensions: declareDiscoveryExtension({
              pathParams: {
                serviceUrl: "https%3A%2F%2Fapi.example.com%2Fdata",
              },
              pathParamsSchema: {
                properties: {
                  serviceUrl: {
                    type: "string",
                    description:
                      "URL-encoded resource URL of the x402 service to look up, exactly as advertised in the Bazaar",
                  },
                },
                required: ["serviceUrl"],
              },
              output: {
                example: {
                  service: "https://api.example.com/data",
                  composite: 94.3,
                  components: { settlement: 1, schema: 0.95, groundTruth: 0.99, llm: 0.8 },
                  nProbes: 42,
                  trend: 1.2,
                  ts: 1784150719964,
                },
              },
            }),
          },
        },
        resourceServer
      )
    );
  }

  app.get("/", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.html(LANDING_HTML);
  });

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

  // ---- Ops dashboard (read APIs + header-gated controls). The primary protection is the
  // localhost bind (config.host); the custom-header requirement on POST controls additionally
  // blocks CSRF and probe-redirect tricks — cross-origin requests can't set custom headers
  // without a CORS preflight, which this server never grants.

  app.get("/dashboard", (c) => c.html(DASHBOARD_HTML));

  app.get("/api/status", async (c) => {
    let wallet: { address: string; usdc: number } | null = null;
    if (opts.wallet) {
      try {
        wallet = await opts.wallet();
      } catch {
        wallet = null; // RPC hiccup — dashboard shows n/a rather than erroring
      }
    }
    const one = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as any);
    return c.json({
      ok: true,
      paused: getSetting(db, "paused") === "1",
      spentToday: spentTodayUsdc(db, Date.now()),
      dailyBudgetUsdc: config.dailyBudgetUsdc,
      paymentsEnabled: config.paymentsEnabled,
      probes24h: one("SELECT COUNT(*) c FROM probes WHERE ts >= ?", Date.now() - 86_400_000).c,
      probesTotal: one("SELECT COUNT(*) c FROM probes").c,
      lastProbeTs: one("SELECT MAX(ts) m FROM probes").m,
      services: {
        curated: one("SELECT COUNT(*) c FROM services WHERE status='curated'").c,
        retired: one("SELECT COUNT(*) c FROM services WHERE status='retired'").c,
        discovered: one("SELECT COUNT(*) c FROM services").c,
      },
      wallet,
      uptimeSec: Math.floor(process.uptime()),
    });
  });

  app.get("/api/services", (c) => {
    const rows = db
      .prepare(
        `SELECT s.id, s.domain, s.name, s.price_usdc, s.status,
                sc.composite, sc.n_probes, sc.trend,
                p.ts last_ts, p.http_status, p.ok_settlement, p.ok_schema,
                p.gt_deviation_pct, p.llm_score, p.latency_ms, p.payment_tx, p.error
         FROM services s
         LEFT JOIN scores sc ON sc.service_id = s.id
           AND sc.ts = (SELECT MAX(ts) FROM scores WHERE service_id = s.id)
         LEFT JOIN probes p ON p.service_id = s.id
           AND p.id = (SELECT MAX(id) FROM probes WHERE service_id = s.id)
         WHERE s.status IN ('curated','retired')
         ORDER BY s.status, s.domain`
      )
      .all() as any[];
    return c.json(
      rows.map((r) => ({ ...r, tier: r.n_probes != null ? tierFor(r.composite) : "unrated" }))
    );
  });

  app.get("/api/probes", (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
    const rows = db
      .prepare(
        `SELECT p.id, p.service_id, s.domain, p.ts, p.http_status, p.ok_settlement, p.ok_schema,
                p.gt_deviation_pct, p.llm_score, p.latency_ms, p.usdc_cost, p.payment_tx, p.error
         FROM probes p JOIN services s ON s.id = p.service_id
         ORDER BY p.id DESC LIMIT ?`
      )
      .all(limit);
    return c.json(rows);
  });

  app.get("/api/days", (c) => {
    const days = Math.min(Math.max(Number(c.req.query("days")) || 14, 1), 90);
    const rows = db
      .prepare(
        `SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') day,
                COUNT(*) probes,
                SUM(CASE WHEN ok_settlement=1 AND (ok_schema IS NULL OR ok_schema=1) THEN 1 ELSE 0 END) pass,
                SUM(CASE WHEN ok_settlement=1 AND (ok_schema IS NULL OR ok_schema=1) THEN 0 ELSE 1 END) fail,
                ROUND(SUM(usdc_cost), 6) usdc
         FROM probes WHERE ts >= ?
         GROUP BY day ORDER BY day`
      )
      .all(Date.now() - days * 86_400_000);
    return c.json(rows);
  });

  app.get("/api/digests", (c) => {
    const rows = db
      .prepare("SELECT day, root, n_probes, created_at, anchors FROM digests ORDER BY day DESC")
      .all() as any[];
    return c.json(
      rows.map((r) => ({
        day: r.day,
        root: r.root,
        n_probes: r.n_probes,
        created_at: r.created_at,
        anchors: r.anchors ? JSON.parse(r.anchors).map((a: any) => a.calendar) : [],
      }))
    );
  });

  app.use("/api/control/*", async (c, next) => {
    if (c.req.header("x-assay-control") !== controlToken) {
      return c.json({ error: "missing or wrong control header" }, 403);
    }
    await next();
  });

  app.post("/api/control/pause", (c) => {
    setSetting(db, "paused", "1");
    return c.json({ paused: true });
  });

  app.post("/api/control/resume", (c) => {
    setSetting(db, "paused", "0");
    return c.json({ paused: false });
  });

  app.post("/api/control/probe-now", async (c) => {
    if (!opts.probeNow) return c.json({ error: "controls not wired in this process" }, 501);
    if (getSetting(db, "paused") === "1") return c.json({ error: "paused — resume first" }, 409);
    return c.json({ ok: true, result: await opts.probeNow() });
  });

  app.post("/api/control/ingest-now", async (c) => {
    if (!opts.ingestNow) return c.json({ error: "controls not wired in this process" }, 501);
    return c.json({ ok: true, result: await opts.ingestNow() });
  });

  const setServiceStatus = (c: any, from: string, to: string) =>
    c.req.json().then(({ id }: { id?: string }) => {
      if (!id) return c.json({ error: "missing id" }, 400);
      const r = db
        .prepare("UPDATE services SET status=? WHERE id=? AND status=?")
        .run(to, id, from);
      if (r.changes === 0) return c.json({ error: `service not found in status '${from}'` }, 404);
      return c.json({ id, status: to });
    });

  app.post("/api/control/service/retire", (c) => setServiceStatus(c, "curated", "retired"));
  app.post("/api/control/service/restore", (c) => setServiceStatus(c, "retired", "curated"));

  return app;
}
