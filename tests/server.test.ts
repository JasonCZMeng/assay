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
});
