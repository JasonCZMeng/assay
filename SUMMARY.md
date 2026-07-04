# Assay — Quality Oracle for the x402 Agent Economy

*(working name — an assay is a test of a metal's purity)*

## What it is

Assay is a small service that answers one question for AI agents:
**"If I pay this x402 API, will I actually get what I paid for?"**

It works by being a real paying customer. On a schedule, Assay pays x402
endpoints with real USDC, captures what comes back, and evaluates it:

1. **Settlement check** — did payment settle but the service return nothing?
2. **Schema conformance** — does the response match what the service advertises?
3. **Ground-truth cross-check** — for data with a verifiable answer (prices,
   rates), does it agree with trusted references (Chainlink, CoinGecko)?
4. **LLM judge** — for fuzzy content, a cheap model scores usefulness.

Probe results accumulate into a rolling 30-day **quality score (0–100)** per
service, with the evidence to back it up.

## Why it can charge money

Every existing x402 trust product (Coinbase Bazaar's native score, Agentic
Resource Radar, x402 Trust Oracle, x402scout) scores services on *liveness* —
uptime, latency, config drift, payment telemetry. **Nobody pays endpoints and
verifies the content that comes back.** Verified July 2026 across all named
competitors. Meanwhile the Bazaar's discovery layer is provably gameable
(a single metadata manipulation captured 71.8% of agent selections in
published testing), so agents need an independent answer.

The scores themselves are sold agent-natively:

- `GET /tier/{service}` — free, cached, label only (gold / ok / avoid).
  This is the discovery hook.
- `GET /score/{service}` — x402-paid (~$0.005 USDC), full score + evidence.
  Market pricing for comparable calls is $0.002–0.010, so this fits.
- Later: "monitored + attested" subscriptions paid by service operators
  (the SSL-certificate model), and score digests published on-chain to the
  ERC-8004 reputation registry.

The moat: scores are backed by an append-only log of *paid* probes.
Reproducing the dataset costs a competitor real money and real months.

## What it costs to run

- Probe spend: ~200–500 curated endpoints × 2–4 probes/day at micro-prices
  ≈ **$50–150/month in USDC** (tunable — this is the main cost).
- Infra: **$0 during the local phase** (runs on a home PC), then a ~$5–10/month
  VPS once public.
- Break-even: roughly 500–1,000 paid score calls/day, or a handful of
  operator subscriptions.

## Market honesty

x402 is real but early: ~270K transactions/day (July 2026, growing ~125%/mo)
and 100M+ cumulative on Base — but ecosystem dollar volume is still small and
Chainalysis calls mass adoption "distant." Year-one revenue is beer money.
The bet is positioning: own the "response quality" axis of agent trust before
the market grows into it, then extend the same pipe to token/contract safety
checks and RWA data.

## Roadmap shape

1. **Phase L (local, weeks 1–5):** build + run prober from a home PC,
   accumulate the 30-day evidence base. Nothing public, near-zero cost.
2. **Phase H (hosted):** move to a VPS, launch free leaderboard + paid
   x402 scores API.
3. **Phase C (chain):** publish weekly score attestations to ERC-8004 on
   Base for the subset of services with registered identities.
4. **Later:** operator subscriptions, token/contract pre-flight checks (B),
   RWA data (A).
