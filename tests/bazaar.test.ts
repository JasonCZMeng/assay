import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { ingestBazaar } from "../src/bazaar.js";

// Real API shape (verified live against
// https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources):
// { items: [...], pagination: { limit, offset, total }, x402Version }
// There is no `nextOffset` field on the real payload.
const page = (items: any[], pagination: { limit: number; offset: number; total: number }) =>
  new Response(JSON.stringify({ items, pagination, x402Version: 2 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

// Real Bazaar item shape (verified live): serviceName, tags[], accepts[{amount, network, asset}]
const item = (url: string) => ({
  resource: url,
  type: "http",
  x402Version: 2,
  serviceName: "Price API",
  tags: ["data"],
  accepts: [{ amount: "5000", network: "eip155:8453", asset: "USDC" }],
});

// Legacy Bazaar item shape: metadata.name, metadata.category, accepts[{maxAmountRequired}]
const legacyItem = (url: string) => ({
  resource: url,
  type: "http",
  x402Version: 2,
  metadata: { name: "Legacy API", category: "legacy" },
  accepts: [{ maxAmountRequired: "2000", network: "base", asset: "USDC" }],
});

describe("ingestBazaar", () => {
  it("upserts services and preserves status on re-ingest (real Bazaar shape)", async () => {
    const db = openDb(":memory:");
    const fakeFetch = (async () =>
      page([item("https://api.example.com/price")], { limit: 100, offset: 0, total: 1 })) as typeof fetch;

    const r1 = await ingestBazaar(db, fakeFetch);
    expect(r1.upserted).toBe(1);

    db.prepare("UPDATE services SET status='curated' WHERE id=?").run(
      "https://api.example.com/price"
    );
    await ingestBazaar(db, fakeFetch);
    const row: any = db
      .prepare("SELECT status, domain, price_usdc, name, category FROM services WHERE id=?")
      .get("https://api.example.com/price");
    expect(row.status).toBe("curated"); // not clobbered
    expect(row.domain).toBe("api.example.com");
    expect(row.price_usdc).toBeCloseTo(0.005); // 5000 units of 6-decimal USDC
    expect(row.name).toBe("Price API"); // mapped from serviceName
    expect(row.category).toBe("data"); // mapped from tags[0]
  });

  it("walks multiple pages using the real pagination.total field and upserts every item", async () => {
    const db = openDb(":memory:");
    let calls = 0;
    const fakeFetch = (async (url: string | URL | Request) => {
      calls++;
      const offset = Number(new URL(url as string).searchParams.get("offset"));
      if (offset === 0) {
        return page(
          [item("https://api.example.com/one"), item("https://api.example.com/two")],
          { limit: 2, offset: 0, total: 4 }
        );
      }
      return page(
        [item("https://api.example.com/three"), item("https://api.example.com/four")],
        { limit: 2, offset: 2, total: 4 }
      );
    }) as typeof fetch;

    const r = await ingestBazaar(db, fakeFetch);

    expect(calls).toBe(2);
    expect(r.upserted).toBe(4);
    const count: any = db.prepare("SELECT COUNT(*) c FROM services").get();
    expect(count.c).toBe(4);
    for (const id of [
      "https://api.example.com/one",
      "https://api.example.com/two",
      "https://api.example.com/three",
      "https://api.example.com/four",
    ]) {
      const row = db.prepare("SELECT id FROM services WHERE id=?").get(id);
      expect(row).toBeTruthy();
    }
  });

  it("throws when the API responds with HTTP 500", async () => {
    const db = openDb(":memory:");
    const fakeFetch = (async () =>
      new Response("boom", { status: 500 })) as typeof fetch;

    await expect(ingestBazaar(db, fakeFetch)).rejects.toThrow("HTTP 500");
  });

  it("falls back to legacy metadata shape (maxAmountRequired, metadata.name/category)", async () => {
    const db = openDb(":memory:");
    const fakeFetch = (async () =>
      page([legacyItem("https://api.example.com/legacy")], { limit: 100, offset: 0, total: 1 })) as typeof fetch;

    const r = await ingestBazaar(db, fakeFetch);
    expect(r.upserted).toBe(1);

    const row: any = db
      .prepare("SELECT price_usdc, name, category FROM services WHERE id=?")
      .get("https://api.example.com/legacy");
    expect(row.price_usdc).toBeCloseTo(0.002); // 2000 units of 6-decimal USDC
    expect(row.name).toBe("Legacy API"); // from metadata.name
    expect(row.category).toBe("legacy"); // from metadata.category
  });
});
