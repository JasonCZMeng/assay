import { describe, it, expect } from "vitest";
import { wrapFetchWithAssay, AssayBlockedError } from "../middleware/index.js";

function fakeLookup(tiers: Record<string, string | number>) {
  return (async (input: any) => {
    const url = String(input);
    const svc = decodeURIComponent(url.split("/tier/")[1] ?? "");
    const t = tiers[svc];
    if (t === 404) return new Response(JSON.stringify({ error: "unknown service" }), { status: 404 });
    if (t === 500) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify({ service: svc, tier: t }), { status: 200 });
  }) as typeof fetch;
}

const okBase = (async () => new Response("paid content", { status: 200 })) as typeof fetch;

describe("wrapFetchWithAssay", () => {
  it("allows gold and ok, blocks avoid at default minTier", async () => {
    const f = wrapFetchWithAssay(okBase, {
      lookupFetch: fakeLookup({
        "https://good.example/a": "gold",
        "https://fine.example/a": "ok",
        "https://bad.example/a": "avoid",
      }),
    });
    expect((await f("https://good.example/a")).status).toBe(200);
    expect((await f("https://fine.example/a")).status).toBe(200);
    await expect(f("https://bad.example/a")).rejects.toThrow(AssayBlockedError);
  });

  it("minTier gold blocks ok-tier services", async () => {
    const f = wrapFetchWithAssay(okBase, {
      minTier: "gold",
      lookupFetch: fakeLookup({ "https://fine.example/a": "ok" }),
    });
    await expect(f("https://fine.example/a")).rejects.toThrow(AssayBlockedError);
  });

  it("unrated and unknown default to allow, can be set to block", async () => {
    const tiers = { "https://new.example/a": "unrated", "https://ghost.example/a": 404 };
    const lax = wrapFetchWithAssay(okBase, { lookupFetch: fakeLookup(tiers) });
    expect((await lax("https://new.example/a")).status).toBe(200);
    expect((await lax("https://ghost.example/a")).status).toBe(200);

    const strict = wrapFetchWithAssay(okBase, {
      onUnrated: "block",
      onUnknown: "block",
      lookupFetch: fakeLookup(tiers),
    });
    await expect(strict("https://new.example/a")).rejects.toThrow(AssayBlockedError);
    await expect(strict("https://ghost.example/a")).rejects.toThrow(AssayBlockedError);
  });

  it("fails open on Assay outage by default, closed when failOpen=false", async () => {
    const tiers = { "https://any.example/a": 500 };
    const open = wrapFetchWithAssay(okBase, { lookupFetch: fakeLookup(tiers) });
    expect((await open("https://any.example/a")).status).toBe(200);

    const closed = wrapFetchWithAssay(okBase, { failOpen: false, lookupFetch: fakeLookup(tiers) });
    await expect(closed("https://any.example/a")).rejects.toThrow(AssayBlockedError);
  });

  it("caches tier lookups per URL", async () => {
    let calls = 0;
    const counting = (async (input: any) => {
      calls++;
      return new Response(JSON.stringify({ tier: "gold" }), { status: 200 });
    }) as typeof fetch;
    const f = wrapFetchWithAssay(okBase, { lookupFetch: counting });
    await f("https://good.example/a");
    await f("https://good.example/a");
    await f("https://good.example/a");
    expect(calls).toBe(1);
  });

  it("never guards requests to Assay itself", async () => {
    let lookups = 0;
    const counting = (async () => {
      lookups++;
      return new Response(JSON.stringify({ tier: "gold" }), { status: 200 });
    }) as typeof fetch;
    const f = wrapFetchWithAssay(okBase, { lookupFetch: counting });
    await f("https://assay.nominal-labs.com/tier/whatever");
    expect(lookups).toBe(0);
  });
});
