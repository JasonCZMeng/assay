import {
  formatUnits, isDocumented, ledgerRows, partyOf, swapKeys, tokenOf, usdOf,
  type Ctx, type LedgerRow, type Party,
} from "./accounting.js";
import type { Transfer } from "./db.js";

/** Where a lot of funds first entered your books. */
export interface Origin {
  kind: "external" | "unknown";   // unknown = outflow exceeded tracked inflows (history gap)
  transferId: string | null;
  ts: number;
  from: string | null;            // external sender
  wallet: string;                 // own wallet that received it
  entityId: number;
}

export interface Hop {
  kind: "transfer" | "swap";
  transferId: string;
  ts: number;
  from: string;
  to: string;
  entityFrom: number;
  entityTo: number;
  documented: boolean;            // tagged with an intercompany category
  fromAsset?: string;             // swaps: asset given up
}

export interface Lot { asset: string; amount: bigint; origin: Origin; path: Hop[] }

const assetOf = (t: Transfer) => `${t.chainId}:${t.contract}`;

/**
 * Replay every transfer chronologically with a FIFO lot queue per (own wallet, asset).
 * Returns, for every outflow from an own wallet, the lots it consumed — i.e. exactly
 * which inflows funded it and the own-wallet path they took.
 */
export function trace(ctx: Ctx): Map<string, Lot[]> {
  const queues = new Map<string, Lot[]>();
  const consumed = new Map<string, Lot[]>();
  const swaps = swapKeys(ctx);
  const entityOf = (a: string) => ctx.wallets.get(a)!.entityId;

  const take = (wallet: string, t: Transfer): Lot[] => {
    const asset = assetOf(t);
    const q = queues.get(`${wallet}|${asset}`) ?? [];
    queues.set(`${wallet}|${asset}`, q);
    let need = BigInt(t.amount);
    const out: Lot[] = [];
    while (need > 0n && q.length) {
      const lot = q[0];
      if (lot.amount <= need) { out.push(lot); need -= lot.amount; q.shift(); }
      else { out.push({ ...lot, amount: need }); lot.amount -= need; need = 0n; }
    }
    if (need > 0n) {
      out.push({ asset, amount: need, path: [], origin: { kind: "unknown", transferId: null, ts: t.ts, from: null, wallet, entityId: entityOf(wallet) } });
    }
    return out;
  };
  const put = (wallet: string, lot: Lot) => {
    const k = `${wallet}|${lot.asset}`;
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k)!.push(lot);
  };

  // group by tx so swaps see their outs before their ins
  const txs: Transfer[][] = [];
  let cur: Transfer[] = [];
  for (const t of ctx.transfers) {
    if (cur.length && (cur[0].txHash !== t.txHash || cur[0].chainId !== t.chainId)) { txs.push(cur); cur = []; }
    cur.push(t);
  }
  if (cur.length) txs.push(cur);

  for (const tx of txs) {
    const swapPool = new Map<string, { lot: Lot; weight: number }[]>();
    for (const t of tx) {
      if (!ctx.wallets.has(t.from)) continue;
      const pieces = take(t.from, t);
      if (t.kind === "fee") continue;
      consumed.set(t.id, pieces);
      if (t.to && !ctx.wallets.has(t.to) && swaps.has(`${t.chainId}:${t.txHash}|${t.from}`)) {
        const outUsd = usdOf(ctx, t) ?? 1;
        const total = Number(BigInt(t.amount));
        const pool = swapPool.get(t.from) ?? [];
        for (const p of pieces) pool.push({ lot: p, weight: (Number(p.amount) / total) * outUsd });
        swapPool.set(t.from, pool);
      }
    }
    for (const t of tx) {
      if (!t.to || !ctx.wallets.has(t.to) || t.kind === "fee") continue;
      const asset = assetOf(t);
      if (ctx.wallets.has(t.from)) {
        for (const p of consumed.get(t.id) ?? []) {
          put(t.to, { asset, amount: p.amount, origin: p.origin, path: [...p.path, {
            kind: "transfer", transferId: t.id, ts: t.ts, from: t.from, to: t.to,
            entityFrom: entityOf(t.from), entityTo: entityOf(t.to), documented: isDocumented(ctx, t.id),
          }] });
        }
        continue;
      }
      const pool = swapPool.get(t.to);
      if (pool?.length) {
        for (const [p, amount] of splitByWeight(BigInt(t.amount), pool)) {
          if (amount === 0n) continue;
          put(t.to, { asset, amount, origin: p.origin, path: [...p.path, {
            kind: "swap", transferId: t.id, ts: t.ts, from: t.to, to: t.to,
            entityFrom: entityOf(t.to), entityTo: entityOf(t.to), documented: true, fromAsset: p.asset,
          }] });
        }
        continue;
      }
      put(t.to, { asset, amount: BigInt(t.amount), path: [],
        origin: { kind: "external", transferId: t.id, ts: t.ts, from: t.from, wallet: t.to, entityId: entityOf(t.to) } });
    }
  }
  return consumed;
}

function splitByWeight(amount: bigint, pool: { lot: Lot; weight: number }[]): [Lot, bigint][] {
  const W = pool.reduce((s, p) => s + p.weight, 0) || 1;
  const ws = pool.map((p) => BigInt(Math.max(0, Math.round((p.weight / W) * 1e12))));
  const total = ws.reduce((s, w) => s + w, 0n) || 1n;
  let left = amount;
  return pool.map((p, i) => {
    const a = i === pool.length - 1 ? left : (amount * ws[i]) / total;
    left -= a;
    return [p.lot, a];
  });
}

// ---------- off-ramp audit trails ----------

export interface TrailSource {
  amount: string;
  usd: number | null;
  origin: Origin & { fromParty: Party | null; walletLabel: string; originTxHash: string | null };
  path: (Hop & { fromLabel: string; toLabel: string; txHash: string })[];
}

export interface OfframpTrail {
  row: LedgerRow;
  offramp: Party;
  status: "clean" | "issues";
  issues: string[];   // entity-mismatch | undocumented-cross-entity | unknown-origin | unlinked-offramp
  notes: string[];    // documented-cross-entity
  sources: TrailSource[];
}

const ISSUE_TEXT: Record<string, string> = {
  "entity-mismatch": "Off-ramp account belongs to a different entity than the sending wallet",
  "undocumented-cross-entity": "Funds crossed between entities through an untagged transfer",
  "unknown-origin": "Part of the amount has no tracked source (history gap or unsynced wallet)",
  "unlinked-offramp": "Off-ramp account is not assigned to an entity",
};
export const issueText = (k: string) => ISSUE_TEXT[k] ?? k;

export function offrampTrails(ctx: Ctx): OfframpTrail[] {
  const lots = trace(ctx);
  const byId = new Map(ctx.transfers.map((t) => [t.id, t]));
  const label = (a: string) => partyOf(ctx, a)!.label;
  const trails: OfframpTrail[] = [];
  for (const row of ledgerRows(ctx)) {
    if (row.direction !== "out" || !row.counterparty?.offramp || row.counterparty.own) continue;
    const t = byId.get(row.transferId)!;
    const dec = tokenOf(ctx, t).decimals;
    const pieces = lots.get(row.transferId) ?? [];
    const issues = new Set<string>(), notes = new Set<string>();
    const off = row.counterparty;
    if (off.entityId === null) issues.add("unlinked-offramp");
    else if (off.entityId !== row.entityId) issues.add("entity-mismatch");
    const sources: TrailSource[] = pieces.map((p) => {
      if (p.origin.kind === "unknown") issues.add("unknown-origin");
      for (const h of p.path) {
        if (h.entityFrom === h.entityTo) continue;
        (h.documented ? notes : issues).add(h.documented ? "documented-cross-entity" : "undocumented-cross-entity");
      }
      const originTx = p.origin.transferId ? byId.get(p.origin.transferId) : undefined;
      return {
        amount: formatUnits(p.amount, dec),
        usd: usdOf(ctx, t, p.amount),
        origin: {
          ...p.origin,
          fromParty: partyOf(ctx, p.origin.from),
          walletLabel: label(p.origin.wallet),
          originTxHash: originTx?.txHash ?? null,
        },
        path: p.path.map((h) => ({ ...h, fromLabel: label(h.from), toLabel: label(h.to), txHash: byId.get(h.transferId)?.txHash ?? "" })),
      };
    });
    trails.push({ row, offramp: off, status: issues.size ? "issues" : "clean", issues: [...issues], notes: [...notes], sources });
  }
  return trails.reverse(); // newest first
}
