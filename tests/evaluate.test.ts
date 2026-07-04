import { describe, it, expect } from "vitest";
import { evalSchema, evalGroundTruth, getPath } from "../src/evaluate.js";

describe("evalSchema", () => {
  const schema = { type: "object", required: ["price"], properties: { price: { type: "number" } } };
  it("passes conforming payload", () => expect(evalSchema({ price: 3021.5 }, schema)).toBe(true));
  it("fails missing field", () => expect(evalSchema({ px: 1 }, schema)).toBe(false));
  it("fails wrong type", () => expect(evalSchema({ price: "3021" }, schema)).toBe(false));
});

describe("getPath", () => {
  it("walks dot paths", () => expect(getPath({ data: { price: 5 } }, "data.price")).toBe(5));
});

describe("evalGroundTruth", () => {
  const gt = { path: "price", refSource: "coingecko" as const, refId: "ethereum", refField: "usd", tolerancePct: 1.5 };
  const cgFetch = (async () =>
    new Response(JSON.stringify({ ethereum: { usd: 3000 } }), { status: 200 })) as typeof fetch;

  it("computes deviation pct", async () => {
    expect(await evalGroundTruth({ price: 3030 }, gt, cgFetch)).toBeCloseTo(1.0);
  });
  it("returns null when reference is down", async () => {
    const down = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    expect(await evalGroundTruth({ price: 3030 }, gt, down)).toBeNull();
  });
  it("returns 100 when value is not a number (worst case, not null)", async () => {
    expect(await evalGroundTruth({ price: "abc" }, gt, cgFetch)).toBe(100);
  });
});
