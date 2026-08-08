import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { computeScores } from "../src/score.js";
import { buildApp } from "../src/server.js";

function seed(db: any) {
  db.prepare(
    "INSERT INTO services (id, domain, status, first_seen, last_seen, raw) VALUES (?,?,?,?,?,?)"
  ).run("https://good.example/a", "good.example", "curated", 1, 1, "{}");
  const ins = db.prepare(
    "INSERT INTO probes (service_id, ts, ok_settlement, ok_schema, usdc_cost) VALUES (?,?,1,1,0.005)"
  );
  for (let i = 0; i < 25; i++) ins.run("https://good.example/a", Date.now() - i * 3600_000);
  computeScores(db);
}

// Direct score row with a chosen composite — for badge/leaderboard rendering assertions.
function seedScored(db: any, id: string, composite: number) {
  db.prepare(
    "INSERT INTO services (id, domain, status, price_usdc, first_seen, last_seen, raw) VALUES (?,?,?,?,?,?,?)"
  ).run(id, new URL(id).hostname, "curated", 0.005, 1, 1, "{}");
  db.prepare(
    "INSERT INTO scores (service_id, ts, composite, components, n_probes, trend) VALUES (?,?,?,'{}',30,1.1)"
  ).run(id, Date.now(), composite);
}

describe("server", () => {
  it("serves free tier labels", async () => {
    const db = openDb(":memory:");
    seed(db);
    const app = buildApp(db);
    const res = await app.request(`/tier/${encodeURIComponent("https://good.example/a")}`);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.tier).toBe("gold");
    expect(res.headers.get("cache-control")).toContain("max-age=3600");
  });

  it("serves full score when payments disabled (Phase L)", async () => {
    const db = openDb(":memory:");
    seed(db);
    const app = buildApp(db);
    const res = await app.request(`/score/${encodeURIComponent("https://good.example/a")}`);
    const j: any = await res.json();
    expect(j.composite).toBeGreaterThan(85);
    expect(j.components).toBeDefined();
  });

  it("query-form /score alias matches the path form", async () => {
    const db = openDb(":memory:");
    seed(db);
    const app = buildApp(db);
    const res = await app.request(`/score?service=${encodeURIComponent("https://good.example/a")}`);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.service).toBe("https://good.example/a");
    expect(j.composite).toBeGreaterThan(85);
    expect((await app.request("/score")).status).toBe(400); // missing param
    expect((await app.request("/score?service=https%3A%2F%2Fnope.example%2Fx")).status).toBe(404);
  });

  it("404s unknown services", async () => {
    const db = openDb(":memory:");
    const app = buildApp(db);
    const res = await app.request(`/score/${encodeURIComponent("https://nope.example/x")}`);
    expect(res.status).toBe(404);
  });

  it("serves SKILL.md as free markdown at both casings", async () => {
    const db = openDb(":memory:");
    const app = buildApp(db);
    for (const path of ["/SKILL.md", "/skill.md"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("markdown");
      const text = await res.text();
      expect(text).toContain("GET /score/");
      expect(text).toContain("x402");
    }
  });

  it("serves a live tier badge, strips the .svg suffix, 404s unknown services", async () => {
    const db = openDb(":memory:");
    seedScored(db, "https://svc.example/a", 94.3);
    const app = buildApp(db);
    const res = await app.request(`/badge/${encodeURIComponent("https://svc.example/a")}.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    const svg = await res.text();
    expect(svg).toContain("GOLD");
    expect(svg).toContain("94.3");
    expect((await app.request(`/badge/${encodeURIComponent("https://nope.example/x")}.svg`)).status).toBe(404);
  });

  it("renders the leaderboard ledger with scored and in-assay rows", async () => {
    const db = openDb(":memory:");
    seedScored(db, "https://svc.example/a", 91.2);
    // unrated service: curated with a null-composite score row
    db.prepare(
      "INSERT INTO services (id, domain, status, first_seen, last_seen, raw) VALUES (?,?,?,?,?,?)"
    ).run("https://new.example/b", "new.example", "curated", 1, 1, "{}");
    db.prepare(
      "INSERT INTO scores (service_id, ts, composite, components, n_probes, trend) VALUES (?,?,NULL,'{}',13,NULL)"
    ).run("https://new.example/b", Date.now());
    const res = await buildApp(db).request("/leaderboard");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=300");
    const html = await res.text();
    expect(html).toContain("svc.example");
    expect(html).toContain("91.2");
    expect(html).toContain("in assay · 13");
    expect(html).toContain("Ledger of Record");
  });

  it("serves the brand icon as PNG and SVG", async () => {
    const db = openDb(":memory:");
    const app = buildApp(db);
    const png = await app.request("/icon.png");
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await png.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    const svg = await app.request("/icon.svg");
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(await svg.text()).toContain("<svg");
  });

  it("healthz reports counts", async () => {
    const db = openDb(":memory:");
    seed(db);
    const res = await buildApp(db).request("/healthz");
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.services).toBe(1);
  });

  it("regression: decodes service ids with encoded substrings correctly", async () => {
    const db = openDb(":memory:");
    // Seed a service whose id contains an encoded substring
    const serviceId = "https://svc.example/a?next=https%3A%2F%2Fother.example";
    db.prepare(
      "INSERT INTO services (id, domain, status, first_seen, last_seen, raw) VALUES (?,?,?,?,?,?)"
    ).run(serviceId, "svc.example", "curated", 1, 1, "{}");
    const ins = db.prepare(
      "INSERT INTO probes (service_id, ts, ok_settlement, ok_schema, usdc_cost) VALUES (?,?,1,1,0.005)"
    );
    for (let i = 0; i < 25; i++) ins.run(serviceId, Date.now() - i * 3600_000);
    computeScores(db);

    const app = buildApp(db);
    const res = await app.request(`/score/${encodeURIComponent(serviceId)}`);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.service).toBe(serviceId);
  });

  it("leaderboard escapes html in service domains", async () => {
    const db = openDb(":memory:");
    const maliciousDomain = "<script>alert(1)</script>.evil.com";
    db.prepare(
      "INSERT INTO services (id, domain, status, first_seen, last_seen, raw) VALUES (?,?,?,?,?,?)"
    ).run("https://evil.example/x", maliciousDomain, "curated", 1, 1, "{}");
    const ins = db.prepare(
      "INSERT INTO probes (service_id, ts, ok_settlement, ok_schema, usdc_cost) VALUES (?,?,1,1,0.005)"
    );
    for (let i = 0; i < 25; i++) ins.run("https://evil.example/x", Date.now() - i * 3600_000);
    computeScores(db);

    const app = buildApp(db);
    const res = await app.request("/leaderboard");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("&lt;script&gt;");
    expect(text).not.toContain("<script>alert");
  });

  it("bulk /tiers ranks a candidate list in one call", async () => {
    const db = openDb(":memory:");
    seedScored(db, "https://gold.example/a", 95);
    seedScored(db, "https://mid.example/a", 70);
    const app = buildApp(db);
    const q = ["https://gold.example/a", "https://mid.example/a", "https://ghost.example/x"]
      .map(encodeURIComponent)
      .join(",");
    const res = await app.request(`/tiers?services=${q}`);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.tiers).toEqual([
      { service: "https://gold.example/a", tier: "gold" },
      { service: "https://mid.example/a", tier: "ok" },
      { service: "https://ghost.example/x", tier: "unknown" },
    ]);
    expect(res.headers.get("cache-control")).toContain("max-age=300");
  });

  it("free tier responses point at the paid evidence endpoint", async () => {
    const db = openDb(":memory:");
    seedScored(db, "https://gold.example/a", 95);
    const app = buildApp(db);
    const one: any = await (
      await app.request(`/tier/${encodeURIComponent("https://gold.example/a")}`)
    ).json();
    expect(one.evidence.url).toBe(
      "https://assay.nominal-labs.com/score?service=" + encodeURIComponent("https://gold.example/a")
    );
    expect(one.evidence.price_usdc).toBe(0.005);
    const bulk: any = await (
      await app.request(`/tiers?services=${encodeURIComponent("https://gold.example/a")}`)
    ).json();
    expect(bulk.evidence.url_template).toContain("/score?service=");
  });

  it("serves catalog-derived signals for discovered-but-unprobed services", async () => {
    const db = openDb(":memory:");
    const raw = JSON.stringify({ accepts: [{ payTo: "0xOperatorA" }] });
    const now = Date.now();
    const ins = db.prepare(
      "INSERT INTO services (id, domain, status, first_seen, last_seen, raw) VALUES (?,?,?,?,?,?)"
    );
    // 30 sibling services from one operator on one domain — a listing factory.
    for (let i = 0; i < 30; i++)
      ins.run(`https://farm.example/api/${i}`, "farm.example", "discovered", now - 12 * 86400000, now - 3600000, raw);
    const app = buildApp(db);
    const res = await app.request(`/tier/${encodeURIComponent("https://farm.example/api/1")}`);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.tier).toBe("unknown");
    expect(j.catalog.listedDays).toBe(12);
    expect(j.catalog.listingStatus).toBe("live");
    expect(j.catalog.operator).toEqual({ services: 30, domains: 1, massListing: true });
    // Truly absent services still 404.
    expect((await app.request(`/tier/${encodeURIComponent("https://ghost.example/x")}`)).status).toBe(404);
  });

  it("recommends best scored services for a need, with catalog-screened fallbacks", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const mkRaw = (desc: string, payTo = "0xOp1") =>
      JSON.stringify({ accepts: [{ payTo }], description: desc });
    const ins = db.prepare(
      "INSERT INTO services (id, domain, status, price_usdc, first_seen, last_seen, raw) VALUES (?,?,?,?,?,?,?)"
    );
    ins.run("https://good.example/btc", "good.example", "curated", 0.002, 1, now, mkRaw("Bitcoin spot price feed"));
    ins.run("https://meh.example/btc", "meh.example", "curated", 0.002, 1, now, mkRaw("bitcoin price api"));
    ins.run("https://fresh.example/btc", "fresh.example", "discovered", 0.001, now - 86400000, now, mkRaw("realtime bitcoin price"));
    ins.run("https://dead.example/btc", "dead.example", "discovered", 0.001, 1, now - 10 * 86400000, mkRaw("bitcoin price"));
    db.prepare(
      "INSERT INTO scores (service_id, ts, composite, components, n_probes, trend) VALUES (?,?,?,'{}',30,0)"
    ).run("https://good.example/btc", now, 95);
    db.prepare(
      "INSERT INTO scores (service_id, ts, composite, components, n_probes, trend) VALUES (?,?,?,'{}',30,0)"
    ).run("https://meh.example/btc", now, 55);
    const app = buildApp(db);
    const res = await app.request("/api/recommend?q=bitcoin%20price");
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.scored[0].service).toBe("https://good.example/btc");
    expect(j.scored[0].tier).toBe("gold");
    expect(j.scored[1].tier).toBe("avoid");
    // dead.example churned out of the catalog >48h ago — screened from candidates.
    expect(j.candidates.map((c: any) => c.service)).toEqual(["https://fresh.example/btc"]);
    expect((await app.request("/api/recommend")).status).toBe(400);
  });

  it("serves llms.txt with the endpoints an agent needs", async () => {
    const db = openDb(":memory:");
    const res = await buildApp(db).request("/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("/SKILL.md");
    expect(body).toContain("/score?service=");
    expect(body).toContain("/tiers?services=");
  });

  it("bulk /tiers rejects missing and oversized requests", async () => {
    const db = openDb(":memory:");
    const app = buildApp(db);
    expect((await app.request("/tiers")).status).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) =>
      encodeURIComponent(`https://s${i}.example/a`)
    ).join(",");
    expect((await app.request(`/tiers?services=${many}`)).status).toBe(400);
  });
});
