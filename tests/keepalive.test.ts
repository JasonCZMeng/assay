import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { keepalivePurchase } from "../src/keepalive.js";

function seedCurated(db: any, id = "https://svc.example/data") {
  db.prepare(
    "INSERT INTO services (id, domain, status, first_seen, last_seen, raw) VALUES (?,?,?,?,?,?)"
  ).run(id, "svc.example", "curated", 1, 1, "{}");
}

describe("keepalivePurchase", () => {
  it("buys our own /score for a curated service through the paying fetch", async () => {
    const db = openDb(":memory:");
    seedCurated(db);
    let url = "";
    const payFetch = (async (u: any) => {
      url = String(u);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const r = await keepalivePurchase(db, { payFetch, baseUrl: "https://assay.test" });
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(url).toBe("https://assay.test/score/" + encodeURIComponent("https://svc.example/data"));
  });

  it("reports failure without paying when no curated service exists", async () => {
    const db = openDb(":memory:");
    let called = 0;
    const payFetch = (async () => (called++, new Response("{}"))) as typeof fetch;
    const r = await keepalivePurchase(db, { payFetch, baseUrl: "https://assay.test" });
    expect(r.ok).toBe(false);
    expect(called).toBe(0);
  });

  it("returns the error on a rejected fetch instead of throwing", async () => {
    const db = openDb(":memory:");
    seedCurated(db);
    const payFetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const r = await keepalivePurchase(db, { payFetch, baseUrl: "https://assay.test" });
    expect(r.ok).toBe(false);
    expect(r.status).toBeNull();
    expect(r.error).toContain("network down");
  });
});
