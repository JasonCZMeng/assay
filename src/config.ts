import "dotenv/config";

// Fail closed: a bogus env var must never become NaN. `spent >= NaN` is always false, so a NaN
// daily budget would silently disable the spend guard entirely — parse defensively and fall
// back to the default (loudly) instead of letting garbage input through.
function parseNumericEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.error(`[config] invalid ${name}=${JSON.stringify(raw)} — falling back to default ${fallback}`);
    return fallback;
  }
  return parsed;
}

export const config = {
  dbPath: process.env.DB_PATH ?? "data/assay.db",
  dailyBudgetUsdc: parseNumericEnv("DAILY_BUDGET_USDC", 5),
  paymentsEnabled: process.env.PAYMENTS_ENABLED === "true",
  probeWalletKey: process.env.PROBE_WALLET_KEY ?? "",
  receiveWalletAddress: process.env.RECEIVE_WALLET_ADDRESS ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  port: parseNumericEnv("PORT", 3402),
  // Bind localhost-only by default: Phase L runs on a home PC and the dashboard exposes
  // control endpoints. Phase H sets HOST=0.0.0.0 deliberately on the VPS.
  host: process.env.HOST ?? "127.0.0.1",
  // Requests/minute per client IP across public read endpoints. 0 disables (not recommended
  // on public deployments). Generous default — the dashboard polls ~16 req/min.
  rateLimitRpm: parseNumericEnv("RATE_LIMIT_RPM", 120),
  // Shared secret for POST /api/control/*. The localhost default "1" is fine on a home PC
  // (the header requirement only needs to defeat CSRF there); public deployments MUST set a
  // real secret. verify-env warns when HOST is public and this is still "1".
  controlToken: process.env.CONTROL_TOKEN ?? "1",
  // Set true only behind a reverse proxy (Caddy/nginx) so rate limiting keys on the real
  // client IP from X-Forwarded-For instead of the proxy's address.
  trustProxy: process.env.TRUST_PROXY === "true",
  // x402 facilitator for the SELLING side (verifies/settles payments to /score).
  // The default is the official free facilitator — TESTNET ONLY (no eip155:8453 kinds).
  // Base mainnet settlement requires the CDP facilitator + CDP API key at the revenue flip.
  facilitatorUrl: process.env.FACILITATOR_URL ?? "https://x402.org/facilitator",
  // When both are set, the CDP facilitator (Base mainnet) is used instead of facilitatorUrl.
  cdpApiKeyId: process.env.CDP_API_KEY_ID ?? "",
  cdpApiKeySecret: process.env.CDP_API_KEY_SECRET ?? "",
};
