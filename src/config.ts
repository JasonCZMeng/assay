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
};
