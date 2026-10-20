import type { Ctx, LedgerRow } from "./accounting.js";
import { chainById, txUrl } from "./chains.js";
import { issueText, type OfframpTrail } from "./provenance.js";

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // leading = + - @ would be evaluated as formulas by spreadsheet apps
  const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

const iso = (ts: number) => new Date(ts * 1000).toISOString().replace(".000Z", "Z");
const usd = (n: number | null) => (n === null ? "" : n.toFixed(2));
const entityName = (ctx: Ctx, id: number | null) => (id === null ? "" : ctx.entities.get(id)?.name ?? `#${id}`);

export function ledgerCsv(ctx: Ctx, rows: LedgerRow[]): string {
  return toCsv(
    ["date_utc", "entity", "wallet_label", "wallet", "chain", "direction", "kind", "counterparty_label", "counterparty",
      "counterparty_entity", "asset", "asset_contract", "amount", "usd_price", "usd_value", "category", "category_source",
      "memo", "flags", "tx_hash", "explorer_url", "transfer_id"],
    rows.map((r) => [
      iso(r.ts), entityName(ctx, r.entityId), r.walletLabel, r.wallet, chainById(r.chainId).name, r.direction, r.kind,
      r.counterparty?.label ?? "", r.counterparty?.address ?? "", entityName(ctx, r.counterparty?.entityId ?? null),
      r.symbol, r.contract, r.amount, r.usdPrice ?? "", usd(r.usd), r.category ?? "", r.categorySource ?? "",
      r.memo ?? "", r.flags.join(" "), r.txHash, txUrl(r.chainId, r.txHash), r.transferId,
    ]),
  );
}

/** One line per (off-ramp × funding source), so every dollar off-ramped maps to its origin. */
export function offrampCsv(ctx: Ctx, trails: OfframpTrail[]): string {
  const rows: unknown[][] = [];
  for (const t of trails) {
    const r = t.row;
    for (const s of t.sources) {
      rows.push([
        iso(r.ts), entityName(ctx, r.entityId), r.walletLabel, r.wallet, chainById(r.chainId).name,
        t.offramp.label, t.offramp.address, entityName(ctx, t.offramp.entityId), r.symbol, r.amount, usd(r.usd),
        t.status, t.issues.map(issueText).join("; "), t.notes.join(" "),
        s.amount, usd(s.usd), s.origin.kind,
        s.origin.kind === "external" ? iso(s.origin.ts) : "", s.origin.fromParty?.label ?? "", s.origin.from ?? "",
        s.origin.walletLabel, entityName(ctx, s.origin.entityId), s.origin.originTxHash ?? "",
        s.path.map((h) => `${h.kind === "swap" ? "swap@" + h.fromLabel : h.fromLabel + "→" + h.toLabel}${h.documented ? "" : h.entityFrom !== h.entityTo ? "(UNDOCUMENTED)" : ""}`).join(" | "),
        r.txHash, txUrl(r.chainId, r.txHash),
      ]);
    }
  }
  return toCsv(
    ["offramp_date_utc", "entity", "wallet_label", "wallet", "chain", "offramp_label", "offramp_address", "offramp_entity",
      "asset", "offramp_amount", "offramp_usd", "status", "issues", "notes",
      "source_amount", "source_usd", "source_kind", "source_date_utc", "source_label", "source_address",
      "source_received_by", "source_entity", "source_tx_hash", "path", "offramp_tx_hash", "explorer_url"],
    rows,
  );
}
