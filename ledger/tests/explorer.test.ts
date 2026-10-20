import { describe, expect, it } from "vitest";
import { fetchRows, normalize } from "../src/explorer.js";

const W = "0x00000000000000000000000000000000000000aa";
const X = "0x00000000000000000000000000000000000000bb";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

describe("normalize", () => {
  it("txlist → native transfer + fee for the sender only", () => {
    const { transfers } = normalize(8453, "txlist", W, [
      { hash: "0xA", blockNumber: "10", timeStamp: "100", from: W.toUpperCase(), to: X, value: "5", gasUsed: "21000", gasPrice: "2", isError: "0" },
      { hash: "0xB", blockNumber: "11", timeStamp: "101", from: X, to: W, value: "7", gasUsed: "21000", gasPrice: "2", isError: "0" },
    ]);
    expect(transfers.map((t) => [t.id, t.kind, t.from, t.to, t.amount])).toEqual([
      ["8453:0xa:native:0", "native", W, X, "5"],
      ["8453:0xa:fee:0", "fee", W, null, "42000"],
      ["8453:0xb:native:0", "native", X, W, "7"],
    ]);
  });

  it("failed tx keeps the fee, drops the value", () => {
    const { transfers } = normalize(1, "txlist", W, [
      { hash: "0xc", blockNumber: "1", timeStamp: "1", from: W, to: X, value: "9", gasUsed: "1", gasPrice: "3", isError: "1" },
    ]);
    expect(transfers.map((t) => t.kind)).toEqual(["fee"]);
  });

  it("tokentx skips zero-value poisoning and dedupes identical rows by occurrence", () => {
    const row = { hash: "0xd", blockNumber: "1", timeStamp: "1", from: X, to: W, value: "1000000", contractAddress: USDC, tokenSymbol: "USDC", tokenName: "USD Coin", tokenDecimal: "6" };
    const { transfers, tokens } = normalize(8453, "tokentx", W, [row, { ...row }, { ...row, value: "0" }]);
    expect(transfers).toHaveLength(2);
    expect(new Set(transfers.map((t) => t.id)).size).toBe(2);
    expect(tokens).toEqual([{ chainId: 8453, contract: USDC, symbol: "USDC", name: "USD Coin", decimals: 6 }]);
  });

  it("ids are provider-independent (logIndex ignored)", () => {
    const row = { hash: "0xe", blockNumber: "1", timeStamp: "1", from: X, to: W, value: "1", contractAddress: USDC, tokenSymbol: "USDC", tokenDecimal: "6" };
    const a = normalize(8453, "tokentx", W, [{ ...row, logIndex: "7" }]).transfers[0].id;
    const b = normalize(8453, "tokentx", W, [row]).transfers[0].id;
    expect(a).toBe(b);
  });
});

describe("fetchRows", () => {
  it("paginates by advancing startblock and never splits a block", async () => {
    const all = [1, 2, 2, 3, 3, 3, 4, 5].map((b, i) => ({ blockNumber: String(b), hash: `0x${i}` }));
    const calls: string[] = [];
    const fake = (async (u: URL) => {
      calls.push(`${u.searchParams.get("startblock")}/${u.searchParams.get("page")}`);
      const start = Number(u.searchParams.get("startblock"));
      const page = Number(u.searchParams.get("page"));
      const size = Number(u.searchParams.get("offset"));
      const res = all.filter((r) => Number(r.blockNumber) >= start).slice((page - 1) * size, page * size);
      return new Response(JSON.stringify(res.length ? { status: "1", message: "OK", result: res } : { status: "0", message: "No transactions found", result: [] }));
    }) as unknown as typeof fetch;
    const rows = await fetchRows(1, "txlist", W, 0, { fetch: fake, pageSize: 3, delayMs: 0 });
    expect(rows.map((r) => r.hash)).toEqual(all.map((r) => r.hash));
  });

  it("handles a block larger than one page", async () => {
    const all = [1, 1, 1, 1, 1, 2].map((b, i) => ({ blockNumber: String(b), hash: `0x${i}` }));
    const fake = (async (u: URL) => {
      const start = Number(u.searchParams.get("startblock"));
      const page = Number(u.searchParams.get("page"));
      const size = Number(u.searchParams.get("offset"));
      const res = all.filter((r) => Number(r.blockNumber) >= start).slice((page - 1) * size, page * size);
      return new Response(JSON.stringify({ status: res.length ? "1" : "0", message: res.length ? "OK" : "No transactions found", result: res }));
    }) as unknown as typeof fetch;
    const rows = await fetchRows(1, "txlist", W, 0, { fetch: fake, pageSize: 2, delayMs: 0 });
    expect(rows.map((r) => r.hash)).toEqual(all.map((r) => r.hash));
  });

  it("throws on explorer errors", async () => {
    const fake = (async () => new Response(JSON.stringify({ status: "0", message: "NOTOK", result: "Invalid API Key" }))) as unknown as typeof fetch;
    await expect(fetchRows(1, "txlist", W, 0, { fetch: fake, delayMs: 0 })).rejects.toThrow(/Invalid API Key/);
  });
});
