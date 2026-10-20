import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { syncAll } from "../src/sync.js";

const W = "0x00000000000000000000000000000000000000aa";
const X = "0x00000000000000000000000000000000000000bb";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const H = { host: "localhost:4100", "content-type": "application/json" };

function setup() {
  const db = openDb(":memory:");
  const app = createApp(db);
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { ...H, ...(init.headers as Record<string, string>) } });
  return { db, app, req };
}

describe("server", () => {
  it("rejects foreign Host headers and non-JSON writes", async () => {
    const { app } = setup();
    expect((await app.request("/api/state", { headers: { host: "evil.example" } })).status).toBe(403);
    expect((await app.request("/api/entities", { method: "POST", headers: { host: "localhost", "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
    expect((await app.request("/api/entities/1", { method: "DELETE", headers: { host: "localhost" } })).status).toBe(403);
  });

  it("serves the UI and d3", async () => {
    const { req } = setup();
    expect((await req("/")).status).toBe(200);
    expect((await req("/d3.min.js")).status).toBe(200);
  });

  it("entity → wallet → counterparty round trip with validation", async () => {
    const { req } = setup();
    const { id } = await (await req("/api/entities", { method: "POST", body: JSON.stringify({ name: "Acme", kind: "corporate" }) })).json() as { id: number };
    expect((await req(`/api/wallets/${W}`, { method: "PUT", body: JSON.stringify({ label: "T", entityId: id, chains: [999] }) })).status).toBe(400);
    expect((await req(`/api/wallets/0xnope`, { method: "PUT", body: JSON.stringify({ label: "T", entityId: id, chains: [1] }) })).status).toBe(400);
    expect((await req(`/api/wallets/${W.toUpperCase().replace("0X", "0x")}`, { method: "PUT", body: JSON.stringify({ label: "T", entityId: id, chains: [8453] }) })).status).toBe(200);
    expect((await req(`/api/counterparties/${W}`, { method: "PUT", body: JSON.stringify({ label: "x", group: null, category: "cex", isOfframp: true, entityId: null, notes: null }) })).status).toBe(400);
    expect((await req(`/api/counterparties/${X}`, { method: "PUT", body: JSON.stringify({ label: "CB", group: "Coinbase", category: "cex", isOfframp: true, entityId: id, notes: null }) })).status).toBe(200);
    const state = await (await req("/api/state")).json() as any;
    expect(state.wallets[0].address).toBe(W);
    expect(state.counterparties[0].isOfframp).toBe(true);
    expect((await req(`/api/entities/${id}`, { method: "DELETE", headers: { "x-ledger": "1" } })).status).toBe(400); // has wallets
  });

  it("sync pulls explorer rows, prices them, and the ledger/CSV reflect it", async () => {
    const { db, req } = setup();
    const { id } = await (await req("/api/entities", { method: "POST", body: JSON.stringify({ name: "Acme", kind: "corporate" }) })).json() as { id: number };
    await req(`/api/wallets/${W}`, { method: "PUT", body: JSON.stringify({ label: "Treasury", entityId: id, chains: [8453] }) });
    await req(`/api/counterparties/${X}`, { method: "PUT", body: JSON.stringify({ label: "Coinbase", group: null, category: "cex", isOfframp: true, entityId: id, notes: null }) });

    const calls: string[] = [];
    const fake = (async (input: URL | string) => {
      const u = new URL(String(input));
      calls.push(u.hostname);
      if (u.hostname === "coins.llama.fi") {
        return new Response(JSON.stringify({ coins: { [`base:${USDC}`]: { price: 1 }, "coingecko:ethereum": { price: 3000 } } }));
      }
      const action = u.searchParams.get("action");
      const start = Number(u.searchParams.get("startblock"));
      const result = start > 20 ? [] : action === "tokentx" ? [
        { hash: "0x1", blockNumber: "10", timeStamp: "3600", from: "0x00000000000000000000000000000000000000cc", to: W, value: "2500000", contractAddress: USDC, tokenSymbol: "USDC", tokenName: "USD Coin", tokenDecimal: "6" },
        { hash: "0x2", blockNumber: "20", timeStamp: "7200", from: W, to: X, value: "2000000", contractAddress: USDC, tokenSymbol: "USDC", tokenName: "USD Coin", tokenDecimal: "6" },
      ] : action === "txlist" ? [
        { hash: "0x2", blockNumber: "20", timeStamp: "7200", from: W, to: USDC, value: "0", gasUsed: "50000", gasPrice: "1000000000", isError: "0" },
      ] : [];
      return new Response(JSON.stringify(result.length ? { status: "1", message: "OK", result } : { status: "0", message: "No transactions found", result: [] }));
    }) as unknown as typeof fetch;

    await syncAll(db, { fetch: fake, delayMs: 0 });
    const ledger = await (await req("/api/ledger")).json() as any;
    expect(ledger.rows.map((r: any) => [r.direction, r.amount, r.usd])).toEqual([
      ["out", "2", 2],
      ["fee", "0.00005", 0.15],
      ["in", "2.5", 2.5],
    ]);
    const off = await (await req("/api/offramps")).json() as any;
    expect(off.trails).toHaveLength(1);
    expect(off.trails[0].status).toBe("clean");
    const csv = await (await req("/api/ledger.csv?entity=" + id)).text();
    expect(csv.split("\r\n")[0]).toMatch(/^date_utc,entity,/);

    // incremental: second sync starts after the stored cursor and adds nothing
    calls.length = 0;
    await syncAll(db, { fetch: fake, delayMs: 0 });
    expect((await (await req("/api/ledger")).json() as any).rows).toHaveLength(3);
    expect(calls.filter((h) => h === "coins.llama.fi")).toHaveLength(0); // prices cached
  });
});
