import { coinKey } from "./chains.js";
import {
  hourOf, listAnnotations, listCounterparties, listEntities, listTokens, listTransfers, listWallets, priceMap,
  type Annotation, type Counterparty, type DB, type Entity, type Token, type Transfer, type Wallet,
} from "./db.js";

export const INTERCOMPANY = ["owner-contribution", "owner-distribution", "intercompany-loan", "loan-repayment", "reimbursement"];
export const CATEGORIES = [
  "income", "expense", "internal-transfer", ...INTERCOMPANY,
  "swap", "offramp", "onramp", "gas", "bridge", "refund", "other",
];

export interface Ctx {
  transfers: Transfer[];
  entities: Map<number, Entity>;
  wallets: Map<string, Wallet>;
  counterparties: Map<string, Counterparty>;
  tokens: Map<string, Token>;
  annotations: Map<string, Annotation>;
  prices: Map<string, number | null>;
}

export function loadCtx(db: DB): Ctx {
  return {
    transfers: listTransfers(db),
    entities: new Map(listEntities(db).map((e) => [e.id, e])),
    wallets: new Map(listWallets(db).map((w) => [w.address, w])),
    counterparties: new Map(listCounterparties(db).map((c) => [c.address, c])),
    tokens: new Map(listTokens(db).map((t) => [`${t.chainId}:${t.contract}`, t])),
    annotations: listAnnotations(db),
    prices: priceMap(db),
  };
}

export function formatUnits(raw: string | bigint, decimals: number): string {
  let s = BigInt(raw).toString();
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  if (decimals === 0) return (neg ? "-" : "") + s;
  s = s.padStart(decimals + 1, "0");
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return (neg ? "-" : "") + s.slice(0, -decimals) + (frac ? "." + frac : "");
}

export function tokenOf(ctx: Ctx, t: { chainId: number; contract: string }): Token {
  return ctx.tokens.get(`${t.chainId}:${t.contract}`) ??
    { chainId: t.chainId, contract: t.contract, symbol: t.contract === "native" ? "ETH" : "?", name: null, decimals: 18, hidden: false };
}

export function unitPrice(ctx: Ctx, t: Transfer): number | null {
  return ctx.prices.get(`${coinKey(t.chainId, t.contract)}@${hourOf(t.ts)}`) ?? null;
}

export function usdOf(ctx: Ctx, t: Transfer, raw: string | bigint = t.amount): number | null {
  const p = unitPrice(ctx, t);
  return p === null ? null : Number(formatUnits(raw, tokenOf(ctx, t).decimals)) * p;
}

export interface Party {
  address: string;
  label: string;
  own: boolean;
  labeled: boolean;            // own wallet or a saved counterparty
  entityId: number | null;     // owning entity: own wallet's, or a counterparty linked to one of your entities
  offramp: boolean;
  group: string | null;
}

export function partyOf(ctx: Ctx, address: string | null): Party | null {
  if (!address) return null;
  const w = ctx.wallets.get(address);
  if (w) return { address, label: w.label, own: true, labeled: true, entityId: w.entityId, offramp: false, group: null };
  const c = ctx.counterparties.get(address);
  if (c) return { address, label: c.label, own: false, labeled: true, entityId: c.entityId, offramp: c.isOfframp, group: c.group };
  return { address, label: `${address.slice(0, 6)}…${address.slice(-4)}`, own: false, labeled: false, entityId: null, offramp: false, group: null };
}

export const isDocumented = (ctx: Ctx, transferId: string) =>
  INTERCOMPANY.includes(ctx.annotations.get(transferId)?.category ?? "");

/** tx|wallet keys where the wallet both sent to and received from outsiders in one tx — a swap. */
export function swapKeys(ctx: Ctx): Set<string> {
  const out = new Set<string>(), inn = new Set<string>();
  for (const t of ctx.transfers) {
    if (t.kind === "fee" || !t.to) continue;
    const fromOwn = ctx.wallets.has(t.from), toOwn = ctx.wallets.has(t.to);
    const k = (w: string) => `${t.chainId}:${t.txHash}|${w}`;
    if (fromOwn && !toOwn) out.add(k(t.from));
    if (toOwn && !fromOwn) inn.add(k(t.to));
  }
  return new Set([...out].filter((k) => inn.has(k)));
}

export interface LedgerRow {
  transferId: string;
  ts: number;
  chainId: number;
  txHash: string;
  kind: Transfer["kind"];
  direction: "in" | "out" | "fee";
  wallet: string;
  walletLabel: string;
  entityId: number;
  counterparty: Party | null;
  symbol: string;
  contract: string;
  amount: string;
  usdPrice: number | null;
  usd: number | null;
  category: string | null;
  categorySource: "manual" | "auto" | null;
  memo: string | null;
  flags: string[];
}

export function ledgerRows(ctx: Ctx): LedgerRow[] {
  const swaps = swapKeys(ctx);
  const rows: LedgerRow[] = [];
  for (const t of ctx.transfers) {
    const tok = tokenOf(ctx, t);
    const price = unitPrice(ctx, t);
    const amount = formatUnits(t.amount, tok.decimals);
    const usd = price === null ? null : Number(amount) * price;
    const ann = ctx.annotations.get(t.id);
    const sides: ["in" | "out" | "fee", string, string | null][] = [];
    if (ctx.wallets.has(t.from)) sides.push([t.kind === "fee" ? "fee" : "out", t.from, t.to]);
    if (t.to && ctx.wallets.has(t.to)) sides.push(["in", t.to, t.from]);
    for (const [direction, addr, other] of sides) {
      const w = ctx.wallets.get(addr)!;
      const cp = partyOf(ctx, other);
      let auto: string | null = null;
      if (direction === "fee") auto = "gas";
      else if (cp?.own && cp.entityId === w.entityId) auto = "internal-transfer";
      else if (direction === "out" && cp?.offramp) auto = "offramp";
      else if (!cp?.own && swaps.has(`${t.chainId}:${t.txHash}|${addr}`)) auto = "swap";
      const category = ann?.category ?? auto;
      const flags: string[] = [];
      if (cp && cp.entityId !== null && cp.entityId !== w.entityId) {
        flags.push(INTERCOMPANY.includes(category ?? "") ? "cross-entity-documented" : "cross-entity-undocumented");
      }
      if (!category) flags.push("uncategorized");
      if (usd === null) flags.push("unpriced");
      rows.push({
        transferId: t.id, ts: t.ts, chainId: t.chainId, txHash: t.txHash, kind: t.kind, direction,
        wallet: addr, walletLabel: w.label, entityId: w.entityId, counterparty: cp,
        symbol: tok.symbol, contract: t.contract, amount, usdPrice: price, usd,
        category, categorySource: ann?.category ? "manual" : auto ? "auto" : null, memo: ann?.memo ?? null, flags,
      });
    }
  }
  return rows;
}

export interface RowFilter { entityId?: number; wallet?: string; chainId?: number; from?: number; to?: number; flag?: string; q?: string }

export function filterRows(rows: LedgerRow[], f: RowFilter): LedgerRow[] {
  const q = f.q?.toLowerCase();
  return rows.filter((r) =>
    (f.entityId === undefined || r.entityId === f.entityId) &&
    (f.wallet === undefined || r.wallet === f.wallet) &&
    (f.chainId === undefined || r.chainId === f.chainId) &&
    (f.from === undefined || r.ts >= f.from) &&
    (f.to === undefined || r.ts < f.to) &&
    (f.flag === undefined || r.flags.includes(f.flag)) &&
    (!q || r.txHash.includes(q) || r.symbol.toLowerCase().includes(q) ||
      (r.counterparty?.label.toLowerCase().includes(q) ?? false) || (r.counterparty?.address.includes(q) ?? false) ||
      (r.memo?.toLowerCase().includes(q) ?? false)));
}

// ---------- flow map ----------
export interface GraphNode {
  id: string; kind: "wallet" | "group" | "counterparty" | "unknown" | "other";
  label: string; entityId: number | null; offramp: boolean; usdIn: number; usdOut: number; count: number; addresses: string[];
}
export interface GraphEdge { source: string; target: string; usd: number; count: number; symbols: string[]; flag: string | null }

export function flowGraph(rows: LedgerRow[], opts: { minUsd?: number } = {}): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge & { _sym: Set<string> }>();
  const nodeFor = (p: Party): GraphNode => {
    const id = p.own ? `w:${p.address}` : p.group ? `g:${p.group}` : p.labeled ? `c:${p.address}` : `x:${p.address}`;
    let n = nodes.get(id);
    if (!n) {
      const kind = p.own ? "wallet" : p.group ? "group" : id.startsWith("x:") ? "unknown" : "counterparty";
      n = { id, kind, label: p.group ?? p.label, entityId: p.own ? p.entityId : null, offramp: false, usdIn: 0, usdOut: 0, count: 0, addresses: [] };
      nodes.set(id, n);
    }
    if (!n.addresses.includes(p.address)) n.addresses.push(p.address);
    n.offramp ||= p.offramp;
    if (!p.own && p.entityId !== null && n.entityId === null) n.entityId = p.entityId; // linked external account
    return n;
  };
  for (const r of rows) {
    if (r.direction === "fee" || !r.counterparty) continue;
    if (r.direction === "in" && r.counterparty.own) continue; // own→own counted once, on the out side
    const me = nodeFor({ address: r.wallet, label: r.walletLabel, own: true, labeled: true, entityId: r.entityId, offramp: false, group: null });
    const them = nodeFor(r.counterparty);
    const [src, dst] = r.direction === "out" ? [me, them] : [them, me];
    const usd = r.usd ?? 0;
    src.usdOut += usd; dst.usdIn += usd; src.count++; dst.count++;
    const key = `${src.id}>${dst.id}`;
    let e = edges.get(key);
    if (!e) { e = { source: src.id, target: dst.id, usd: 0, count: 0, symbols: [], flag: null, _sym: new Set() }; edges.set(key, e); }
    e.usd += usd; e.count++; e._sym.add(r.symbol);
    const cross = r.flags.find((f) => f.startsWith("cross-entity"));
    if (cross && e.flag !== "cross-entity-undocumented") e.flag = cross;
  }
  // fold small unlabeled addresses into one "Other" bubble to keep the map readable
  const minUsd = opts.minUsd ?? 0;
  if (minUsd > 0) {
    const small = [...nodes.values()].filter((n) => n.kind === "unknown" && n.usdIn + n.usdOut < minUsd);
    if (small.length > 1) {
      const other: GraphNode = { id: "x:other", kind: "other", label: `Other (${small.length} addresses)`, entityId: null, offramp: false, usdIn: 0, usdOut: 0, count: 0, addresses: [] };
      for (const n of small) {
        other.usdIn += n.usdIn; other.usdOut += n.usdOut; other.count += n.count; other.addresses.push(...n.addresses);
        nodes.delete(n.id);
      }
      nodes.set(other.id, other);
      const ids = new Set(small.map((n) => n.id));
      for (const [k, e] of [...edges]) {
        if (!ids.has(e.source) && !ids.has(e.target)) continue;
        edges.delete(k);
        const s = ids.has(e.source) ? other.id : e.source, d = ids.has(e.target) ? other.id : e.target;
        const nk = `${s}>${d}`;
        const m = edges.get(nk);
        if (m) { m.usd += e.usd; m.count += e.count; e._sym.forEach((x) => m._sym.add(x)); }
        else edges.set(nk, { ...e, source: s, target: d });
      }
    }
  }
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()].map(({ _sym, ...e }) => ({ ...e, symbols: [..._sym] })),
  };
}
