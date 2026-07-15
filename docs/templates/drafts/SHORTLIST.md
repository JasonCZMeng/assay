# Curation shortlist — first probe batch (drafted 2026-07-15, pending approval)

15 candidates from the 25,977-service Bazaar catalog (post-2026-07-15 ingest). Selection criteria:
Base mainnet (`eip155:8453`), price ≤ $0.02, GET with fixed inputs, one service per domain,
real usage where available (`quality.l30DaysUniquePayers` from Bazaar telemetry), and tier
diversity — 7 ground-truthed price feeds (exercise T0–T3), 8 schema+rubric services (T0/T1/T3).

All 15 validated against `ProbeTemplateSchema` and confirmed present in the services table.
**Cost: $0.0865 per full run → ~$0.26/day at 3 runs → ~$7.80 for 30 days.**

Schemas are deliberately loose for the first batch (require only fields shown in the service's own
Bazaar output example) — tighten after we see real responses. Not probed yet; expect some of
these to fail or 404. That is signal, not a problem: failures are exactly what Assay measures.

| # | Service | $/probe | Payers(30d) | Tiers | Ground truth |
|---|---------|---------|-------------|-------|--------------|
| 01 | aiagentoracle.ai — ETH spot price | 0.010 | n/a | T0–T3 | `priceUsd` vs CoinGecko ethereum/usd |
| 02 | api.myceliasignal.com — BTC price (9-exchange agg, signed) | 0.010 | 8 | T0–T3 | `price` vs bitcoin/usd |
| 03 | apexrunner.ai — BTC/ETH/SOL/AVAX tick | 0.007 | 1 | T0–T3 | `b` vs bitcoin/usd |
| 04 | api.anchor-x402.com — token price by symbol | 0.001 | 75 | T0–T3 | `usd` vs ethereum/usd |
| 05 | proxy.suverse.io — BTC spot | 0.001 | 31 | T0–T3 | `bitcoin.usd` vs bitcoin/usd |
| 06 | api.lastlookdata.com — crypto price+mcap (CoinGecko-sourced) | 0.020 | n/a | T0–T3 | `price_usd` vs bitcoin/usd |
| 07 | crypto.apitoll.cloud — multi-coin price | 0.001 | 31 | T0–T3 | `prices.0.price` vs bitcoin/usd |
| 08 | api.onesource.io — ETH block number | 0.001 | 410 | T0,T1,T3 | rubric: plausible current height |
| 09 | x402.ottoai.services — crypto news + sentiment | 0.001 | 120 | T0,T1,T3 | rubric: substantive current news |
| 10 | x402.twit.sh — tweet search | 0.006 | 38 (75k calls) | T0,T1,T3 | rubric: filters respected, authentic |
| 11 | api.interzoid.com — translation | 0.010 | 101 | T0,T1,T3 | rubric: correct Japanese for fixed input |
| 12 | tick.hugen.tokyo — EUR/USD FX tick | 0.005 | 118 | T0,T3 | rubric: plausible range, bid<ask |
| 13 | x402.shizu.me — weather (Berlin coords) | 0.003 | 30 | T0,T3 | rubric: physically plausible reading |
| 14 | 2s.io — geocoding (fixed: White House) | 0.001 | 84 | T0,T3 | rubric: coords ≈ 38.897,-77.036 |
| 15 | blockrun.ai — Polymarket markets | 0.0095 | 41 | T0,T3 | rubric: real markets, prices in [0,1] |

Notes:
- 06 (lastlookdata) self-declares CoinGecko as its source, the same as our reference — its T2
  deviation should be ~0; useful as a control for the ground-truth pipeline itself.
- 05 (suverse) is a proxy/reseller — interesting test of the "wrapper" service class.
- 12–15 have no declared output example in the Bazaar, so schemas are shape-only and the
  rubric carries evaluation until we tighten from observed responses.

## To curate after approval

```
npm run curate -- add https://aiagentoracle.ai/api/v1/price/ETH docs/templates/drafts/01-aiagentoracle-eth-price.json
npm run curate -- add https://api.myceliasignal.com/oracle/price/btc/usd docs/templates/drafts/02-myceliasignal-btc-price.json
npm run curate -- add https://apexrunner.ai/signals/btc-price-tick docs/templates/drafts/03-apexrunner-btc-tick.json
npm run curate -- add https://api.anchor-x402.com/v1/price/token docs/templates/drafts/04-anchor-eth-price.json
npm run curate -- add https://proxy.suverse.io/v1/proxy/reskey_1166628d/bazaar-test docs/templates/drafts/05-suverse-btc-price.json
npm run curate -- add https://api.lastlookdata.com/api/crypto/price docs/templates/drafts/06-lastlook-btc-price.json
npm run curate -- add https://crypto.apitoll.cloud/v1/crypto/price docs/templates/drafts/07-apitoll-btc-price.json
npm run curate -- add https://api.onesource.io/api/chain/block-number docs/templates/drafts/08-onesource-block-number.json
npm run curate -- add https://x402.ottoai.services/crypto-news docs/templates/drafts/09-ottoai-crypto-news.json
npm run curate -- add https://x402.twit.sh/tweets/search docs/templates/drafts/10-twitsh-tweet-search.json
npm run curate -- add https://api.interzoid.com/translatetoany docs/templates/drafts/11-interzoid-translate.json
npm run curate -- add https://tick.hugen.tokyo/tick/latest docs/templates/drafts/12-hugen-fx-tick.json
npm run curate -- add https://x402.shizu.me/weather docs/templates/drafts/13-shizu-weather-berlin.json
npm run curate -- add https://2s.io/api/geocode/address docs/templates/drafts/14-2s-geocode-whitehouse.json
npm run curate -- add https://blockrun.ai/api/v1/pm/polymarket/markets docs/templates/drafts/15-blockrun-polymarket.json
```

Suggested Task 10 smoke: curate **only #05 (suverse, $0.001)** first, run one probe, verify the
probe row + payment tx on Basescan, then curate the rest.
