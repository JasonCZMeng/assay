// Generate a fresh probe wallet and write it to .env — run from the repo root:
//   npx tsx scripts/rotate-probe-wallet.mts
//
// - Creates .env from .env.example if missing (carries over your other values).
// - Replaces PROBE_WALLET_KEY with a newly generated 0x-prefixed key.
// - Prints ONLY the public address (the private key is never displayed).
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const envPath = ".env";
const examplePath = ".env.example";

if (!existsSync(envPath)) {
  if (!existsSync(examplePath)) throw new Error(".env.example not found — run from the repo root");
  copyFileSync(examplePath, envPath);
  console.log("Created .env from .env.example");
}

const key = generatePrivateKey();
const address = privateKeyToAccount(key).address;

let env = readFileSync(envPath, "utf8");
env = /^PROBE_WALLET_KEY=.*$/m.test(env)
  ? env.replace(/^PROBE_WALLET_KEY=.*$/m, `PROBE_WALLET_KEY=${key}`)
  : env + `\nPROBE_WALLET_KEY=${key}\n`;
writeFileSync(envPath, env);

console.log("New probe wallet written to .env (private key not displayed).");
console.log("Fund this address with USDC on Base mainnet (keep <= $50):");
console.log(address);
