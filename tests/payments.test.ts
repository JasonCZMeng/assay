import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";

// Integration test for the PAYMENTS_ENABLED=true branch (Phase H). config reads env at
// import time, so modules are re-imported fresh with the flag set. The facilitator is a
// local mock advertising Base mainnet support — this validates OUR middleware wiring
// (the real x402.org facilitator is testnet-only; production uses CDP at the flip).
// x402 v2 carries the challenge in the PAYMENT-REQUIRED response header (base64 JSON),
// not the body.
const OLD_ENV = process.env;
const RECEIVE = "0x2feCabDFC849C76fdC28CA13Aa0Ab392753EF35C";

let facilitator: Server;
let facilitatorUrl: string;

beforeAll(async () => {
  facilitator = createServer((req, res) => {
    if (req.url === "/supported") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }] }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => facilitator.listen(0, "127.0.0.1", r));
  facilitatorUrl = `http://127.0.0.1:${(facilitator.address() as any).port}`;
});
afterAll(() => facilitator.close());

describe("payments enabled (Phase H)", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...OLD_ENV,
      PAYMENTS_ENABLED: "true",
      RECEIVE_WALLET_ADDRESS: RECEIVE,
      FACILITATOR_URL: facilitatorUrl,
    };
  });
  afterEach(() => {
    process.env = OLD_ENV;
  });

  async function freshApp() {
    const { openDb } = await import("../src/db.js");
    const { computeScores } = await import("../src/score.js");
    const { buildApp } = await import("../src/server.js");
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO services (id, domain, status, first_seen, last_seen, raw) VALUES (?,?,?,?,?,?)"
    ).run("https://good.example/a", "good.example", "curated", 1, 1, "{}");
    const ins = db.prepare(
      "INSERT INTO probes (service_id, ts, ok_settlement, ok_schema, usdc_cost) VALUES (?,?,1,1,0.005)"
    );
    for (let i = 0; i < 25; i++) ins.run("https://good.example/a", Date.now() - i * 3600_000);
    computeScores(db);
    return buildApp(db);
  }

  it("challenges unpaid /score requests with a PAYMENT-REQUIRED header on Base mainnet", async () => {
    const app = await freshApp();
    const res = await app.request(`/score/${encodeURIComponent("https://good.example/a")}`);
    expect(res.status).toBe(402);
    const header = res.headers.get("PAYMENT-REQUIRED");
    expect(header).toBeTruthy();
    const challenge = JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
    const accepts = JSON.stringify(challenge);
    expect(accepts).toContain("eip155:8453");
    expect(accepts).toContain(RECEIVE);
    // Pin the PRICE: $0.005 = 5000 atomic USDC units. Without this, an accidental change to the
    // configured /score price passes every other assertion in this file silently.
    expect(accepts).toContain("5000");
    // Bazaar catalog metadata rides the challenge: the icon must point at our hosted PNG.
    expect(accepts).toContain("/icon.png");
  });

  it("query-form /score is gated and pins the canonical public https resource", async () => {
    const app = await freshApp();
    const res = await app.request(`/score?service=${encodeURIComponent("https://good.example/a")}`);
    expect(res.status).toBe(402);
    const challenge = JSON.parse(
      Buffer.from(res.headers.get("PAYMENT-REQUIRED")!, "base64").toString("utf8")
    );
    // The whole point of the query route: the catalog identity must be the public https
    // URL regardless of how the request reached us (loopback here), or CDP drops it.
    expect(challenge.resource.url).toBe("https://assay.nominal-labs.com/score");
    expect(JSON.stringify(challenge)).toContain("5000");
  });

  it("keeps /tier, /leaderboard and /healthz free while /score is gated", async () => {
    const app = await freshApp();
    // Drive middleware initialization to completion first so no init races the test teardown.
    expect((await app.request(`/score/${encodeURIComponent("https://good.example/a")}`)).status).toBe(402);
    for (const path of [
      `/tier/${encodeURIComponent("https://good.example/a")}`,
      "/leaderboard",
      "/healthz",
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
    }
  });
});
