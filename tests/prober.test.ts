import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { saveTemplate } from "../src/templates.js";
import { setSetting } from "../src/db.js";
import { runProbes, spentTodayUsdc, withinCap, paymentAllowed, HARD_CAP_USDC_UNITS, BASE_USDC } from "../src/prober.js";

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
    // An injected payFetch never goes through the payment hook, so no amount is authorized —
    // usdc_cost records ACTUAL spend, which is 0 here (not the Bazaar catalog price).
    expect(p.usdc_cost).toBe(0);
  });

  it("records the ACTUAL authorized amount as usdc_cost, not the catalog price", async () => {
    const db = openDb(":memory:");
    seed(db); // service lists catalog price 0.005
    // makePayFetch factory that reports a *different* real amount (0.01 = 10000 atomic units).
    const factory = (onPay?: (a: bigint) => void) =>
      (async () => {
        onPay?.(10_000n);
        return new Response(JSON.stringify({ price: 3030 }), { status: 200 });
      }) as typeof fetch;
    const r = await runProbes(db, { makePayFetch: factory, refFetch: cgFetch });
    expect(r.probed).toBe(1);
    const p: any = db.prepare("SELECT * FROM probes").get();
    expect(p.usdc_cost).toBeCloseTo(0.01); // actual paid, not the 0.005 catalog price
  });

  it("records usdc_cost 0 when no payment is authorized (free 2xx / guard abort)", async () => {
    const db = openDb(":memory:");
    seed(db);
    // factory whose fetch never calls onPay — models a free endpoint or an aborted payment.
    const factory = (_onPay?: (a: bigint) => void) =>
      (async () => new Response(JSON.stringify({ price: 3030 }), { status: 200 })) as typeof fetch;
    const r = await runProbes(db, { makePayFetch: factory, refFetch: cgFetch });
    expect(r.probed).toBe(1);
    const p: any = db.prepare("SELECT * FROM probes").get();
    expect(p.usdc_cost).toBe(0);
  });

  it("halts immediately when paused mid-run", async () => {
    const db = openDb(":memory:");
    seed(db);
    setSetting(db, "paused", "1");
    const r = await runProbes(db, { payFetch: okPayFetch, refFetch: cgFetch });
    expect(r.skipped).toBe("paused");
    expect(r.probed).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM probes").get() as any).c).toBe(0);
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

  it("records a rejected payFetch as an errored probe, not an unhandled rejection", async () => {
    const db = openDb(":memory:");
    seed(db);
    const rejectFetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const r = await runProbes(db, { payFetch: rejectFetch, refFetch: cgFetch });
    expect(r.probed).toBe(1);
    const p: any = db.prepare("SELECT * FROM probes").get();
    expect(p.ok_settlement).toBe(0);
    expect(p.error).not.toBeNull();
    expect(p.http_status).toBeNull();
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

  it("re-checks the budget mid-run and stops before the probe that would exceed it", async () => {
    const db = openDb(":memory:");
    const svcA = "https://api.example.com/a";
    const svcB = "https://api.example.com/b";
    for (const id of [svcA, svcB]) {
      db.prepare(
        "INSERT INTO services (id, domain, status, price_usdc, first_seen, last_seen, raw) VALUES (?,?,?,?,?,?,?)"
      ).run(id, new URL(id).hostname, "discovered", 1, 1, 1, "{}");
      saveTemplate(db, {
        serviceId: id,
        method: "GET",
        url: id,
        headers: {},
        responseSchema: { type: "object" },
      });
    }
    // Default daily budget is 5 (see src/config.ts). Seed spend to 4 — just under budget. The
    // first probe pays a real $1 (1,000,000 atomic units), landing total spend on the budget, so
    // the second probe must be skipped.
    db.prepare(
      "INSERT INTO probes (service_id, ts, ok_settlement, usdc_cost) VALUES (?,?,1,?)"
    ).run(svcA, Date.now(), 4);
    const payDollar = (onPay?: (a: bigint) => void) =>
      (async () => {
        onPay?.(1_000_000n);
        return new Response(JSON.stringify({ price: 1 }), { status: 200 });
      }) as typeof fetch;

    const r = await runProbes(db, { makePayFetch: payDollar, refFetch: cgFetch });
    expect(r.probed).toBe(1);
    expect(r.skipped).toBe("budget");
  });

  it("scores a literal JSON `null` response body as a schema failure, not unevaluated", async () => {
    const db = openDb(":memory:");
    seed(db);
    const nullFetch = (async () => new Response("null", { status: 200 })) as typeof fetch;
    const r = await runProbes(db, { payFetch: nullFetch, refFetch: cgFetch });
    expect(r.probed).toBe(1);
    const p: any = db.prepare("SELECT * FROM probes").get();
    expect(p.ok_settlement).toBe(1);
    expect(p.ok_schema).toBe(0);
  });
});

describe("withinCap", () => {
  it("accepts amounts at or below the hard cap (0.05 USDC / 50000 atomic units)", () => {
    expect(withinCap(0)).toBe(true);
    expect(withinCap(1)).toBe(true);
    expect(withinCap(50_000)).toBe(true);
    expect(withinCap("50000")).toBe(true);
    expect(withinCap(HARD_CAP_USDC_UNITS)).toBe(true);
  });

  it("rejects amounts above the hard cap", () => {
    expect(withinCap(50_001)).toBe(false);
    expect(withinCap("100000")).toBe(false);
    expect(withinCap(HARD_CAP_USDC_UNITS + 1n)).toBe(false);
  });

  it("fails closed on unparsable amounts", () => {
    expect(withinCap("not-a-number")).toBe(false);
  });
});

describe("paymentAllowed", () => {
  it("rejects payments with a different asset address", () => {
    const result = paymentAllowed({
      asset: "0x1234567890123456789012345678901234567890",
      amount: "1000",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("is not BASE_USDC");
    }
  });

  it("accepts payments with BASE_USDC in lowercase", () => {
    const result = paymentAllowed({
      asset: BASE_USDC.toLowerCase(),
      amount: "1000",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts payments with BASE_USDC in uppercase", () => {
    const result = paymentAllowed({
      asset: BASE_USDC.toUpperCase(),
      amount: "1000",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts payments with BASE_USDC in mixed case", () => {
    const result = paymentAllowed({
      asset: BASE_USDC,
      amount: "1000",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects payments with BASE_USDC but amount exceeding the cap", () => {
    const result = paymentAllowed({
      asset: BASE_USDC,
      amount: "100000",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("exceeds hard cap");
    }
  });

  it("accepts payments with BASE_USDC and amount within the cap", () => {
    const result = paymentAllowed({
      asset: BASE_USDC,
      amount: "50000",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects payments with missing asset", () => {
    const result = paymentAllowed({
      asset: undefined,
      amount: "1000",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("is not BASE_USDC");
    }
  });

  it("fails CLOSED on a missing amount (does not treat undefined as 0)", () => {
    const result = paymentAllowed({ asset: BASE_USDC, amount: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("missing");
  });
});
