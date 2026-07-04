import "dotenv/config";

export const config = {
  dbPath: process.env.DB_PATH ?? "data/assay.db",
  dailyBudgetUsdc: Number(process.env.DAILY_BUDGET_USDC ?? 5),
  paymentsEnabled: process.env.PAYMENTS_ENABLED === "true",
  probeWalletKey: process.env.PROBE_WALLET_KEY ?? "",
  receiveWalletAddress: process.env.RECEIVE_WALLET_ADDRESS ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  port: Number(process.env.PORT ?? 3402),
};
