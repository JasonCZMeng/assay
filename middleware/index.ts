// wrapFetchWithAssay — a spend-guard for x402 agents. Wrap your (paying) fetch and every
// request is pre-checked against Assay's quality tier for that exact resource URL; requests
// to services Assay rates "avoid" (or below your minTier) throw AssayBlockedError BEFORE any
// payment is authorized. Free tier lookups, no API key, ~1 cached call per URL per hour.
//
//   import { privateKeyToAccount } from "viem/accounts";
//   import { ExactEvmScheme } from "@x402/evm";
//   import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
//   import { wrapFetchWithAssay } from "assay-x402-guard";
//
//   const account = privateKeyToAccount(process.env.WALLET_KEY as `0x${string}`);
//   const client = new x402Client().register("eip155:8453", new ExactEvmScheme(account));
//   const payFetch = wrapFetchWithPayment(fetch, client);
//   const safeFetch = wrapFetchWithAssay(payFetch);           // guard goes OUTSIDE
//   await safeFetch("https://some-x402-service.example/api"); // blocked if tier=avoid

export type AssayTier = "gold" | "ok" | "avoid" | "unrated";

export type AssayGuardOptions = {
  /** Assay instance to consult. */
  assayUrl?: string;
  /** Minimum acceptable tier: "ok" (default) blocks only "avoid"; "gold" blocks "ok" too. */
  minTier?: "gold" | "ok";
  /** Services with <20 probes are "unrated". Default "allow" — unrated is unproven, not bad. */
  onUnrated?: "allow" | "block";
  /** Services Assay has never catalogued. Default "allow". */
  onUnknown?: "allow" | "block";
  /** Tier cache TTL. Assay's own tier cache is 1h; default matches. */
  cacheTtlMs?: number;
  /** If the Assay lookup itself fails, allow the request (default true — never brick the agent). */
  failOpen?: boolean;
  /** Injectable for tests. Used ONLY for tier lookups, never for the guarded request. */
  lookupFetch?: typeof fetch;
};

export class AssayBlockedError extends Error {
  readonly service: string;
  /** "unknown" = Assay has no record of the service; "error" = the tier lookup itself failed. */
  readonly tier: AssayTier | "unknown" | "error";
  constructor(service: string, tier: AssayTier | "unknown" | "error") {
    super(
      `Assay guard blocked payment to ${service} (tier: ${tier}). ` +
        `See https://assay.nominal-labs.com/tier/${encodeURIComponent(service)}`
    );
    this.name = "AssayBlockedError";
    this.service = service;
    this.tier = tier;
  }
}

const RANK: Record<AssayTier, number> = { gold: 3, ok: 2, avoid: 0, unrated: 1 };

// Transient lookup failures short-circuit for at most this long — caching an "error" for the
// full 1h TTL would leave an "avoid" service unguarded for an hour after a single blip.
const ERROR_TTL_MS = 60_000;

export function wrapFetchWithAssay(
  baseFetch: typeof fetch,
  opts: AssayGuardOptions = {}
): typeof fetch {
  const assayUrl = (opts.assayUrl ?? "https://assay.nominal-labs.com").replace(/\/$/, "");
  // Compare by parsed origin, never string prefix: a host like `assay.nominal-labs.com.evil.com`
  // starts with the Assay URL string and would otherwise be waved through the guard unchecked.
  const assayOrigin = new URL(assayUrl).origin;
  const minTier = opts.minTier ?? "ok";
  const onUnrated = opts.onUnrated ?? "allow";
  const onUnknown = opts.onUnknown ?? "allow";
  const ttl = opts.cacheTtlMs ?? 3_600_000;
  const failOpen = opts.failOpen ?? true;
  const lookupFetch = opts.lookupFetch ?? fetch;
  // Bounded: pathological URL churn would otherwise grow this map without limit in a
  // long-running agent. Map preserves insertion order, so deleting the first key is FIFO eviction.
  const CACHE_MAX = 5_000;
  const cache = new Map<string, { tier: AssayTier | "unknown" | "error"; at: number }>();
  function cacheSet(url: string, entry: { tier: AssayTier | "unknown" | "error"; at: number }) {
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(url, entry);
  }

  async function tierOf(url: string): Promise<AssayTier | "unknown" | "error"> {
    const hit = cache.get(url);
    const maxAge = hit?.tier === "error" ? Math.min(ttl, ERROR_TTL_MS) : ttl;
    if (hit && Date.now() - hit.at < maxAge) return hit.tier;
    let tier: AssayTier | "unknown" | "error";
    try {
      const res = await lookupFetch(`${assayUrl}/tier/${encodeURIComponent(url)}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 404) tier = "unknown";
      else if (res.ok) tier = ((await res.json()) as { tier: AssayTier }).tier ?? "unknown";
      else tier = "error";
    } catch {
      tier = "error";
    }
    cacheSet(url, { tier, at: Date.now() });
    return tier;
  }

  const wrapped = async (input: any, init?: any): Promise<Response> => {
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    // Parse, never regex-match: the URL constructor trims whitespace and lowercases the
    // scheme, so "HTTPS://bad.example" or " https://bad.example" (which fetch happily
    // normalizes and pays) cannot slip past the guard un-checked.
    let parsed: URL | null = null;
    if (typeof raw === "string") {
      try {
        parsed = new URL(raw);
      } catch {
        parsed = null; // unparseable — fetch will reject it; nothing to guard
      }
    }
    if (
      parsed &&
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.origin !== assayOrigin
    ) {
      // Only origin+path leaves the process: query strings can carry API keys or payloads,
      // and services are catalogued by their stable resource path anyway — stripping also
      // makes the cache effective for query-varying agent traffic.
      const lookupUrl = parsed.origin + parsed.pathname;
      const tier = await tierOf(lookupUrl);
      if (tier === "error") {
        if (!failOpen) throw new AssayBlockedError(lookupUrl, "error");
      } else if (tier === "unknown") {
        if (onUnknown === "block") throw new AssayBlockedError(lookupUrl, "unknown");
      } else if (tier === "unrated") {
        if (onUnrated === "block") throw new AssayBlockedError(lookupUrl, tier);
      } else if (RANK[tier] < RANK[minTier]) {
        throw new AssayBlockedError(lookupUrl, tier);
      }
    }
    return baseFetch(input, init);
  };
  return wrapped as typeof fetch;
}
