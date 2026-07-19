// Preflight check for .env — run from the repo root:
//   npx tsx scripts/verify-env.mts
// Prints derived wallet ADDRESS and config summary. Never prints secrets.
import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";

let ok = true;
const fail = (msg: string) => { console.error(`✗ ${msg}`); ok = false; };

const key = process.env.PROBE_WALLET_KEY ?? "";
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
  fail("PROBE_WALLET_KEY is missing or malformed — must be 0x followed by 64 hex chars");
} else {
  try {
    const address = privateKeyToAccount(key as `0x${string}`).address;
    console.log(`✓ PROBE_WALLET_KEY parses — fund this address with USDC on Base mainnet:`);
    console.log(`  ${address}`);
  } catch {
    fail("PROBE_WALLET_KEY has valid format but viem rejected it");
  }
}

const anthropic = process.env.ANTHROPIC_API_KEY ?? "";
if (anthropic.startsWith("sk-ant-") && anthropic.length > 20) {
  console.log("✓ ANTHROPIC_API_KEY present");
} else {
  fail("ANTHROPIC_API_KEY missing or doesn't look like an sk-ant- key");
}

const budget = Number(process.env.DAILY_BUDGET_USDC ?? "5");
console.log(Number.isFinite(budget) && budget > 0
  ? `✓ DAILY_BUDGET_USDC = $${budget}/day`
  : `✗ DAILY_BUDGET_USDC invalid — app would fall back to default $5`);

console.log(`✓ PAYMENTS_ENABLED = ${process.env.PAYMENTS_ENABLED === "true"} (should be false for Phase L)`);
console.log(`✓ PORT = ${process.env.PORT ?? "3402 (default)"}`);

if (process.env.PAYMENTS_ENABLED === "true" && !process.env.RECEIVE_WALLET_ADDRESS) {
  fail("PAYMENTS_ENABLED=true requires RECEIVE_WALLET_ADDRESS");
}
const host = process.env.HOST ?? "127.0.0.1";
// A public deployment is EITHER a non-loopback bind OR loopback behind a reverse proxy
// (TRUST_PROXY=true, the production shape) — keying on HOST alone left the proxy case unchecked.
const publicDeploy =
  (host !== "127.0.0.1" && host !== "localhost") || process.env.TRUST_PROXY === "true";
if (publicDeploy && (process.env.CONTROL_TOKEN ?? "1") === "1") {
  fail(`public deployment (HOST=${host}, TRUST_PROXY=${process.env.TRUST_PROXY ?? "false"}) but CONTROL_TOKEN is the localhost default — set a strong secret`);
}
if (publicDeploy && Number(process.env.RATE_LIMIT_RPM ?? "120") === 0) {
  fail(`public deployment with rate limiting disabled`);
}

process.exit(ok ? 0 : 1);
