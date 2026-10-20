# Wallet Ledger — personal/corporate crypto accounting & off-ramp audit trail

**Goal:** Local, single-user tool that keeps a clean accounting trail for a set of owned EVM
wallets, each assigned to exactly one *entity* (e.g. "Acme Corp" vs "Personal"), so funds
off-ramped through the corporation or personally can be proven not to have been commingled.

**Location:** `ledger/` — self-contained package, separate from the Assay runtime.

## Decisions

| Area | Choice | Why |
|---|---|---|
| Chains | EVM: Ethereum, Base, Optimism, Arbitrum, Polygon | One explorer API shape covers all |
| Tx data | Blockscout `/api` (free, no key); Etherscan v2 multichain when `ETHERSCAN_API_KEY` is set | Both speak the Etherscan `module=account` API (`txlist`, `txlistinternal`, `tokentx`) |
| Prices | DefiLlama `coins.llama.fi/prices/historical` — hourly, cached in SQLite | Free, no key, any timestamp, token-by-address |
| Storage | SQLite file `ledger/data/ledger.db` (gitignored) | Single user, zero ops |
| Server | Hono on `127.0.0.1:4100` only | Private data never leaves the machine except explorer/price lookups |
| UI | Vanilla JS + d3-force, served from the package, no build step | "Not super heavy" |

## Data model

- **entities** — books you keep (`corporate` | `personal`). Each owned wallet belongs to one.
- **wallets** — owned addresses + label + entity + chains to sync.
- **counterparties** — labels for external addresses: label, group (bubble-map cluster),
  category, `is_offramp`, and optional `entity_id` = "this external account is *mine* under
  entity X" (e.g. the corporate Coinbase deposit address).
- **tokens** — per-chain token metadata; `hidden` flag for spam (auto-hidden by heuristic, overridable).
- **transfers** — normalized value movements, global (not per wallet), id
  `chain:tx:kind:index` so an own→own transfer is stored once. Kinds: `native`, `internal`,
  `erc20`, `fee`. Amounts are exact integer strings.
- **annotations** — manual category + memo per transfer.
- **prices** — `(coin, hour) → usd` cache.

## Accounting logic

**Ledger rows** = one row per (transfer × owned side). Direction `in` / `out` / `fee`.
Default categories: `gas`, `internal-transfer` (same entity), `offramp`, `swap`; everything
else stays uncategorized until tagged.

Flags:
- `cross-entity` — own wallet ↔ own wallet (or linked account) of a *different* entity.
  Must be documented with an intercompany category (`owner-contribution`,
  `owner-distribution`, `intercompany-loan`, `loan-repayment`, `reimbursement`) else
  it's `cross-entity-undocumented`.
- `uncategorized`, `unpriced`.

**Off-ramp audit trail** — FIFO lot provenance:
1. Replay every transfer chronologically, per tx.
2. Each owned wallet keeps a FIFO queue of lots per asset. A lot remembers its **origin**
   (the external inflow that brought it in, or `unknown` if history is missing) and its
   **path** (every own→own hop and swap since).
3. Outflows consume lots FIFO. Own→own moves lots with a new hop; swaps (out + in to
   external in one tx for the same wallet) re-issue the incoming asset with inherited
   origins, weighted by USD; gas burns lots.
4. For each outflow to an off-ramp counterparty, the consumed lots *are* the trail.

Trail status:
- `clean` — every lot originated in and stayed within the sending entity, and the off-ramp
  account is linked to that entity.
- `entity-mismatch` — off-ramp account belongs to another entity.
- `undocumented-cross-entity` — a lot crossed entities through an untagged hop.
- `documented-cross-entity` (info) — crossed through a tagged intercompany hop.
- `unknown-origin` — outflow exceeded tracked inflows (history gap).
- `unlinked-offramp` — off-ramp account has no entity assigned.

## UI

- **Setup** — entities, wallets, sync.
- **Ledger** — filter (entity, wallet, chain, date, flag), inline category/memo edit, CSV export.
- **Flow map** — bubble map: owned wallets colored by entity, counterparties clustered by
  group, edge width by USD, cross-entity edges highlighted.
- **Off-ramps** — every off-ramp with status, expandable lot trail, CSV export.
- **Labels** — counterparties and token spam toggles.

## Known limits (v1)

- L2 fees exclude the L1 data fee (explorer `txlist` doesn't report it) — understated by cents.
- Bridges are treated as external out/in; provenance doesn't follow funds across chains.
- No cost basis / tax lots (FIFO engine is the foundation if added later).
