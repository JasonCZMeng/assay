# Assay — x402 Quality Oracle

See SUMMARY.md (what/why) and docs/specs/ (design).

## Phase L: run locally (Windows)

1. `cp .env.example .env`, fill in:
   - PROBE_WALLET_KEY: fresh wallet, fund with ≤ $50 USDC on Base; a few
     dollars of Base ETH optional but not normally needed — x402 "exact"
     EVM payments settle via the facilitator using EIP-3009 signatures, so
     the payer typically doesn't spend gas
   - ANTHROPIC_API_KEY (LLM judge)
2. `npm install && npm test`
3. `npm run dev` once; let ingest populate, then curate:
   - `npm run curate -- list`
   - write a template JSON (see docs/templates/example.json), then
     `npm run curate -- add <serviceUrl> template.json`
   - start with 10–20 endpoints; grow toward 200 as templates prove out
4. Keep it running 24/7: `npx pm2 start "npm run dev" --name assay`
   and `npx pm2 save`; or Windows Task Scheduler "At startup" task.
5. Watch spend: `curl localhost:3402/healthz` → `spentToday`.

## Phase H: go public (later)

1. $5–10/mo VPS (Hetzner CAX11 / Railway / Fly).
2. Stop local process; copy repo + `data/assay.db` to VPS; `npm ci`; run under pm2.
3. Domain + Caddy for TLS → reverse proxy :3402.
4. Set `PAYMENTS_ENABLED=true` + `RECEIVE_WALLET_ADDRESS` (separate wallet);
   verify @x402/hono middleware signature; live-test one paid call.
5. List Assay itself in the x402 Bazaar; publish leaderboard URL.
