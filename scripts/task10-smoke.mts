// Task 10 smoke test — first live paid probe. Run from the repo root:
//   npx tsx scripts/task10-smoke.mts
// Checks on-chain USDC balance, records the probe wallet, runs one probe pass
// over curated templates, then verifies the payment transaction on Base.
// Never prints secrets.
import { createPublicClient, http, formatUnits, erc20Abi } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../src/config.js";
import { openDb } from "../src/db.js";
import { runProbes, BASE_USDC } from "../src/prober.js";

const account = privateKeyToAccount(config.probeWalletKey as `0x${string}`);
const client = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });

// 1. On-chain balance check
const balance = await client.readContract({
  address: BASE_USDC as `0x${string}`,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [account.address],
});
console.log(`Probe wallet ${account.address}`);
console.log(`USDC balance on Base: $${formatUnits(balance, 6)}`);
if (balance === 0n) {
  console.error("✗ Wallet has no USDC on Base mainnet — aborting before any probe.");
  process.exit(1);
}

// 2. Record the wallet (Task 10 ledger item)
const db = openDb();
db.prepare(
  "INSERT OR IGNORE INTO wallets (address, purpose, created_at) VALUES (?, 'probe', ?)"
).run(account.address, Date.now());

const curated = db.prepare("SELECT COUNT(*) c FROM services WHERE status='curated'").get() as any;
console.log(`Curated services to probe: ${curated.c}`);

// 3. Run one probe pass
const result = await runProbes(db);
console.log(`Probed: ${result.probed}, skipped: ${result.skipped ?? "no"}`);

// 4. Report the probe row(s)
const rows = db
  .prepare("SELECT * FROM probes ORDER BY id DESC LIMIT ?")
  .all(result.probed || 1) as any[];
for (const r of rows) {
  console.log("---");
  console.log(`service:     ${r.service_id}`);
  console.log(`http_status: ${r.http_status}  settlement: ${r.ok_settlement}  schema: ${r.ok_schema}`);
  console.log(`gt_dev_pct:  ${r.gt_deviation_pct}  llm: ${r.llm_score}  latency: ${r.latency_ms}ms  cost: $${r.usdc_cost}`);
  console.log(`payment_tx:  ${r.payment_tx ?? "(none)"}`);
  console.log(`error:       ${r.error ?? "(none)"}`);
  console.log(`excerpt:     ${(r.response_excerpt ?? "").slice(0, 200)}`);

  // 5. Verify the settlement tx on-chain
  if (r.payment_tx) {
    try {
      const receipt = await client.getTransactionReceipt({ hash: r.payment_tx });
      console.log(`tx receipt:  status=${receipt.status} block=${receipt.blockNumber}`);
    } catch {
      console.log("tx receipt:  not yet indexed (facilitator may still be settling)");
    }
    console.log(`basescan:    https://basescan.org/tx/${r.payment_tx}`);
  }
}
