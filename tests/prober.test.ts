import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { saveTemplate } from "../src/templates.js";
import { runProbes, spentTodayUsdc } from "../src/prober.js";

function seed(db: any) {
  db.prepare(
    "INSERT INTO services (id, domain, status, price_usdc, first_seen, last_seen, raw) VALUES (?,?,?,?,?,?,?)"
  ).run("https://api.example.com/price", "api.example.com", "discovered", 0.005, 1, 1, "{}");
  saveTemplate(db, {
    serviceId: "https://api.example.com/price",
    method: "GET",
    url: "https://api.example.com/price?pair=ETH-USD",
    headers: {},
    responseSchema: { type: "object", required: ["price"], properties: { price: { type: "number" } } },
    groundTruth: { path: "price", refSource: "coingecko", refId: "ethereum", refField: "usd", tolerancePct: 1.5 },
  });
}

const okPayFetch = (async () =>
  new Response(JSON.stringify({ price: 3030 }), { status: 200 })) as typeof fetch;
const cgFetch = (async () =>
  new Response(JSON.stringify({ ethereum: { usd: 3000 } }), { status: 200 })) as typeof fetch;

describe("runProbes", () => {
  it("records a successful probe with evaluations", async () => {
    const db = openDb(":memory:");
    seed(db);
    const r = await runProbes(db, { payFetch: okPayFetch, refFetch: cgFetch });
    expect(r.probed).toBe(1);
    const p: any = db.prepare("SELECT * FROM probes").get();
    expect(p.ok_settlement).toBe(1);
    expect(p.ok_schema).toBe(1);
    expect(p.gt_deviation_pct).toBeCloseTo(1.0);
    expect(p.usdc_cost).toBeCloseTo(0.005);
  });

  it("records paid-but-denied as data, not an exception", async () => {
    const db = openDb(":memory:");
    seed(db);
    const denyFetch = (async () => new Response("err", { status: 500 })) as typeof fetch;
    const r = await runProbes(db, { payFetch: denyFetch, refFetch: cgFetch });
    expect(r.probed).toBe(1);
    const p: any = db.prepare("SELECT * FROM probes").get();
    expect(p.ok_settlement).toBe(0);
    expect(p.http_status).toBe(500);
  });

  it("halts when daily budget is spent", async () => {
    const db = openDb(":memory:");
    seed(db);
    db.prepare(
      "INSERT INTO probes (service_id, ts, ok_settlement, usdc_cost) VALUES (?,?,1,?)"
    ).run("https://api.example.com/price", Date.now(), 999);
    const r = await runProbes(db, { payFetch: okPayFetch, refFetch: cgFetch });
    expect(r.skipped).toBe("budget");
    expect(r.probed).toBe(0);
    expect(spentTodayUsdc(db, Date.now())).toBe(999);
  });
});
