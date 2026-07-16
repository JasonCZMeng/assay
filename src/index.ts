import { serve } from "@hono/node-server"; // npm i @hono/node-server
import cron from "node-cron";
import { createPublicClient, http as viemHttp, erc20Abi } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { openDb } from "./db.js";
import { config } from "./config.js";
import { ingestBazaar } from "./bazaar.js";
import { runProbes, BASE_USDC } from "./prober.js";
import { computeScores } from "./score.js";
import { anchorMissingDigests } from "./digest.js";
import { buildApp } from "./server.js";

const db = openDb();

// Every 6h, not hourly — the full catalog walk is ~260 pages and hourly runs trip CDP's
// rate limit (observed HTTP 429). Catalog freshness is not probing-critical.
cron.schedule("0 */6 * * *", () =>
  ingestBazaar(db).then((r) => console.log(`[ingest] upserted ${r.upserted}`))
    .catch((e) => console.error("[ingest]", e))
);

// Single-flight sweep shared by cron and the dashboard's "probe now" — a manual trigger
// must never overlap a cron run and double-spend.
let sweeping = false;
async function sweep(reason: string) {
  if (sweeping) {
    console.log(`[sweep] already running — skipped (${reason})`);
    return { probed: 0, skipped: "busy" };
  }
  sweeping = true;
  try {
    const r = await runProbes(db).catch((e) => (console.error("[probe]", e), null));
    if (r) console.log(`[probe] (${reason}) probed=${r.probed} skipped=${r.skipped ?? "no"}`);
    try {
      console.log(`[score] scored ${computeScores(db)} services`);
    } catch (e) {
      console.error("[score]", e);
    }
    return r ?? { probed: 0, skipped: "error" };
  } finally {
    sweeping = false;
  }
}

async function probeAndScore() {
  const jitterMs = Math.random() * 3_600_000; // anti-fingerprinting jitter
  await new Promise((r) => setTimeout(r, jitterMs));
  await sweep("cron");
}
for (const c of ["15 6 * * *", "15 13 * * *", "15 21 * * *"]) cron.schedule(c, probeAndScore);

// Digest + OTS-anchor completed days: daily after midnight, and at boot to catch up
// on days missed while the machine slept.
const anchor = () =>
  anchorMissingDigests(db)
    .then((r) => {
      if (r.digested.length || r.anchored.length)
        console.log(`[digest] digested=[${r.digested}] anchored=[${r.anchored}]`);
    })
    .catch((e) => console.error("[digest]", e));
cron.schedule("10 0 * * *", anchor);
setTimeout(anchor, 30_000);

// On-chain wallet snapshot for the dashboard, cached so polling stays off the RPC.
const rpc = createPublicClient({ chain: base, transport: viemHttp("https://mainnet.base.org") });
let walletCache: { address: string; usdc: number; ts: number } | null = null;
async function wallet() {
  if (walletCache && Date.now() - walletCache.ts < 60_000) return walletCache;
  const address = privateKeyToAccount(config.probeWalletKey as `0x${string}`).address;
  const raw = await rpc.readContract({
    address: BASE_USDC as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
  walletCache = { address, usdc: Number(raw) / 1e6, ts: Date.now() };
  return walletCache;
}

const app = buildApp(db, {
  probeNow: () => sweep("manual"),
  ingestNow: () => ingestBazaar(db),
  wallet,
});

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (i) =>
  console.log(
    `[assay] listening on ${config.host}:${i.port} payments=${config.paymentsEnabled} — dashboard: http://${config.host}:${i.port}/dashboard`
  )
);
