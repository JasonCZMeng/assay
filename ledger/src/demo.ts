// Seeds a throwaway database with a realistic two-entity history so the UI can be explored
// without real wallets. Run: npm run demo  (writes data/demo.db, then serves it)
import { serve } from "@hono/node-server";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addEntity, ensureToken, hourOf, insertTransfers, openDb, savePrices, setAnnotation, upsertCounterparty, upsertWallet,
  type Transfer,
} from "./db.js";
import { createApp } from "./server.js";

const path = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "demo.db");
rmSync(path, { force: true });
for (const ext of ["-wal", "-shm"]) rmSync(path + ext, { force: true });
const db = openDb(path);

const a = (n: number) => "0x" + n.toString(16).padStart(4, "0").repeat(10);
const CT = a(0xc1), CO = a(0xc2), PH = a(0xa1), PC = a(0xa2);
const CLIENT_A = a(0x11), CLIENT_B = a(0x12), VENDOR = a(0x21), CB = a(0x31), KR = a(0x32), UNI = a(0x41), STRANGER = a(0x51), NFT = a(0x52);
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const corp = addEntity(db, "Nominal Labs LLC", "corporate");
const me = addEntity(db, "Personal", "personal");
upsertWallet(db, { address: CT, label: "Corp Treasury", entityId: corp, chains: [8453, 1] });
upsertWallet(db, { address: CO, label: "Corp Ops", entityId: corp, chains: [8453] });
upsertWallet(db, { address: PH, label: "Personal Hot", entityId: me, chains: [8453, 1] });
upsertWallet(db, { address: PC, label: "Personal Cold", entityId: me, chains: [1] });
upsertCounterparty(db, { address: CLIENT_A, label: "Client — Atlas", group: "Customers", category: "customer", isOfframp: false, entityId: null, notes: null });
upsertCounterparty(db, { address: CLIENT_B, label: "Client — Birch", group: "Customers", category: "customer", isOfframp: false, entityId: null, notes: null });
upsertCounterparty(db, { address: VENDOR, label: "Hosting vendor", group: null, category: "vendor", isOfframp: false, entityId: null, notes: null });
upsertCounterparty(db, { address: CB, label: "Coinbase Business deposit", group: "Coinbase", category: "cex", isOfframp: true, entityId: corp, notes: "Corp bank: ****1234" });
upsertCounterparty(db, { address: KR, label: "Kraken deposit (me)", group: "Kraken", category: "cex", isOfframp: true, entityId: me, notes: null });
upsertCounterparty(db, { address: UNI, label: "Uniswap router", group: null, category: "defi", isOfframp: false, entityId: null, notes: null });
ensureToken(db, { chainId: 8453, contract: USDC, symbol: "USDC", name: "USD Coin", decimals: 6 });
ensureToken(db, { chainId: 8453, contract: "native", symbol: "ETH", name: "Ether", decimals: 18 });
ensureToken(db, { chainId: 1, contract: "native", symbol: "ETH", name: "Ether", decimals: 18 });

const day = 86400;
const t0 = Math.floor(Date.UTC(2026, 6, 1) / 1000);
const rows: Transfer[] = [];
let n = 0;
const usdc = (x: number) => String(Math.round(x * 1e6));
const eth = (x: number) => (BigInt(Math.round(x * 1e9)) * 10n ** 9n).toString();
function move(d: number, chainId: number, from: string, to: string, asset: "usdc" | "eth", amount: string, opts: { hash?: string; internal?: boolean; fee?: boolean } = {}) {
  const hash = opts.hash ?? "0x" + (++n).toString(16).padStart(64, "0");
  const ts = t0 + Math.round(d * day);
  const kind = asset === "usdc" ? "erc20" : opts.internal ? "internal" : "native";
  rows.push({ id: `${chainId}:${hash}:${kind}:${rows.length}`, chainId, txHash: hash, block: ts, ts, seq: rows.length, kind, from, to, contract: asset === "usdc" ? USDC : "native", amount });
  if (opts.fee !== false && (asset === "eth" ? !opts.internal : true) && [CT, CO, PH, PC].includes(from)) {
    rows.push({ id: `${chainId}:${hash}:fee:0`, chainId, txHash: hash, block: ts, ts, seq: -1, kind: "fee", from, to: null, contract: "native", amount: eth(0.00002) });
  }
  return hash;
}

move(0, 8453, CLIENT_A, CT, "eth", eth(0.05));            // gas money
move(1, 8453, CLIENT_A, CT, "usdc", usdc(12000));
move(3, 8453, CT, CO, "usdc", usdc(4000));
move(4, 8453, CO, VENDOR, "usdc", usdc(850));
move(6, 8453, CLIENT_B, CT, "usdc", usdc(7500));
move(9, 8453, CT, CB, "usdc", usdc(9000));                  // clean corp off-ramp
const draw = move(12, 8453, CT, PH, "usdc", usdc(3000));    // documented owner draw
setAnnotation(db, rows.find((r) => r.txHash === draw && r.kind === "erc20")!.id, { category: "owner-distribution", memo: "July owner draw — board consent 2026-07-12" });
move(13, 8453, PH, KR, "usdc", usdc(2500));                 // clean personal off-ramp (via tagged draw)
move(15, 8453, CO, PH, "usdc", usdc(400));                  // UNTAGGED corp → personal
move(16, 8453, PH, KR, "usdc", usdc(900));                  // tainted by the untagged hop
move(18, 8453, CO, KR, "usdc", usdc(300));                  // corp wallet straight to personal exchange
const swap = move(20, 8453, CT, UNI, "usdc", usdc(2000));
move(20, 8453, UNI, CT, "eth", eth(0.62), { hash: swap, internal: true });
move(24, 8453, CT, CB, "eth", eth(0.6));                    // off-ramp of swapped ETH
move(26, 8453, STRANGER, PH, "usdc", usdc(25), { fee: false });
move(27, 1, NFT, PC, "eth", eth(1.2));
move(30, 1, PC, PH, "eth", eth(0.5));
move(31, 1, PH, KR, "eth", eth(0.7));                       // part unknown origin (history gap)
insertTransfers(db, rows);

const ethUsd = (ts: number) => 3200 + 150 * Math.sin(ts / (5 * day));
for (let ts = t0 - day; ts < t0 + 40 * day; ts += 3600) {
  savePrices(db, [
    { coin: `base:${USDC}`, hour: hourOf(ts), usd: 1 },
    { coin: "coingecko:ethereum", hour: hourOf(ts), usd: Math.round(ethUsd(ts) * 100) / 100 },
  ]);
}

const port = Number(process.env.LEDGER_PORT ?? 4100);
serve({ fetch: createApp(db).fetch, port, hostname: "127.0.0.1" }, () => console.log(`demo ledger → http://localhost:${port}`));
