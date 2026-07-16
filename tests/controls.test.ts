import { describe, it, expect } from "vitest";
import { openDb, getSetting, setSetting } from "../src/db.js";
import { runProbes } from "../src/prober.js";
import { buildApp } from "../src/server.js";

const H = { "x-assay-control": "1", "content-type": "application/json" };

function seedService(db: any, id = "https://svc.example/a", status = "curated") {
  db.prepare(
    "INSERT INTO services (id, domain, status, first_seen, last_seen, raw) VALUES (?,?,?,?,?,?)"
  ).run(id, "svc.example", status, 1, 1, "{}");
}

describe("settings", () => {
  it("get/set roundtrip with upsert", () => {
    const db = openDb(":memory:");
    expect(getSetting(db, "paused")).toBeNull();
    setSetting(db, "paused", "1");
    expect(getSetting(db, "paused")).toBe("1");
    setSetting(db, "paused", "0");
    expect(getSetting(db, "paused")).toBe("0");
  });
});

describe("pause gating", () => {
  it("runProbes short-circuits when paused, before touching the wallet", async () => {
    const db = openDb(":memory:");
    setSetting(db, "paused", "1");
    const mustNotBeCalled = (() => {
      throw new Error("payFetch must not be called while paused");
    }) as any;
    const r = await runProbes(db, { payFetch: mustNotBeCalled });
    expect(r).toEqual({ probed: 0, skipped: "paused" });
  });
});

describe("control endpoints", () => {
  it("rejects control posts without the control header", async () => {
    const db = openDb(":memory:");
    const res = await buildApp(db).request("/api/control/pause", { method: "POST" });
    expect(res.status).toBe(403);
    expect(getSetting(db, "paused")).toBeNull();
  });

  it("pause and resume flip the persisted setting", async () => {
    const db = openDb(":memory:");
    const app = buildApp(db);
    let res = await app.request("/api/control/pause", { method: "POST", headers: H });
    expect(res.status).toBe(200);
    expect(getSetting(db, "paused")).toBe("1");
    res = await app.request("/api/control/resume", { method: "POST", headers: H });
    expect(res.status).toBe(200);
    expect(getSetting(db, "paused")).toBe("0");
  });

  it("retire and restore flip service status and 404 on wrong state", async () => {
    const db = openDb(":memory:");
    seedService(db);
    const app = buildApp(db);
    const status = () =>
      (db.prepare("SELECT status FROM services WHERE id=?").get("https://svc.example/a") as any)
        .status;

    let res = await app.request("/api/control/service/retire", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ id: "https://svc.example/a" }),
    });
    expect(res.status).toBe(200);
    expect(status()).toBe("retired");

    // Retiring an already-retired service is a 404, not a silent success
    res = await app.request("/api/control/service/retire", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ id: "https://svc.example/a" }),
    });
    expect(res.status).toBe(404);

    res = await app.request("/api/control/service/restore", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ id: "https://svc.example/a" }),
    });
    expect(res.status).toBe(200);
    expect(status()).toBe("curated");
  });

  it("probe-now: 501 without a runner, 409 while paused, runs otherwise", async () => {
    const db = openDb(":memory:");
    let res = await buildApp(db).request("/api/control/probe-now", { method: "POST", headers: H });
    expect(res.status).toBe(501);

    setSetting(db, "paused", "1");
    const app = buildApp(db, { probeNow: async () => ({ probed: 3, skipped: null }) });
    res = await app.request("/api/control/probe-now", { method: "POST", headers: H });
    expect(res.status).toBe(409);

    setSetting(db, "paused", "0");
    res = await app.request("/api/control/probe-now", { method: "POST", headers: H });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.result.probed).toBe(3);
  });

  it("status endpoint reports pause state, wallet, and budget", async () => {
    const db = openDb(":memory:");
    const app = buildApp(db, { wallet: async () => ({ address: "0xabc", usdc: 42 }) });
    const res = await app.request("/api/status");
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.paused).toBe(false);
    expect(j.wallet).toEqual({ address: "0xabc", usdc: 42 });
    expect(j.dailyBudgetUsdc).toBeGreaterThan(0);
    expect(j.services.curated).toBe(0);
  });

  it("status endpoint survives a failing wallet getter", async () => {
    const db = openDb(":memory:");
    const app = buildApp(db, {
      wallet: async () => {
        throw new Error("rpc down");
      },
    });
    const res = await app.request("/api/status");
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.wallet).toBeNull();
  });

  it("dashboard page is served", async () => {
    const db = openDb(":memory:");
    const res = await buildApp(db).request("/dashboard");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Assay · Ops");
  });

  it("honors a custom control token", async () => {
    const db = openDb(":memory:");
    const app = buildApp(db, { controlToken: "s3cret" });
    let res = await app.request("/api/control/pause", {
      method: "POST",
      headers: { "x-assay-control": "1" },
    });
    expect(res.status).toBe(403);
    res = await app.request("/api/control/pause", {
      method: "POST",
      headers: { "x-assay-control": "s3cret" },
    });
    expect(res.status).toBe(200);
  });
});

describe("rate limiting", () => {
  it("returns 429 with Retry-After once the per-IP window is exhausted", async () => {
    const db = openDb(":memory:");
    const app = buildApp(db, { rateLimitRpm: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await app.request("/healthz")).status).toBe(200);
    }
    const res = await app.request("/healthz");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("is disabled when rpm is 0", async () => {
    const db = openDb(":memory:");
    const app = buildApp(db, { rateLimitRpm: 0 });
    for (let i = 0; i < 10; i++) {
      expect((await app.request("/healthz")).status).toBe(200);
    }
  });
});
