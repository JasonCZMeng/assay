// Assay MCP server — lets any MCP-capable agent (Claude Code, Claude Desktop, etc.) check
// x402 service quality before paying. Run: npx tsx mcp/server.mts
// Config: ASSAY_URL (default https://assay.nominal-labs.com; Phase H sets the public domain).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const ASSAY_URL = process.env.ASSAY_URL ?? "https://assay.nominal-labs.com";

async function api(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${ASSAY_URL}${path}`, { signal: AbortSignal.timeout(10_000) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const TIER_VERDICT: Record<string, string> = {
  gold: "consistently delivers what it charges for — safe to pay",
  ok: "generally delivers, with some failures — acceptable with monitoring",
  avoid: "frequently fails to deliver paid responses correctly — do not pay",
  unrated: "insufficient probe history yet (scores unlock at 20 probes) — treat as unverified",
};

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

const server = new McpServer({ name: "assay", version: "0.1.0" });

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
    return text({ service: url, tier: json.tier, verdict: TIER_VERDICT[json.tier] ?? "" });
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
