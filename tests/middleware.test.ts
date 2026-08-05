import { describe, it, expect, vi } from "vitest";
import { wrapFetchWithAssay, AssayBlockedError, rankCandidates, purchaseScore } from "../middleware/index.js";

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

  it("guards uppercase-scheme and whitespace-padded URLs — no normalization bypass", async () => {
    const f = wrapFetchWithAssay(okBase, {
      lookupFetch: fakeLookup({ "https://bad.example/a": "avoid" }),
    });
    await expect(f("HTTPS://bad.example/a")).rejects.toThrow(AssayBlockedError);
    await expect(f("  https://bad.example/a")).rejects.toThrow(AssayBlockedError);
  });

  it("strips query strings and fragments from tier lookups", async () => {
    let seen = "";
    const lookup = (async (input: any) => {
      seen = decodeURIComponent(String(input).split("/tier/")[1] ?? "");
      return new Response(JSON.stringify({ tier: "avoid" }), { status: 200 });
    }) as typeof fetch;
    const f = wrapFetchWithAssay(okBase, { lookupFetch: lookup });
    await expect(f("https://bad.example/a?api_key=SECRET#frag")).rejects.toThrow(AssayBlockedError);
    expect(seen).toBe("https://bad.example/a");
    expect(seen).not.toContain("SECRET");
  });

  it("re-checks after a transient lookup error instead of caching it for the full TTL", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const flaky = (async () => {
        calls++;
        if (calls === 1) return new Response("boom", { status: 500 });
        return new Response(JSON.stringify({ tier: "avoid" }), { status: 200 });
      }) as typeof fetch;
      const f = wrapFetchWithAssay(okBase, { lookupFetch: flaky });
      expect((await f("https://bad.example/a")).status).toBe(200); // fail-open on the blip
      vi.advanceTimersByTime(61_000);
      await expect(f("https://bad.example/a")).rejects.toThrow(AssayBlockedError); // guard restored
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
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

describe("rankCandidates", () => {
  const bulkLookup = (tiers: Record<string, string>) =>
    (async (input: any) => {
      const raw = new URL(String(input)).searchParams.get("services") ?? "";
      const ids = raw.split(",").filter(Boolean).map(decodeURIComponent);
      return new Response(
        JSON.stringify({ tiers: ids.map((id) => ({ service: id, tier: tiers[id] ?? "unknown" })) }),
        { status: 200 }
      );
    }) as typeof fetch;

  it("ranks best tier first, input order stable within tiers", async () => {
    const ranked = await rankCandidates(
      ["https://a.example/x", "https://b.example/x", "https://c.example/x", "https://d.example/x"],
      { lookupFetch: bulkLookup({
          "https://a.example/x": "avoid",
          "https://b.example/x": "gold",
          "https://c.example/x": "ok",
          "https://d.example/x": "gold",
        }) }
    );
    expect(ranked.map((r) => r.service)).toEqual([
      "https://b.example/x", "https://d.example/x", "https://c.example/x", "https://a.example/x",
    ]);
  });

  it("throws when the bulk lookup fails", async () => {
    const boom = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(rankCandidates(["https://a.example/x"], { lookupFetch: boom })).rejects.toThrow();
  });
});

describe("purchaseScore", () => {
  it("purchases the full report through the caller's payFetch", async () => {
    const report = { service: "https://a.example/x", composite: 91.2, components: { settlement: 1 }, nProbes: 40, trend: 0.4, ts: 1 };
    const payFetch = (async (input: any) => {
      expect(String(input)).toBe(
        "https://assay.nominal-labs.com/score?service=" + encodeURIComponent("https://a.example/x")
      );
      return new Response(JSON.stringify(report), { status: 200 });
    }) as typeof fetch;
    expect(await purchaseScore("https://a.example/x", payFetch)).toEqual(report);
  });

  it("throws with status on failure (e.g. unpaid 402)", async () => {
    const noPay = (async () => new Response("{}", { status: 402 })) as typeof fetch;
    await expect(purchaseScore("https://a.example/x", noPay)).rejects.toThrow(/402/);
  });
});
