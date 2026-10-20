import { beforeEach, describe, expect, it } from "vitest";
import { flowGraph, formatUnits, ledgerRows, loadCtx } from "../src/accounting.js";
import { ledgerCsv, offrampCsv, toCsv } from "../src/csv.js";
import {
  addEntity, ensureToken, hourOf, insertTransfers, openDb, savePrices, setAnnotation, upsertCounterparty, upsertWallet,
  type DB, type Transfer,
} from "../src/db.js";
import { offrampTrails } from "../src/provenance.js";

const a = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const C1 = a(1), C2 = a(2), P1 = a(3);
const CLIENT = a(10), CB_CORP = a(11), KR_PERS = a(12), DEX = a(13);
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const usdc = (n: number) => String(n * 1_000_000);
const eth = (n: number) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString();

let db: DB;
let corp: number, pers: number;
let seq = 0;
function tx(hash: string, ts: number, moves: [string, string, string, "usdc" | "eth"][]): void {
  const rows: Transfer[] = moves.map(([from, to, amount, asset], i) => ({
    id: `8453:${hash}:${asset === "eth" ? "native" : "erc20"}:${i}`, chainId: 8453, txHash: hash, block: ts, ts, seq: seq++,
    kind: asset === "eth" ? "native" : "erc20", from, to, contract: asset === "eth" ? "native" : USDC, amount,
  }));
  insertTransfers(db, rows);
}
const id = (hash: string, i = 0, asset = "erc20") => `8453:${hash}:${asset}:${i}`;

beforeEach(() => {
  db = openDb(":memory:");
  corp = addEntity(db, "Acme Corp", "corporate");
  pers = addEntity(db, "Personal", "personal");
  upsertWallet(db, { address: C1, label: "Corp Treasury", entityId: corp, chains: [8453] });
  upsertWallet(db, { address: C2, label: "Corp Ops", entityId: corp, chains: [8453] });
  upsertWallet(db, { address: P1, label: "Personal Hot", entityId: pers, chains: [8453] });
  upsertCounterparty(db, { address: CB_CORP, label: "Coinbase (Acme)", group: "Coinbase", category: "cex", isOfframp: true, entityId: corp, notes: null });
  upsertCounterparty(db, { address: KR_PERS, label: "Kraken (me)", group: "Kraken", category: "cex", isOfframp: true, entityId: pers, notes: null });
  upsertCounterparty(db, { address: DEX, label: "Uniswap", group: null, category: "defi", isOfframp: false, entityId: null, notes: null });
  ensureToken(db, { chainId: 8453, contract: USDC, symbol: "USDC", name: "USD Coin", decimals: 6 });
  ensureToken(db, { chainId: 8453, contract: "native", symbol: "ETH", name: "Ether", decimals: 18 });
  for (let ts = 0; ts < 20 * 3600; ts += 3600) {
    savePrices(db, [{ coin: `base:${USDC}`, hour: hourOf(ts), usd: 1 }, { coin: "coingecko:ethereum", hour: hourOf(ts), usd: 2000 }]);
  }
  tx("0x01", 3600 * 1, [[CLIENT, C1, usdc(1000), "usdc"]]);
  tx("0x02", 3600 * 2, [[C1, C2, usdc(600), "usdc"]]);
  tx("0x03", 3600 * 3, [[C2, CB_CORP, usdc(500), "usdc"]]);
  tx("0x04", 3600 * 4, [[C1, P1, usdc(300), "usdc"]]);
  tx("0x05", 3600 * 5, [[P1, KR_PERS, usdc(300), "usdc"]]);
  tx("0x06", 3600 * 6, [[C2, KR_PERS, usdc(100), "usdc"]]);
});

describe("formatUnits", () => {
  it("formats exact decimals", () => {
    expect(formatUnits("1500000", 6)).toBe("1.5");
    expect(formatUnits("1", 18)).toBe("0.000000000000000001");
    expect(formatUnits("42", 0)).toBe("42");
  });
});

describe("ledger rows", () => {
  it("one row per owned side with auto categories and flags", () => {
    const rows = ledgerRows(loadCtx(db));
    const r = (h: string, d: string) => rows.find((x) => x.txHash === h && x.direction === d)!;
    expect(r("0x01", "in").flags).toContain("uncategorized");
    expect(r("0x02", "out").category).toBe("internal-transfer");
    expect(r("0x02", "in").category).toBe("internal-transfer");
    expect(r("0x03", "out").category).toBe("offramp");
    expect(r("0x03", "out").usd).toBe(500);
    expect(r("0x04", "out").flags).toContain("cross-entity-undocumented");
    expect(r("0x04", "in").flags).toContain("cross-entity-undocumented");
    expect(r("0x06", "out").flags).toContain("cross-entity-undocumented"); // corp wallet → personal Kraken
    setAnnotation(db, id("0x04"), { category: "owner-distribution", memo: "Q3 draw" });
    const after = ledgerRows(loadCtx(db)).find((x) => x.txHash === "0x04" && x.direction === "out")!;
    expect(after.flags).toContain("cross-entity-documented");
    expect(after.memo).toBe("Q3 draw");
  });

  it("flow graph groups counterparties and flags cross-entity edges", () => {
    const g = flowGraph(ledgerRows(loadCtx(db)));
    expect(g.nodes.find((n) => n.id === "g:Coinbase")?.offramp).toBe(true);
    const e = g.edges.find((x) => x.source === `w:${C1}` && x.target === `w:${P1}`)!;
    expect(e.flag).toBe("cross-entity-undocumented");
    expect(g.edges.filter((x) => x.source === `w:${C1}` && x.target === `w:${C2}`)).toHaveLength(1); // not double counted
  });
});

describe("off-ramp trails", () => {
  const trail = (h: string) => offrampTrails(loadCtx(db)).find((t) => t.row.txHash === h)!;

  it("clean: corp income → corp wallets → corp off-ramp", () => {
    const t = trail("0x03");
    expect(t.status).toBe("clean");
    expect(t.sources).toHaveLength(1);
    expect(t.sources[0].origin.kind).toBe("external");
    expect(t.sources[0].origin.from).toBe(CLIENT);
    expect(t.sources[0].path.map((h) => h.fromLabel + ">" + h.toLabel)).toEqual(["Corp Treasury>Corp Ops"]);
  });

  it("undocumented cross-entity hop is an issue; tagging it as a draw makes it clean", () => {
    expect(trail("0x05").issues).toEqual(["undocumented-cross-entity"]);
    setAnnotation(db, id("0x04"), { category: "owner-distribution", memo: null });
    const t = trail("0x05");
    expect(t.status).toBe("clean");
    expect(t.notes).toEqual(["documented-cross-entity"]);
  });

  it("entity mismatch: corp wallet straight to personal exchange", () => {
    expect(trail("0x06").issues).toContain("entity-mismatch");
  });

  it("unknown origin when spending more than tracked inflows", () => {
    tx("0x07", 3600 * 7, [[P1, KR_PERS, usdc(50), "usdc"]]);
    const t = trail("0x07");
    expect(t.issues).toContain("unknown-origin");
    expect(t.sources[0].origin.kind).toBe("unknown");
  });

  it("FIFO splits an off-ramp across multiple sources", () => {
    tx("0x08", 3600 * 8, [[CLIENT, C2, usdc(200), "usdc"]]);
    tx("0x09", 3600 * 9, [[C2, CB_CORP, usdc(150), "usdc"]]); // C2 holds 0 (from 0x02) then 200 (0x08)
    const t = trail("0x09");
    expect(t.sources.map((s) => s.amount)).toEqual(["150"]);
    expect(t.sources[0].origin.transferId).toBe(id("0x08"));
    tx("0x10", 3600 * 10, [[CLIENT, C1, usdc(10), "usdc"]]);
    tx("0x11", 3600 * 11, [[C1, C2, usdc(110), "usdc"]]); // C1 had 100 left from 0x01 + 10 from 0x10
    tx("0x12", 3600 * 12, [[C2, CB_CORP, usdc(160), "usdc"]]); // 50 from 0x08, then 100 + 10 via C1
    const t2 = trail("0x12");
    expect(t2.sources.map((s) => [s.amount, s.origin.transferId])).toEqual([["50", id("0x08")], ["100", id("0x01")], ["10", id("0x10")]]);
    expect(t2.status).toBe("clean");
  });

  it("swaps carry provenance into the received asset", () => {
    tx("0x1f", 3600 * 12, [[CLIENT, C2, usdc(100), "usdc"]]);
    insertTransfers(db, [
      { id: "8453:0x20:erc20:0", chainId: 8453, txHash: "0x20", block: 3600 * 13, ts: 3600 * 13, seq: 1, kind: "erc20", from: C2, to: DEX, contract: USDC, amount: usdc(100) },
      { id: "8453:0x20:internal:0", chainId: 8453, txHash: "0x20", block: 3600 * 13, ts: 3600 * 13, seq: 2, kind: "internal", from: DEX, to: C2, contract: "native", amount: eth(0.05) },
      { id: "8453:0x20:fee:0", chainId: 8453, txHash: "0x20", block: 3600 * 13, ts: 3600 * 13, seq: 0, kind: "fee", from: C2, to: null, contract: "native", amount: "1000" },
    ]);
    tx("0x21", 3600 * 14, [[C2, CB_CORP, eth(0.05), "eth"]]);
    const rows = ledgerRows(loadCtx(db)).filter((r) => r.txHash === "0x20");
    expect(rows.find((r) => r.direction === "out")?.category).toBe("swap");
    expect(rows.find((r) => r.direction === "fee")?.category).toBe("gas");
    const t = trail("0x21");
    expect(t.status).toBe("clean");
    expect(t.sources).toHaveLength(1);
    expect(t.sources[0].path.at(-1)?.kind).toBe("swap");
    expect(t.sources[0].origin.transferId).toBe(id("0x1f"));
  });
});

describe("csv", () => {
  it("escapes quotes, commas and formula injection", () => {
    expect(toCsv(["a", "b"], [['x,"y"', "=SUM(A1)"], [-5, null]])).toBe('a,b\r\n"x,""y""",\'=SUM(A1)\r\n-5,\r\n');
  });

  it("ledger and off-ramp exports have a row per entry/source", () => {
    const ctx = loadCtx(db);
    const ledger = ledgerCsv(ctx, ledgerRows(ctx)).trim().split("\r\n");
    expect(ledger).toHaveLength(1 + 8); // 6 txs, 2 of them own→own (2 rows each)
    const off = offrampCsv(ctx, offrampTrails(ctx)).trim().split("\r\n");
    expect(off).toHaveLength(1 + 3);
    expect(off[0]).toContain("source_tx_hash");
  });
});
