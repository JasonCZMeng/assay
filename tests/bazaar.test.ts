import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { ingestBazaar } from "../src/bazaar.js";

const page = (items: any[], nextOffset?: number) =>
  new Response(JSON.stringify({ items, ...(nextOffset ? { nextOffset } : {}) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const item = (url: string) => ({
  resource: url,
  type: "http",
  x402Version: 2,
  accepts: [{ maxAmountRequired: "5000", network: "base", asset: "USDC" }],
  metadata: { name: "Price API", category: "data" },
});

describe("ingestBazaar", () => {
  it("upserts services and preserves status on re-ingest", async () => {
    const db = openDb(":memory:");
    const fakeFetch = (async () => page([item("https://api.example.com/price")])) as typeof fetch;

    const r1 = await ingestBazaar(db, fakeFetch);
    expect(r1.upserted).toBe(1);

    db.prepare("UPDATE services SET status='curated' WHERE id=?").run(
      "https://api.example.com/price"
    );
    await ingestBazaar(db, fakeFetch);
    const row: any = db
      .prepare("SELECT status, domain, price_usdc FROM services WHERE id=?")
      .get("https://api.example.com/price");
    expect(row.status).toBe("curated"); // not clobbered
    expect(row.domain).toBe("api.example.com");
    expect(row.price_usdc).toBeCloseTo(0.005); // 5000 units of 6-decimal USDC
  });
});
