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

  it("404s unknown services", async () => {
    const db = openDb(":memory:");
    const app = buildApp(db);
    const res = await app.request(`/score/${encodeURIComponent("https://nope.example/x")}`);
    expect(res.status).toBe(404);
  });

  it("healthz reports counts", async () => {
    const db = openDb(":memory:");
    seed(db);
    const res = await buildApp(db).request("/healthz");
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.services).toBe(1);
  });
});
