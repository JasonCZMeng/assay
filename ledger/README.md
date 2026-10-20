# Wallet Ledger

Local accounting + audit trail for your own EVM wallets. Each wallet belongs to one
**entity** (your corporation, yourself); the ledger flags any flow that crosses between
them, and every off-ramp is traced back FIFO to the inflows that funded it, so you can show
corporate and personal funds were never commingled.

Runs on `127.0.0.1` only. Data lives in `data/ledger.db` (SQLite, gitignored). Outbound calls
are explorer lookups (Blockscout, or Etherscan v2 with a key) and DefiLlama price lookups.

## Run

```bash
cd ledger
npm ci
npm run demo     # optional: sample data at http://localhost:4100 (data/demo.db)
npm start        # your real ledger at http://localhost:4100
```

Optional `.env` (see `.env.example`): `ETHERSCAN_API_KEY`, `LEDGER_PORT`, `LEDGER_DB`.

## Workflow

1. **Setup** — add entities (e.g. "Acme Corp" corporate, "Personal"), then wallets with
   the chains they use (Ethereum, Base, Optimism, Arbitrum, Polygon). **Sync**.
2. **Labels** — label your exchange deposit addresses: tick *Off-ramp* and set *Controlled
   by* to the entity whose account it is. Label vendors/customers; a *Group* clusters them
   into one bubble on the flow map. Hide spam tokens.
3. **Ledger** — tag every entry's category. Any transfer between entities must be tagged
   with an intercompany category (`owner-distribution`, `owner-contribution`,
   `intercompany-loan`, `loan-repayment`, `reimbursement`) — add the memo (board consent,
   invoice #). Filter by the *Cross-entity · untagged* flag to find what's left.
4. **Off-ramps** — every off-ramp shows ✓ Clean or what's wrong:
   - *entity mismatch* — corporate wallet → personal exchange (or vice versa)
   - *untagged cross-entity* — funds hopped between entities without a tagged transfer
   - *unknown origin* — spent more than tracked inflows (add the missing wallet / chain)
   - *unlinked off-ramp* — exchange address not assigned to an entity
5. **Export** — ledger CSV (filter by entity first for per-entity books) and the off-ramp
   audit-trail CSV (one row per off-ramp × funding source, with origin tx and full path).

## How tracing works

Transfers are replayed in time order. Each owned wallet keeps a FIFO queue of lots per
asset; each lot remembers its origin (the external inflow) and every own-wallet hop since.
Outflows consume lots oldest-first; own→own moves carry lots along; a swap (send to and
receive from outsiders in one tx) re-issues the received asset with the origins of what was
sold, weighted by USD; gas burns lots.

## Limits

- L2 fees exclude the L1 data fee (explorers don't report it in `txlist`).
- Bridges count as external out/in — provenance doesn't follow funds across chains.
- No cost basis / capital gains (the FIFO engine is the base for adding it).

## Develop

```bash
npm test && npm run typecheck
```
