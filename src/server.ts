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
import { SKILL_MD } from "./skill.js";
import { ICON_PNG, ICON_SVG } from "./icon.js";
import { renderBadge } from "./badge.js";
import { renderLeaderboardPage } from "./leaderboard.js";

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
    const scoreAccepts = {
      scheme: "exact",
      price: "$0.005",
      network: "eip155:8453" as const,
      payTo: config.receiveWalletAddress,
    };
    const scoreOutputExample = {
      service: "https://api.example.com/data",
      composite: 94.3,
      components: { settlement: 1, schema: 0.95, groundTruth: 0.99, llm: 0.8 },
      nProbes: 42,
      trend: 1.2,
      ts: 1784150719964,
    };
    app.use(
      paymentMiddleware(
        {
          // The Bazaar-facing form. Two hard-won facts (2026-07-20, after 24h unindexed):
          // the catalog holds CONCRETE resource URLs only (0 of ~28k entries use path
          // templates, 0 loopback — CDP silently drops those), and behind a TLS-terminating
          // proxy the adapter derives http:// (or 127.0.0.1 for local requests). So this
          // route pins `resource` to the canonical public https URL — every cataloging
          // settlement advertises the same catalog identity no matter how it was reached.
          "GET /score": {
            resource: `${config.publicUrl}/score`,
            accepts: scoreAccepts,
            serviceName: "Assay",
            description:
              "Quality score for any x402 service, earned by real paid probes with on-chain " +
              "receipts: composite 0-100, component breakdown (payment settlement, schema " +
              "conformance, ground-truth accuracy, LLM-judged quality), 7-day trend, probe " +
              "count. Scores publish only after 20+ probes across days; daily corpus digests " +
              "are Bitcoin-anchored via OpenTimestamps. Query: /score?service={url-encoded " +
              "resource URL}. Free: /tier/{url}, /leaderboard. Agent guide: " +
              "https://assay.nominal-labs.com/SKILL.md",
            mimeType: "application/json",
            tags: ["trust", "reputation", "quality", "score", "oracle", "verification", "ratings", "data"],
            iconUrl: `${config.publicUrl}/icon.png`,
            extensions: declareDiscoveryExtension({
              input: { service: "https%3A%2F%2Fapi.example.com%2Fdata" },
              inputSchema: {
                properties: {
                  service: {
                    type: "string",
                    description:
                      "URL-encoded resource URL of the x402 service to look up, exactly as advertised in the Bazaar",
                  },
                },
                required: ["service"],
              },
              output: { example: scoreOutputExample },
            }),
          },
          // Named param (not /score/*) so Bazaar discovery shows a meaningful parameter name.
          // Service IDs are URL-encoded (slashes → %2F), so they're always a single segment.
          // No `resource` override here: a static resource would mismatch the per-request
          // URL, and customer x402 clients may validate that — the query form above is the
          // catalog's front door.
          "GET /score/:serviceUrl": {
            accepts: scoreAccepts,
            serviceName: "Assay",
            // Bazaar metadata quality feeds the catalog's ranking composite; keep this a real
            // natural-language description (placeholder text scores 0) and ≤500 chars. The
            // SKILL.md link substitutes for the `skillUrl` field until the SDK grows one.
            description:
              "Quality score for any x402 service, earned by real paid probes with on-chain " +
              "receipts: composite 0-100, component breakdown (payment settlement, schema " +
              "conformance, ground-truth accuracy, LLM-judged quality), 7-day trend, probe " +
              "count. Scores publish only after 20+ probes across days; daily corpus digests " +
              "are Bitcoin-anchored via OpenTimestamps. Path: /score/{url-encoded resource " +
              "URL}. Free: /tier/{url}, /leaderboard. Agent guide: " +
              "https://assay.nominal-labs.com/SKILL.md",
            mimeType: "application/json",
            tags: ["trust", "reputation", "quality", "score", "oracle", "verification", "ratings", "data"],
            // PNG, not SVG: CDP re-hosts icons through an image pipeline (observed
            // cloudinary), and raster is the safe common denominator.
            iconUrl: `${config.publicUrl}/icon.png`,
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
              output: { example: scoreOutputExample },
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

  // Agent usage guide (see skill.ts). Lowercase alias because agents guess casing.
  const serveSkill = (c: any) =>
    c.body(SKILL_MD, 200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    });
  app.get("/SKILL.md", serveSkill);
  app.get("/skill.md", serveSkill);

  // llms.txt convention (llmstxt.org): a compact plain-text site guide for LLM agents.
  app.get("/llms.txt", (c) =>
    c.body(
      `# Assay — x402 service-quality oracle

Quality scores for x402 services, earned by paying them and verifying what comes back.
Every score is backed by real paid probes with on-chain settlement receipts on Base.

## Endpoints
- ${config.publicUrl}/SKILL.md — full agent guide (markdown)
- ${config.publicUrl}/tier/{url-encoded service URL} — free tier verdict (gold/ok/avoid/unrated)
- ${config.publicUrl}/tiers?services={a,b,c} — free bulk ranking, max 50 (comma-separated, each URL-encoded)
- ${config.publicUrl}/score?service={url-encoded service URL} — full evidence report, x402-paid ($0.005 USDC, Base)
- ${config.publicUrl}/leaderboard — every scored service, ranked (HTML)
- ${config.publicUrl}/api/digests — Bitcoin-anchored daily corpus digests (verify evidence predates claims)

## Tooling
- MCP server: npx -y assay-oracle-mcp (tools: check_service, rank_services, get_score, top_services)
- Spend guard: npm install assay-x402-guard (wrapFetchWithAssay, rankCandidates, purchaseScore)
`,
      200,
      { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" }
    )
  );

  // Brand icon (see icon.ts): PNG is what the Bazaar iconUrl points at, SVG is the crisp
  // favicon source. Cache hard — the asset only changes with a deploy.
  app.get("/icon.png", (c) =>
    c.body(ICON_PNG, 200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" })
  );
  app.get("/icon.svg", (c) =>
    c.body(ICON_SVG, 200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" })
  );

  app.get("/tier/:id", (c) => {
    const id = c.req.param("id");
    const s = latestScore(db, id);
    if (!s) {
      // Catalog-derived signals for services we've ingested but never probed: half the
      // Bazaar is dead listings and some operators mass-produce hundreds of clones, so
      // listing age, churn, and operator concentration are real signal — and they cost
      // nothing, because the ingest already collects them. Turns "unknown" from a dead
      // end into a verdict for every live catalog entry.
      const svc = db
        .prepare("SELECT domain, first_seen, last_seen, raw FROM services WHERE id = ?")
        .get(id) as { domain: string; first_seen: number; last_seen: number; raw: string } | undefined;
      if (!svc) return c.json({ error: "unknown service" }, 404);
      let payTo: string | null = null;
      try {
        payTo = JSON.parse(svc.raw)?.accepts?.[0]?.payTo ?? null;
      } catch {
        /* malformed raw — operator signals just omit */
      }
      const op = payTo
        ? (db
            .prepare(
              "SELECT COUNT(*) n, COUNT(DISTINCT domain) d FROM services WHERE json_extract(raw, '$.accepts[0].payTo') = ?"
            )
            .get(payTo) as { n: number; d: number })
        : null;
      const now = Date.now();
      c.header("Cache-Control", "public, max-age=3600");
      return c.json({
        service: id,
        tier: "unknown",
        catalog: {
          listedDays: Math.floor((now - svc.first_seen) / 86400000),
          lastSeenHoursAgo: Math.floor((now - svc.last_seen) / 3600000),
          listingStatus: now - svc.last_seen < 48 * 3600000 ? "live" : "churned",
          ...(op
            ? { operator: { services: op.n, domains: op.d, massListing: op.n > 25 } }
            : {}),
        },
        note: "catalog-derived signals only — Assay has not yet paid and probed this service",
      });
    }
    c.header("Cache-Control", "public, max-age=3600");
    // The free label carries its own upsell: agents that want proof shouldn't have to
    // find the paid endpoint by reading docs.
    return c.json({
      service: id,
      tier: tierFor(s.composite),
      evidence: {
        url: `${config.publicUrl}/score?service=${encodeURIComponent(id)}`,
        price_usdc: 0.005,
        note: "full score + component breakdown + probe evidence (x402-paid)",
      },
    });
  });

  // Bulk form of /tier — one call to rank a whole candidate list. Free and label-only
  // like /tier; the paid /score endpoint is where composites and evidence live.
  app.get("/tiers", (c) => {
    const raw = c.req.query("services");
    if (!raw)
      return c.json({ error: "missing ?services= (comma-separated URL-encoded resource URLs)" }, 400);
    // Elements are individually URL-encoded by clients so the commas that join the list
    // survive; decode per element (the once-only Hono decode rule applies to route params).
    const ids = raw.split(",").filter(Boolean).map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
    if (ids.length > 50) return c.json({ error: "max 50 services per request" }, 400);
    const tiers = ids.map((id) => {
      const s = latestScore(db, id);
      return { service: id, tier: s ? tierFor(s.composite) : "unknown" };
    });
    c.header("Cache-Control", "public, max-age=300");
    return c.json({
      tiers,
      evidence: {
        url_template: `${config.publicUrl}/score?service={url-encoded id}`,
        price_usdc: 0.005,
      },
    });
  });

  // Query-param alias of /score/:id — the form the Bazaar catalog advertises.
  app.get("/score", (c) => {
    const id = c.req.query("service");
    if (!id) return c.json({ error: "missing ?service= (URL-encoded x402 resource URL)" }, 400);
    const s = latestScore(db, id);
    if (!s) return c.json({ error: "unknown service" }, 404);
    return c.json({ service: id, ...s });
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
        `SELECT s.service_id, s.composite, s.n_probes, s.trend, sv.domain, sv.price_usdc
         FROM scores s JOIN services sv ON sv.id = s.service_id
         WHERE s.ts = (SELECT MAX(ts) FROM scores WHERE service_id = s.service_id)
           AND sv.status = 'curated'
         ORDER BY s.composite DESC NULLS LAST, s.n_probes DESC`
      )
      .all() as any[];
    c.header("Cache-Control", "public, max-age=300");
    return c.html(renderLeaderboardPage(rows));
  });

  // Live tier badge for scored operators to embed. Served from our domain so it always
  // shows the CURRENT verdict — it can downgrade, which is exactly why it's worth pixels.
  app.get("/badge/:serviceUrl", (c) => {
    const id = c.req.param("serviceUrl").replace(/\.svg$/, "");
    const s = latestScore(db, id);
    if (!s) return c.json({ error: "unknown service" }, 404);
    c.header("Cache-Control", "public, max-age=3600");
    return c.body(renderBadge(s.composite, s.nProbes), 200, { "Content-Type": "image/svg+xml" });
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

  // Answer "which service should I call for X?" — the selection moment every agent
  // framework currently leaves to the model guessing over a raw catalog dump. Scored
  // matches rank by composite; unprobed matches are catalog-screened (live within 48h,
  // not from a mass-listing operator) so the fallback list isn't the spam long tail.
  app.get("/api/recommend", (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "missing ?q= (keywords describing what you need)" }, 400);
    const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!words.length) return c.json({ error: "empty query" }, 400);
    const limit = Math.min(Number(c.req.query("limit")) || 5, 20);
    const now = Date.now();
    const match = (raw: string, id: string) => {
      let desc = "";
      try {
        desc = String(JSON.parse(raw)?.description ?? "");
      } catch {
        /* unparsable raw — match on id only */
      }
      const hay = (desc + " " + id).toLowerCase();
      return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
    };
    const scored = (db
      .prepare(
        `SELECT s.id, s.raw, s.price_usdc, sc.composite FROM services s
         JOIN scores sc ON sc.service_id = s.id
         WHERE s.status = 'curated'
           AND sc.ts = (SELECT MAX(ts) FROM scores WHERE service_id = s.id)`
      )
      .all() as any[])
      .map((r) => ({ r, m: match(r.raw, r.id) }))
      .filter((x) => x.m > 0)
      .sort((a, b) => b.m - a.m || (b.r.composite ?? -1) - (a.r.composite ?? -1))
      .slice(0, limit)
      .map(({ r }) => ({
        service: r.id,
        tier: tierFor(r.composite),
        composite: r.composite,
        price_usdc: r.price_usdc,
      }));
    const candidates = (db
      .prepare(
        `SELECT id, raw, price_usdc, first_seen FROM services
         WHERE status = 'discovered' AND ? - last_seen < ${48 * 3600000}`
      )
      .all(now) as any[])
      .map((r) => ({ r, m: match(r.raw, r.id) }))
      .filter((x) => {
        if (x.m === 0) return false;
        try {
          const payTo = JSON.parse(x.r.raw)?.accepts?.[0]?.payTo;
          if (!payTo) return true;
          const op = db
            .prepare(
              "SELECT COUNT(*) n FROM services WHERE json_extract(raw, '$.accepts[0].payTo') = ?"
            )
            .get(payTo) as { n: number };
          return op.n <= 25; // screen out listing factories
        } catch {
          return true;
        }
      })
      .sort((a, b) => b.m - a.m || b.r.first_seen - a.r.first_seen)
      .slice(0, limit)
      .map(({ r }) => ({
        service: r.id,
        tier: "unknown",
        price_usdc: r.price_usdc,
        listedDays: Math.floor((now - r.first_seen) / 86400000),
      }));
    c.header("Cache-Control", "public, max-age=300");
    return c.json({
      query: q,
      scored,
      candidates,
      note: "scored = quality-ranked by real paid probes; candidates = unprobed but catalog-screened (live, not mass-listed)",
    });
  });

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
