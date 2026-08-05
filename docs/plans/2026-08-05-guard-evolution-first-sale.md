# Guard Evolution — Milestone 1 of Evolve-Until-First-Sale

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two conversion leaks between Assay's distribution surfaces and its paid `/score` endpoint: (1) agents choosing among N candidate services have no one-call way to rank them, (2) MCP agents that hit the 402 on `get_score` are told "go get an x402 client" and bounce.

**Architecture:** Three thin layers, no new files beyond what exists. Server grows one free bulk endpoint (`GET /tiers`). The `assay-x402-guard` package (middleware/index.ts, zero-dep) grows two exports: `rankCandidates` (bulk tier ranking) and `purchaseScore` (paid evidence purchase through the caller's own payFetch). The `assay-oracle-mcp` server gains a `rank_services` tool and an opt-in `ASSAY_WALLET_KEY` env var that lets `get_score` transparently pay the $0.005 instead of dead-ending on 402.

**Tech Stack:** Hono + better-sqlite3 (server), vitest (root `tests/`), TypeScript ESM everywhere. MCP package: `@modelcontextprotocol/sdk`, and (new) `@x402/fetch` + `@x402/evm` + `viem` for the opt-in payer.

## Global Constraints

- Free tier stays label-only: `/tiers` returns `{service, tier}` pairs, never composite/components (that's the paid product).
- `middleware/` keeps **zero runtime dependencies** — `purchaseScore` receives the caller's payFetch, it never constructs one.
- Payment cap: any code that pays MUST verify amount ≤ 0.01 USDC and asset = Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` before signing (same guard philosophy as `makePayFetch` in src/prober.ts).
- Bulk endpoint caps at 50 services per request; over-limit is a 400, not a truncation.
- Package versions: both packages bump to 0.2.0.
- Deploy ships via git bundle per deploy/README.md §8 (`npm install`, not `ci`, on the VPS).

---

### Task 1: `GET /tiers` bulk endpoint

**Files:**
- Modify: `src/server.ts` (insert after the `/tier/:id` route, ~line 213)
- Test: `tests/server.test.ts` (append to `describe("server")`)

**Interfaces:**
- Consumes: `latestScore(db, id)` and `tierFor(composite)` from `src/score.ts` (already imported by server.ts).
- Produces: `GET /tiers?services=<comma-separated URL-encoded resource URLs>` → 200 `{ tiers: [{ service, tier }] }` where tier ∈ gold|ok|avoid|unrated|unknown. 400 on missing param or >50 services. `Cache-Control: public, max-age=300`.

- [ ] **Step 1: Write the failing tests**

```ts
  it("bulk /tiers ranks a candidate list in one call", async () => {
    const db = openDb(":memory:");
    seedScored(db, "https://gold.example/a", 95);
    seedScored(db, "https://mid.example/a", 70);
    const app = buildApp(db);
    const q = ["https://gold.example/a", "https://mid.example/a", "https://ghost.example/x"]
      .map(encodeURIComponent)
      .join(",");
    const res = await app.request(`/tiers?services=${q}`);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.tiers).toEqual([
      { service: "https://gold.example/a", tier: "gold" },
      { service: "https://mid.example/a", tier: "ok" },
      { service: "https://ghost.example/x", tier: "unknown" },
    ]);
    expect(res.headers.get("cache-control")).toContain("max-age=300");
  });

  it("bulk /tiers rejects missing and oversized requests", async () => {
    const db = openDb(":memory:");
    const app = buildApp(db);
    expect((await app.request("/tiers")).status).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) =>
      encodeURIComponent(`https://s${i}.example/a`)
    ).join(",");
    expect((await app.request(`/tiers?services=${many}`)).status).toBe(400);
  });
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/server.test.ts` → FAIL (404 for /tiers).

- [ ] **Step 3: Implement the route** (in `buildApp`, directly after the `/tier/:id` handler)

```ts
  // Bulk form of /tier — one call to rank a whole candidate list. Free and label-only
  // like /tier; the paid /score endpoint is where composites and evidence live.
  app.get("/tiers", (c) => {
    const raw = c.req.query("services");
    if (!raw) return c.json({ error: "missing ?services= (comma-separated URL-encoded resource URLs)" }, 400);
    const ids = raw.split(",").filter(Boolean).map((s) => {
      try { return decodeURIComponent(s); } catch { return s; }
    });
    if (ids.length > 50) return c.json({ error: "max 50 services per request" }, 400);
    const tiers = ids.map((id) => {
      const s = latestScore(db, id);
      return { service: id, tier: s ? tierFor(s.composite) : "unknown" };
    });
    c.header("Cache-Control", "public, max-age=300");
    return c.json({ tiers });
  });
```

Note: Hono decodes query values once already (repo rule: no manual decodeURIComponent on **route params**) — but `services` is a comma-joined list whose *elements* are individually encoded by the client, so the per-element decode above is correct, with a try/catch for malformed elements.

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/server.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add src/server.ts tests/server.test.ts && git commit -m "feat: free bulk GET /tiers — rank a candidate list in one call"`

---

### Task 2: `rankCandidates` in assay-x402-guard

**Files:**
- Modify: `middleware/index.ts` (append)
- Test: `tests/middleware.test.ts` (append)

**Interfaces:**
- Consumes: the `/tiers` response shape from Task 1.
- Produces: `rankCandidates(urls: string[], opts?: { assayUrl?: string; lookupFetch?: typeof fetch }): Promise<{ service: string; tier: AssayTier | "unknown" }[]>` — sorted best-tier-first, stable within a tier (input order preserved). Throws on lookup failure (callers ranking candidates need to know ranking failed; there is no request to fail open into).

- [ ] **Step 1: Write the failing tests**

```ts
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
```

(Add `rankCandidates` to the existing import from `../middleware/index.js`.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/middleware.test.ts` → FAIL (no export).

- [ ] **Step 3: Implement** (append to `middleware/index.ts`)

```ts
// rankCandidates — one free bulk call to order a candidate list before an agent picks who
// to pay. Unknown ranks below unrated: unrated is at least catalogued and being probed.
const RANK_ALL: Record<AssayTier | "unknown", number> = { gold: 4, ok: 3, unrated: 2, unknown: 1, avoid: 0 };

export async function rankCandidates(
  urls: string[],
  opts: { assayUrl?: string; lookupFetch?: typeof fetch } = {}
): Promise<{ service: string; tier: AssayTier | "unknown" }[]> {
  const assayUrl = (opts.assayUrl ?? "https://assay.nominal-labs.com").replace(/\/$/, "");
  const lookupFetch = opts.lookupFetch ?? fetch;
  const q = urls.map(encodeURIComponent).join(",");
  const res = await lookupFetch(`${assayUrl}/tiers?services=${q}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`assay /tiers lookup failed: HTTP ${res.status}`);
  const { tiers } = (await res.json()) as { tiers: { service: string; tier: AssayTier | "unknown" }[] };
  return tiers
    .map((t, i) => ({ ...t, i }))
    .sort((a, b) => RANK_ALL[b.tier] - RANK_ALL[a.tier] || a.i - b.i)
    .map(({ service, tier }) => ({ service, tier }));
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/middleware.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add middleware/index.ts tests/middleware.test.ts && git commit -m "feat(guard): rankCandidates — free one-call tier ranking of a candidate list"`

---

### Task 3: `purchaseScore` in assay-x402-guard

**Files:**
- Modify: `middleware/index.ts` (append)
- Test: `tests/middleware.test.ts` (append)

**Interfaces:**
- Consumes: nothing new — takes the caller's x402-capable fetch.
- Produces: `purchaseScore(serviceUrl: string, payFetch: typeof fetch, opts?: { assayUrl?: string }): Promise<AssayScore>` where `AssayScore = { service: string; composite: number | null; components: Record<string, number | null>; nProbes: number; trend: number | null; ts: number }`. Throws `Error` with the HTTP status on non-200.

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run to verify failure** — FAIL (no export).

- [ ] **Step 3: Implement**

```ts
export type AssayScore = {
  service: string;
  composite: number | null;
  components: Record<string, number | null>;
  nProbes: number;
  trend: number | null;
  ts: number;
};

// purchaseScore — buy the full evidence report ($0.005) with the agent's own paying fetch.
// The natural follow-up to a block or a ranking tie: tier is the free verdict, this is proof.
export async function purchaseScore(
  serviceUrl: string,
  payFetch: typeof fetch,
  opts: { assayUrl?: string } = {}
): Promise<AssayScore> {
  const assayUrl = (opts.assayUrl ?? "https://assay.nominal-labs.com").replace(/\/$/, "");
  const res = await payFetch(`${assayUrl}/score?service=${encodeURIComponent(serviceUrl)}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`assay /score purchase failed: HTTP ${res.status}`);
  return (await res.json()) as AssayScore;
}
```

- [ ] **Step 4: Run to verify pass** — PASS.
- [ ] **Step 5: Commit** — `git add middleware/index.ts tests/middleware.test.ts && git commit -m "feat(guard): purchaseScore — paid evidence report via the caller's payFetch"`

---

### Task 4: MCP `rank_services` tool + paying `get_score`

**Files:**
- Modify: `mcp/server.mts` (new tool after `check_service`; extend `get_score`; version → 0.2.0)
- Modify: `mcp/package.json` (version 0.2.0; add deps `@x402/fetch`, `@x402/evm`, `viem` — match the major versions the root package uses)
- Test: manual smoke (the mcp package has no vitest harness; do NOT add one — repo rule: simplest working solution)

**Interfaces:**
- Consumes: `/tiers` (Task 1). Env: `ASSAY_WALLET_KEY` (optional hex private key).
- Produces: MCP tool `rank_services({ urls: string[] })`; `get_score` that pays when a wallet key is present.

- [ ] **Step 1: Add `rank_services` tool** (after the `check_service` registration)

```ts
server.registerTool(
  "rank_services",
  {
    title: "Rank x402 candidate services by quality tier",
    description:
      "One call to order a list of candidate x402 services best-first by Assay's quality tier " +
      "(gold/ok/avoid/unrated/unknown), backed by real paid probes. Use when choosing which of " +
      "several services to pay. Free. For per-service evidence, follow up with get_score.",
    inputSchema: {
      urls: z.array(z.string().url()).min(1).max(50).describe("Candidate x402 resource URLs"),
    },
  },
  async ({ urls }) => {
    const q = urls.map(encodeURIComponent).join(",");
    const { status, json } = await api(`/tiers?services=${q}`);
    if (status !== 200 || !json) return apiError(urls.join(", "), status);
    const RANK: Record<string, number> = { gold: 4, ok: 3, unrated: 2, unknown: 1, avoid: 0 };
    const ranked = (json.tiers as { service: string; tier: string }[])
      .map((t, i) => ({ ...t, i }))
      .sort((a, b) => (RANK[b.tier] ?? 0) - (RANK[a.tier] ?? 0) || a.i - b.i)
      .map(({ service, tier }) => ({ service, tier }));
    return text({ ranked, note: "tiers are free labels; get_score returns paid evidence" });
  }
);
```

- [ ] **Step 2: Add the opt-in payer and use it in `get_score`.** Top of file, after existing imports:

```ts
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

// Opt-in: with ASSAY_WALLET_KEY set, get_score pays the $0.005 itself instead of bouncing
// on 402. Hard-capped: refuses any challenge over 0.01 USDC or any asset that is not
// Base-mainnet USDC, so a compromised or misconfigured server cannot drain the wallet.
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
function makeMcpPayFetch(): typeof fetch | null {
  const key = process.env.ASSAY_WALLET_KEY;
  if (!key) return null;
  const account = privateKeyToAccount(key as `0x${string}`);
  const client = new x402Client().register("eip155:8453", new ExactEvmScheme(account));
  client.onBeforePaymentCreation(async (_req, requirements) => {
    const amt = Number(requirements.amount ?? Infinity) / 1e6;
    const asset = String(requirements.asset ?? "");
    if (amt > 0.01 || asset.toLowerCase() !== USDC_BASE.toLowerCase())
      throw new Error(`payment refused: ${amt} of ${asset} exceeds guard (0.01 USDC on Base)`);
  });
  return wrapFetchWithPayment(fetch, client);
}
```

NOTE for implementer: verify the exact `onBeforePaymentCreation` hook name/signature and the `ExactEvmScheme` import path against `src/prober.ts` (which already uses this stack) and `node_modules/@x402/fetch` types — copy the working idiom from prober.ts verbatim if it differs from the sketch above.

In `get_score`'s handler, replace the 402 branch:

```ts
    if (status === 402) {
      const payFetch = makeMcpPayFetch();
      if (!payFetch)
        return text({
          service: url,
          payment_required: true,
          detail:
            "GET /score is a paid x402 endpoint ($0.005 USDC on Base). Set ASSAY_WALLET_KEY " +
            "(a funded Base wallet private key) in this MCP server's env to purchase reports " +
            "automatically, or use the free check_service / rank_services tools.",
        });
      const res = await payFetch(`${ASSAY_URL}/score?service=${encodeURIComponent(url)}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return apiError(url, res.status);
      return text(await res.json());
    }
```

(`ASSAY_URL` — use the existing base-URL constant in server.mts, whatever it is named; check the `api()` helper.)

- [ ] **Step 3: Install deps and build** — `cd mcp && npm install @x402/fetch @x402/evm viem && npm run build` → clean tsc.
- [ ] **Step 4: Smoke test both tools** — with no wallet key: `rank_services` returns ranked list against production, `get_score` returns the payment_required text. (Run the server with the MCP inspector or a 5-line stdio harness; assert by eye.)
- [ ] **Step 5: Commit** — `git add mcp && git commit -m "feat(mcp): rank_services tool + opt-in ASSAY_WALLET_KEY payer for get_score"`

---

### Task 5: Docs — SKILL.md, READMEs, versions

**Files:**
- Modify: `src/skill.ts` (document `/tiers`, `rank_services`, `ASSAY_WALLET_KEY` flow)
- Modify: `middleware/README.md` (rankCandidates + purchaseScore sections, version 0.2.0)
- Modify: `mcp/README.md` (rank_services + wallet-key setup, version 0.2.0)
- Modify: `middleware/package.json`, `mcp/package.json` (0.2.0)

- [ ] **Step 1:** Add `/tiers` to the endpoint list in skill.ts with one example, and a "paying from MCP" paragraph mirroring Task 4's env-var text. Keep the existing voice.
- [ ] **Step 2:** README sections: one runnable snippet per new export/tool (copy the test inputs from Tasks 2–4).
- [ ] **Step 3:** `npx vitest run` (full suite) → all green.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "docs: /tiers, rankCandidates, purchaseScore, MCP wallet flow; 0.2.0"`

---

### Task 6: Deploy server to VPS + verify live

**Files:** none (ops; follows deploy/README.md §8)

- [ ] **Step 1: Ship** —

```sh
git bundle create /tmp/assay.bundle main
ssh root@assay.nominal-labs.com "rm -f /tmp/assay.bundle"
scp /tmp/assay.bundle root@assay.nominal-labs.com:/tmp/
ssh root@assay.nominal-labs.com "sudo -u assay git -C /opt/assay/app fetch /tmp/assay.bundle main && sudo -u assay git -C /opt/assay/app reset --hard FETCH_HEAD && cd /opt/assay/app && sudo -u assay npm install --no-audit --no-fund && systemctl restart assay"
```

- [ ] **Step 2: Verify** — `curl "https://assay.nominal-labs.com/tiers?services=<two known-curated URL-encoded ids>"` → 200 with tiers; `curl https://assay.nominal-labs.com/healthz` → ok:true; `ssh root@assay.nominal-labs.com "journalctl -u assay -n 20"` → clean startup, next cron sweep lands.

---

### Task 7: Publish both packages to npm

**Files:** none (publish `middleware/` and `mcp/` at 0.2.0)

- [ ] **Step 1:** `cd middleware && npm publish` (prepublishOnly builds). Verify: `npm view assay-x402-guard version` → 0.2.0.
- [ ] **Step 2:** `cd mcp && npm publish`. Verify: `npm view assay-oracle-mcp version` → 0.2.0.
- [ ] **Step 3:** Update `mcp/server.json` version and re-publish to the MCP registry the same way it was first published (see git log for the command used with server.json).
- [ ] **Step 4: Commit** any version-stamp changes — `git add -A && git commit -m "chore: publish 0.2.0 (guard + mcp)"` — and push main to origin.

---

## Self-Review

- Spec coverage: bulk endpoint (T1), guard ranking (T2), paid conversion path in guard (T3) and MCP (T4), docs (T5), live deploy (T6), distribution publish (T7). The milestone's conversion thesis is fully implemented.
- Placeholder scan: Task 4 contains one deliberate verify-against-prober note (the x402 client hook name) — flagged as an implementer check against working code in the same repo, not a TBD.
- Type consistency: `AssayTier` reused from the existing export; `rankCandidates` tier union matches `/tiers` output; RANK maps duplicated intentionally in mcp (separate package, zero-dep rule).
