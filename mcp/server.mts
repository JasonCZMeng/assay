#!/usr/bin/env node
// Assay MCP server — lets any MCP-capable agent (Claude Code, Claude Desktop, etc.) check
// x402 service quality before paying. Published as assay-oracle-mcp (npx -y assay-oracle-mcp);
// from the repo: npx tsx mcp/server.mts
// Config: ASSAY_URL (default https://assay.nominal-labs.com).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

// Trailing slash stripped: ASSAY_URL=https://host/ would otherwise build //tier/... paths
// that 404 — silently answering "unknown" for every service instead of failing visibly.
const ASSAY_URL = (process.env.ASSAY_URL ?? "https://assay.nominal-labs.com").replace(/\/+$/, "");

// status 0 = network failure/timeout — callers turn any non-200 into a clean error result
// instead of letting a raw exception (or a null-deref) surface through the MCP framework.
async function api(path: string): Promise<{ status: number; json: any }> {
  try {
    const res = await fetch(`${ASSAY_URL}${path}`, { signal: AbortSignal.timeout(10_000) });
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch {
    return { status: 0, json: null };
  }
}

const apiError = (url: string, status: number) =>
  text({
    service: url,
    error: status ? `assay lookup failed (HTTP ${status})` : "assay unreachable (network error or timeout)",
  });

const TIER_VERDICT: Record<string, string> = {
  gold: "consistently delivers what it charges for — safe to pay",
  ok: "generally delivers, with some failures — acceptable with monitoring",
  avoid: "frequently fails to deliver paid responses correctly — do not pay",
  unrated: "insufficient probe history yet (scores unlock at 20 probes) — treat as unverified",
};

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

// Opt-in payer: with ASSAY_WALLET_KEY set, get_score purchases the $0.005 report itself
// instead of bouncing on 402. Hard-capped exactly like the prober's makePayFetch — refuses
// any challenge over 0.01 USDC or any asset that is not Base-mainnet USDC, so a
// misconfigured (or hostile) endpoint cannot drain the wallet.
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CAP_UNITS = 10_000n; // 0.01 USDC, 6 decimals
function makeMcpPayFetch(): typeof fetch | null {
  const key = process.env.ASSAY_WALLET_KEY;
  if (!key) return null;
  let account;
  try {
    account = privateKeyToAccount(key as `0x${string}`);
  } catch {
    // Never echo the raw exception — it can contain fragments of the private key.
    throw new Error("ASSAY_WALLET_KEY is not a valid private key");
  }
  const client = new x402Client()
    .register("eip155:8453", new ExactEvmScheme(account))
    .onBeforePaymentCreation(async ({ selectedRequirements }) => {
      const asset = selectedRequirements?.asset;
      if (!asset || String(asset).toLowerCase() !== BASE_USDC.toLowerCase())
        return { abort: true, reason: `asset ${asset} is not Base USDC` };
      let n: bigint;
      try {
        n = BigInt(selectedRequirements?.amount ?? "");
      } catch {
        return { abort: true, reason: "missing or unparsable payment amount" };
      }
      if (n < 0n || n > CAP_UNITS)
        return { abort: true, reason: `amount ${n} exceeds cap ${CAP_UNITS} (0.01 USDC)` };
    });
  return wrapFetchWithPayment(fetch, client);
}

const server = new McpServer({ name: "assay", version: "0.2.0" });

server.registerTool(
  "check_service",
  {
    title: "Check x402 service quality tier",
    description:
      "Fast pre-payment check of an x402 service. Returns Assay's quality tier " +
      "(gold/ok/avoid/unrated) with a one-line verdict, based on real paid probes with " +
      "on-chain receipts. Use before paying an unfamiliar x402 endpoint. " +
      "The url must be the service's resource URL exactly as advertised (e.g. in the Bazaar).",
    inputSchema: { url: z.string().url().describe("The x402 service resource URL") },
  },
  async ({ url }) => {
    const { status, json } = await api(`/tier/${encodeURIComponent(url)}`);
    if (status === 404)
      return text({
        service: url,
        tier: "unknown",
        verdict: "not in Assay's curated set — no paid-probe evidence exists; treat as unverified",
      });
    if (status !== 200 || !json) return apiError(url, status);
    return text({ service: url, tier: json.tier, verdict: TIER_VERDICT[json.tier] ?? "" });
  }
);

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

server.registerTool(
  "get_score",
  {
    title: "Get full Assay quality score",
    description:
      "Detailed quality report for an x402 service: composite score (0-100), component " +
      "breakdown (payment settlement, schema conformance, ground-truth accuracy, LLM-judged " +
      "quality), 7-day trend, and probe count. Backed by real paid probes.",
    inputSchema: { url: z.string().url().describe("The x402 service resource URL") },
  },
  async ({ url }) => {
    const { status, json } = await api(`/score/${encodeURIComponent(url)}`);
    if (status === 404) return text({ service: url, error: "not in Assay's curated set" });
    if (status === 402) {
      const payFetch = makeMcpPayFetch();
      if (!payFetch)
        return text({
          service: url,
          payment_required: true,
          detail:
            "GET /score is a paid x402 endpoint ($0.005 USDC on Base mainnet). Set " +
            "ASSAY_WALLET_KEY (a funded Base wallet private key) in this MCP server's env to " +
            "purchase reports automatically, or use the free check_service / rank_services " +
            "tools for tier verdicts.",
        });
      try {
        const res = await payFetch(`${ASSAY_URL}/score?service=${encodeURIComponent(url)}`, {
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) return apiError(url, res.status);
        return text(await res.json());
      } catch (e: unknown) {
        return text({
          service: url,
          error: `score purchase failed: ${String((e as any)?.message ?? e).slice(0, 200)}`,
        });
      }
    }
    if (status !== 200 || !json) return apiError(url, status);
    return text(json);
  }
);

server.registerTool(
  "top_services",
  {
    title: "List Assay-scored x402 services",
    description:
      "Ranked list of x402 services Assay actively probes, best composite score first. " +
      "Use to find trustworthy paid services. Note: unrated entries are still accumulating " +
      "probe history.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).default(15).describe("Max services to return"),
    },
  },
  async ({ limit }) => {
    const { json } = await api("/api/services");
    if (!Array.isArray(json)) return text({ error: "assay API unreachable" });
    const rows = json
      .filter((r: any) => r.status === "curated")
      .sort((a: any, b: any) => (b.composite ?? -1) - (a.composite ?? -1))
      .slice(0, limit)
      .map((r: any) => ({
        service: r.id,
        domain: r.domain,
        tier: r.tier,
        composite: r.composite,
        probes: r.n_probes ?? 0,
        price_usdc: r.price_usdc,
      }));
    return text(rows);
  }
);

await server.connect(new StdioServerTransport());
