# Assay — Design Document

Date: 2026-07-04
Status: approved direction; incorporates self-review revisions

## Problem

AI agents paying x402 APIs have no way to know whether a service returns
*correct, useful content* for the money. All existing trust products
(Coinbase Bazaar native scoring, Agentic Resource Radar, x402 Trust Oracle,
x402scout) measure liveness/latency/config/payment-telemetry only — verified
by adversarial research, July 2026. The Bazaar discovery layer is gameable
(71.8% agent-selection capture via metadata manipulation, arXiv 2605.11781).

## Product

A quality oracle: probes x402 endpoints as a paying customer, evaluates
response content, sells per-service quality scores via its own x402-paid API,
and (post-MVP) publishes attestations to the ERC-8004 reputation registry.

## Architecture

**One Node/TypeScript process.** node-cron for scheduling, Hono for HTTP,
SQLite (better-sqlite3) for storage, viem + @x402/fetch for payments.
Runs identically on a Windows home PC (Phase L) and a small VPS (Phase H).
No external services beyond RPC endpoints and reference-data APIs.

```
ingest (hourly cron)
  Bazaar GET /platform/v2/x402/discovery/resources  (free, no auth)
  → upsert services table; flag candidates for curation
      ▼
curate (manual, CLI-assisted)
  human approves service + writes probe_template (method, url, body, params,
  expected response schema, evaluation tier, reference source if any)
      ▼
probe (cron, 2–4×/day per curated service, jittered timing)
  wrapFetchWithPayment(fetch, viem account)  → pay & call
  → evaluate (tiered, cheapest first):
      T0 settlement:  paid-but-denied / HTTP failure after payment
      T1 schema:      response validates against probe_template schema
      T2 ground-truth: numeric claims vs reference (Chainlink, CoinGecko)
      T3 llm-judge:   claude-haiku rubric score (only fuzzy categories)
  → append probes row (raw response hash, eval results, cost). Append-only.
      ▼
score (after each probe batch)
  rolling 30-day aggregate per service → scores table:
  0–100 composite + component breakdown + trend + probe count
      ▼                                    ▼
serve (Hono, Phase H)                 attest (weekly cron, Phase C)
  GET /tier/{id}    free, cached        ERC-8004 giveFeedback() digest on
  GET /score/{id}   x402-paid $0.005    Base, ONLY for services registered
  GET /leaderboard  free HTML           in the Identity Registry
```

## Data model (SQLite)

- `services` — id, bazaar metadata, domain, category, status
  (discovered | curated | retired)
- `probe_templates` — service_id, request spec, response schema,
  eval tier config, reference source
- `probes` — append-only: service_id, ts, request/response digests,
  payment tx, T0–T3 results, usdc_cost
- `scores` — service_id, ts, composite, components json, trend, n_probes
- `wallets` — address, purpose (probe | receive), rotation timestamps

## Key decisions

1. **Curated depth over breadth.** ~200–500 endpoints with hand-approved
   probe templates, not the full ~13,760-endpoint catalog. Probing costs
   real USDC; templates require human judgment. Coverage-breadth is the
   incumbents' game; content-depth is ours.
2. **Only templatable endpoints in MVP.** GET or fixed-body POST. Endpoints
   needing dynamic, meaningful inputs are out of scope until templates
   support parameter generators.
3. **Append-only probe log.** The evidence corpus is the moat — it cost
   money to create and cannot be reproduced retroactively.
4. **Tiered evaluation.** Deterministic checks (free) before LLM judging
   (metered). Target: median probe evaluation cost < the probe payment.
5. **SQLite over Postgres.** ~2K rows/day is trivial; zero ops; the DB is a
   file that moves to the VPS with the code. Revisit only if it breaks.
6. **Small hot wallet.** Probe wallet holds ≤ $50 USDC, topped up manually.
   Receiving wallet is separate. Keys in env, never in repo.
7. **Wallet rotation + probe jitter** as cheap hygiene against services
   detecting and special-casing the prober. Full Sybil-resistance is a
   known, documented limitation of v1.
8. **ERC-8004 attestor is post-MVP** and covers only the intersection of
   indexed services ∩ Identity-Registry registrants (small today). It is
   distribution/credibility, not core product.

## Hosting phases

- **Phase L (local):** process runs on Jason's Windows PC under pm2 /
  Task Scheduler. Prober + scorer only; no public surface. Purpose:
  accumulate ≥ 30 days of probe history (the cold-start asset) at $0 infra.
- **Phase H (hosted):** copy repo + SQLite file to a $5–10/mo VPS
  (Hetzner/Railway/Fly), start same process, add domain + TLS (Caddy),
  enable x402 seller middleware on /score, publish leaderboard, list
  Assay itself in the Bazaar.
- **Phase C (chain):** enable weekly attestor.

## Error handling

- Probe failures are data, not errors (a paid-but-denied IS the signal).
- Every probe wrapped in timeout (30s) + single retry with new nonce;
  retries recorded distinctly.
- Spend guard: daily USDC budget cap in config; prober halts and alerts
  (stdout + optional webhook) when exceeded.
- Score serving degrades to last-computed values if scorer fails.

## Testing

- Unit: evaluators (T0–T3) against fixture responses; scorer math.
- Integration: mock x402 server (official SDK ships one) for the full
  pay→evaluate→score loop without spending USDC.
- Live smoke: one real probe against one known-good endpoint on Base
  mainnet with ~$0.01, run manually before each release.

## Known risks

- **Market size:** x402 dollar volume is small today; revenue is a bet on
  ecosystem growth (Chainalysis: "past proof-of-concept, mass adoption
  distant").
- **Platform risk:** Coinbase could extend Bazaar scoring to content
  quality. Mitigation: move fast, own the evidence corpus, stay
  chain/facilitator-neutral.
- **Adversarial probing gap** (see decision 7).
- **ERC-8004 is Draft status;** interfaces may change — another reason
  the attestor is post-MVP.
