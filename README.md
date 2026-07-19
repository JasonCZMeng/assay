# Assay — x402 Quality Oracle

The quality oracle for the x402 agent economy: real paid probes, on-chain receipts,
timestamped history. See SUMMARY.md (what/why) and docs/specs/ (design).

**Production:** https://assay.nominal-labs.com — VPS, systemd behind Caddy;
provisioning + operations runbook in [deploy/README.md](deploy/README.md).

## Development (any OS)

1. `cp .env.example .env` and fill in (all vars documented in the example):
   - `PROBE_WALLET_KEY`: fresh dedicated wallet, ≤ $50 USDC on Base mainnet (no ETH
     needed — x402 "exact" settles via facilitator using EIP-3009 signatures)
   - `ANTHROPIC_API_KEY`: the T3 LLM judge
2. `npm install && npm test` (no network or wallet needed for the suite)
3. `npx tsx scripts/verify-env.mts` — preflight; fails loudly on misconfiguration
4. `npm run dev` — server on :3402 (localhost-bound by default) plus crons:
   catalog ingest (6h), probe sweeps (every 4h at :15 + jitter), daily digest anchoring
5. Curate services to probe:
   - `npm run curate -- list`
   - write a template JSON (see docs/templates/), then
     `npm run curate -- add <serviceUrl> <template.json>`
6. Ops dashboard: http://127.0.0.1:3402/dashboard (pause/resume, probe-now, retire/restore)

## Production deploys

Commit to `main`, ship to the VPS as a git bundle, apply with `git reset --hard` +
`systemctl restart assay` (details in deploy/README.md). The SQLite file at
`data/assay.db` is the product — never recreate it; the VPS keeps daily on-box
snapshots via `/etc/cron.daily/assay-backup`.

Payments: `PAYMENTS_ENABLED=true` + `RECEIVE_WALLET_ADDRESS` + a CDP API key
(`CDP_API_KEY_ID`/`CDP_API_KEY_SECRET` — the server auto-selects the CDP facilitator
for Base mainnet when both are set).

## Layout

- `src/` — the whole system: server + APIs, prober, scoring, digests, ingest, pages
- `mcp/` — Assay MCP server (`check_service`, `get_score`, `top_services`)
- `middleware/` — `assay-x402-guard`: wrapFetchWithAssay spend-guard for agents
- `tests/` — vitest; money-path logic unit-tested with injected fakes
- `scripts/` — preflight, wallet rotation, smoke tests; `start-assay.*` are Phase L
  home-PC legacy, superseded by the systemd deployment
- `deploy/` — Caddyfile, systemd unit, provisioning runbook
