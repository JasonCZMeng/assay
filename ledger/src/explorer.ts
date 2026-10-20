import { chainById } from "./chains.js";
import type { Transfer } from "./db.js";

export type Fetch = typeof fetch;
export type Action = "txlist" | "txlistinternal" | "tokentx";
export const ACTIONS: Action[] = ["txlist", "txlistinternal", "tokentx"];

export interface ExplorerOpts {
  etherscanKey?: string;
  fetch?: Fetch;
  pageSize?: number;
  delayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function baseUrl(chainId: number, opts: ExplorerOpts): URL {
  if (opts.etherscanKey) {
    const u = new URL("https://api.etherscan.io/v2/api");
    u.searchParams.set("chainid", String(chainId));
    u.searchParams.set("apikey", opts.etherscanKey);
    return u;
  }
  return new URL(chainById(chainId).blockscout);
}

async function call(url: URL, opts: ExplorerOpts): Promise<any[]> {
  const f = opts.fetch ?? fetch;
  for (let attempt = 0; ; attempt++) {
    const res = await f(url);
    if (res.status === 429 && attempt < 5) { await sleep(1000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`explorer HTTP ${res.status}`);
    const json = (await res.json()) as { status: string; message: string; result: unknown };
    if (Array.isArray(json.result)) return json.result;
    const detail = String(json.result ?? json.message);
    if (/no (transactions|records) found/i.test(json.message) || /no (transactions|records) found/i.test(detail)) return [];
    if (/rate limit/i.test(detail) && attempt < 5) { await sleep(1000 * (attempt + 1)); continue; }
    throw new Error(`explorer error: ${json.message}: ${detail}`);
  }
}

/**
 * Fetch every row for (address, action) from startBlock on, ascending.
 * Paginates by advancing startblock so we never hit the page*offset cap; the boundary
 * block is always re-fetched whole so per-block rows are never split across pages.
 */
export async function fetchRows(chainId: number, action: Action, address: string, startBlock: number, opts: ExplorerOpts = {}): Promise<any[]> {
  const pageSize = opts.pageSize ?? 1000;
  const out: any[] = [];
  let start = startBlock;
  let page = 1;
  let carry: any[] = [];   // rows of a single oversized block, collected across pages
  for (;;) {
    const u = baseUrl(chainId, opts);
    for (const [k, v] of Object.entries({
      module: "account", action, address, startblock: String(start), endblock: "999999999",
      page: String(page), offset: String(pageSize), sort: "asc",
    })) u.searchParams.set(k, v);
    const rows = await call(u, opts);
    if (opts.delayMs !== 0) await sleep(opts.delayMs ?? 250);
    if (rows.length < pageSize) { out.push(...carry, ...rows); return out; }
    const first = Number(rows[0].blockNumber);
    const last = Number(rows[rows.length - 1].blockNumber);
    if (first === last) { carry.push(...rows); page++; continue; } // one block bigger than a page
    if (carry.length) {
      // finish the oversized block, then resume after it
      out.push(...carry, ...rows.filter((r) => Number(r.blockNumber) === first));
      carry = [];
      start = first + 1;
      page = 1;
      continue;
    }
    out.push(...rows.filter((r) => Number(r.blockNumber) < last));
    start = last;
    page = 1;
  }
}

const lc = (s: string | undefined | null) => (s ?? "").toLowerCase();

export interface TokenMeta { chainId: number; contract: string; symbol: string; name: string | null; decimals: number }

/**
 * Explorer rows → transfers. Ids are content-derived (not logIndex/traceId, which
 * providers report inconsistently) so the same movement dedupes across wallets & providers.
 */
export function normalize(chainId: number, action: Action, wallet: string, rows: any[]): { transfers: Transfer[]; tokens: TokenMeta[] } {
  const transfers: Transfer[] = [];
  const tokens = new Map<string, TokenMeta>();
  const occ = new Map<string, number>();
  const nextOcc = (k: string) => { const n = occ.get(k) ?? 0; occ.set(k, n + 1); return n; };
  wallet = lc(wallet);

  rows.forEach((r, i) => {
    const hash = lc(r.hash);
    const base = { chainId, txHash: hash, block: Number(r.blockNumber), ts: Number(r.timeStamp) };
    const failed = r.isError === "1";
    if (action === "txlist") {
      const from = lc(r.from);
      const to = lc(r.to) || lc(r.contractAddress);
      if (!failed && r.value && r.value !== "0") {
        transfers.push({ ...base, id: `${chainId}:${hash}:native:0`, seq: 1, kind: "native", from, to, contract: "native", amount: String(r.value) });
      }
      if (from === wallet && r.gasUsed && r.gasPrice) {
        const fee = BigInt(r.gasUsed) * BigInt(r.gasPrice);
        if (fee > 0n) transfers.push({ ...base, id: `${chainId}:${hash}:fee:0`, seq: 0, kind: "fee", from, to: null, contract: "native", amount: fee.toString() });
      }
    } else if (action === "txlistinternal") {
      if (failed || !r.value || r.value === "0") return;
      const from = lc(r.from);
      const to = lc(r.to) || lc(r.contractAddress);
      const key = `${hash}:${from}:${to}:${r.value}`;
      transfers.push({ ...base, id: `${chainId}:${hash}:internal:${from}:${to}:${r.value}:${nextOcc(key)}`, seq: 100 + i, kind: "internal", from, to, contract: "native", amount: String(r.value) });
    } else {
      if (!r.value || r.value === "0") return; // zero-value transfers are address-poisoning noise
      const contract = lc(r.contractAddress);
      const from = lc(r.from);
      const to = lc(r.to);
      const key = `${hash}:${contract}:${from}:${to}:${r.value}`;
      const seq = r.logIndex !== undefined && r.logIndex !== "" ? 1000 + Number(r.logIndex) : 1000 + i;
      transfers.push({ ...base, id: `${chainId}:${hash}:erc20:${contract}:${from}:${to}:${r.value}:${nextOcc(key)}`, seq, kind: "erc20", from, to, contract, amount: String(r.value) });
      if (!tokens.has(contract)) {
        tokens.set(contract, { chainId, contract, symbol: String(r.tokenSymbol || "?").slice(0, 32), name: r.tokenName ? String(r.tokenName).slice(0, 80) : null, decimals: Number(r.tokenDecimal) || 0 });
      }
    }
  });
  return { transfers, tokens: [...tokens.values()] };
}
