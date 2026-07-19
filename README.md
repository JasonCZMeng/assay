# Assay

**The quality oracle for the x402 agent economy** — [x402](https://www.x402.org/) being
the open protocol that lets machines pay for HTTP APIs with stablecoin micropayments.
Assay pays real USDC to probe machine-payable services, verifies what actually comes
back, and sells the resulting quality scores — every rating backed by an on-chain
payment receipt and a Bitcoin-anchored evidence trail.

**Live:** [assay.nominal-labs.com](https://assay.nominal-labs.com) ·
[Leaderboard](https://assay.nominal-labs.com/leaderboard) ·
[Agent guide (SKILL.md)](https://assay.nominal-labs.com/SKILL.md)

## The problem

Agents are starting to buy API responses from other machines over x402 — HTTP 402
payment challenges settled in USDC on [Base](https://base.org) (Coinbase's Ethereum L2),
no accounts, no invoices. Tens of thousands of services already advertise themselves in
discovery catalogs like the Coinbase x402 Bazaar. But an agent holding a wallet has no
way to know which of them actually deliver: whether payment settles, whether the
response matches the advertised schema, whether the data is even true. The trust signals
that exist score *liveness* — uptime, latency, payment telemetry. Nobody pays these
services and verifies what actually comes back. Paying to find out is the only real test
— so that's what Assay does, on a schedule, with its own money, so your agent doesn't
have to.

## How scoring works

Assay probes a curated set of x402 services several times a day, at randomized times,
with real paid requests. Each probe is scored on four independent checks:

| Component | Weight | Question it answers |
|---|---|---|
| Settlement | 40% | Did payment settle and a response come back? (tx hash recorded) |
| Schema | 30% | Does the response match the service's advertised output schema? |
| Ground truth | 20% | Does the data agree with an independent reference source? |
| LLM judge | 10% | Does the response deliver what the service claims to sell? |

Weights renormalize over the components a service has data for. A service's **composite
score (0–100)** is computed over its trailing 30 days of probes and publishes only once it
has **20+ probes spread across days** — no scores from thin evidence. Tiers: **gold** ≥ 85,
**ok** ≥ 60, otherwise **avoid**.

## Why the history can't be quietly rewritten

Scores are only as trustworthy as the evidence behind them, so the probe corpus is
append-only and publicly anchored:

- Every probe row (settlement result, response hash, paid amount, tx hash) becomes a leaf
  in a per-day **Merkle tree**; the root is anchored to **Bitcoin** via
  [OpenTimestamps](https://opentimestamps.org/) (OTS) after a safety lag.
- Daily Merkle roots and their OTS proofs are public at
  [`/api/digests`](https://assay.nominal-labs.com/api/digests).
- Anything that ever touches recorded history — migrations, re-anchoring — is logged in
  the open in [docs/CORPUS-LOG.md](docs/CORPUS-LOG.md).

The accumulating corpus is the point: anyone can copy the code, but nobody can backdate
the evidence — the anchors prove when each day's records existed.

## Using Assay

**HTTP** — the oracle itself is an x402 service at `https://assay.nominal-labs.com`.
Paid endpoints answer with an HTTP 402 payment challenge that any x402 client settles
automatically:

| Endpoint | Price | Returns |
|---|---|---|
| `GET /score/{url-encoded service URL}` | $0.005 USDC (Base) | Composite, component breakdown, trend, probe count |
| `GET /tier/{url-encoded service URL}` | free | `gold` / `ok` / `avoid` / `unrated` verdict |
| `GET /leaderboard` | free | All scored services, ranked |
| `GET /api/digests` | free | Daily Merkle roots + OTS proofs |

**MCP server** ([Model Context Protocol](https://modelcontextprotocol.io) — how AI
assistants call external tools) — [`assay-oracle-mcp`](https://www.npmjs.com/package/assay-oracle-mcp)
on npm and the [official MCP registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.JasonCZMeng/assay).
For Claude Code:

```sh
claude mcp add assay -- npx -y assay-oracle-mcp
```

**Spend guard** — [`assay-x402-guard`](https://www.npmjs.com/package/assay-x402-guard)
wraps your agent's paying fetch and throws *before* money moves to a service rated `avoid`:

```ts
import { wrapFetchWithAssay } from "assay-x402-guard";
// payFetch = your x402-paying fetch (e.g. wrapFetchWithPayment from @x402/fetch)
const safeFetch = wrapFetchWithAssay(payFetch);
```

More background: [SUMMARY.md](SUMMARY.md) (what/why) and
[docs/specs/](docs/specs/) (design).

## Development (any OS)

1. `cp .env.example .env` and fill in (all vars documented in the example):
   - `PROBE_WALLET_KEY`: fresh dedicated wallet, ≤ $50 USDC on Base mainnet (no ETH
     needed — x402 "exact" settles via facilitator using EIP-3009 signatures)
   - `ANTHROPIC_API_KEY`: the LLM judge
2. `npm install && npm test` (no network or wallet needed for the suite)
3. `npx tsx scripts/verify-env.mts` — preflight; fails loudly on misconfiguration
4. `npm run dev` — server on :3402 (localhost-bound by default) plus crons:
   catalog ingest (6h), probe sweeps (every 4h at :15 + jitter), daily digest anchoring
5. Curate services to probe:
   - `npm run curate -- list`
   - write a template JSON (see docs/templates/), then
     `npm run curate -- add <serviceUrl> <template.json>`
6. Ops dashboard: http://127.0.0.1:3402/dashboard (pause/resume, probe-now, retire/restore)

The money path is deliberately paranoid: a hard per-payment cap, a daily budget summed
from actually-settled amounts, and fail-closed guards on unparsable payment requirements
— all unit-tested with injected fakes.

Note that a fresh deployment starts with an empty corpus — the scores are only as good
as the probe history behind them.

## Production deploys

How the reference instance at assay.nominal-labs.com is operated (adapt for your own):
commit to `main`, ship to the VPS as a git bundle, apply with `git reset --hard` +
`systemctl restart assay` (provisioning and update runbook in
[deploy/README.md](deploy/README.md)). The SQLite file at `data/assay.db` is the product
— never recreate it; the VPS keeps daily on-box snapshots via
`/etc/cron.daily/assay-backup`.

Payments: `PAYMENTS_ENABLED=true` + `RECEIVE_WALLET_ADDRESS` + a
[Coinbase Developer Platform (CDP)](https://portal.cdp.coinbase.com/) API key
(`CDP_API_KEY_ID`/`CDP_API_KEY_SECRET` — the server auto-selects the CDP facilitator
for Base mainnet when both are set).

## Layout

- `src/` — the whole system: server + APIs, prober, scoring, digests, ingest, pages
- `mcp/` — `assay-oracle-mcp`: MCP server (`check_service`, `get_score`, `top_services`)
- `middleware/` — `assay-x402-guard`: wrapFetchWithAssay spend-guard for agents
- `tests/` — vitest; money-path logic unit-tested with injected fakes
- `scripts/` — preflight, wallet rotation, smoke tests; `start-assay.*` are legacy
  launchers from an earlier home-PC deployment, superseded by systemd
- `deploy/` — Caddyfile, systemd unit, provisioning runbook
- `docs/` — [CORPUS-LOG.md](docs/CORPUS-LOG.md) (public integrity log), specs, templates

## License

The npm packages ([`mcp/`](mcp/) and [`middleware/`](middleware/)) are MIT-licensed.
The oracle service code is currently source-available without an explicit license grant.
