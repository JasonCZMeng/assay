// Hosted SKILL.md — the Bazaar convention for a machine-readable usage guide (CDP's curated
// tier expects one; the SDK has no `skillUrl` field yet, so the listing description links to
// it). Served free at /SKILL.md: an agent deciding whether to pay must be able to read the
// manual first.
export const SKILL_MD = `---
name: assay-service-scores
description: >-
  Verified quality scores for x402 services. Before paying an unknown machine-payable
  service, buy its score ($0.005 USDC on Base) or check its free tier verdict. Scores are
  earned by real paid probes with on-chain receipts and Bitcoin-anchored evidence digests.
---

# Assay — x402 service-quality oracle

Base URL: \`https://assay.nominal-labs.com\`

Assay pays real USDC to probe machine-payable (x402) services several times a day and scores
what actually happened — no self-reported claims. Each probe records whether payment settled
(with the settlement tx hash), whether the response matched the advertised schema, how far
the data deviated from an independent reference, and an LLM-judged quality rating. The probe
corpus is append-only; its daily Merkle digests are anchored to Bitcoin via OpenTimestamps,
so history cannot be quietly rewritten.

## When to use

- Before paying an x402 service you have not used: check its tier or buy its score.
- Choosing between similar services discovered in the x402 Bazaar: compare composites.
- Monitoring a dependency: recheck the score periodically and watch \`trend\`.

## Endpoints

### \`GET /score/{serviceUrl}\` — paid ($0.005 USDC, Base)

\`{serviceUrl}\` is the URL-encoded resource URL of the service, exactly as advertised in the
Bazaar (e.g. \`/score/https%3A%2F%2Fapi.example.com%2Fdata\`).

Standard x402 flow: the request returns HTTP 402 with payment requirements (\`exact\` scheme,
USDC on \`eip155:8453\`); pay with any x402 client (e.g. \`wrapFetchWithPayment\` from
\`@x402/fetch\`) and the JSON is returned:

\`\`\`json
{
  "service": "https://api.example.com/data",
  "composite": 94.3,
  "components": { "settlement": 1, "schema": 0.95, "groundTruth": 0.99, "llm": 0.8 },
  "nProbes": 42,
  "trend": 1.2,
  "ts": 1784150719964
}
\`\`\`

- \`composite\` (0–100): weighted blend — settlement 40%, schema 30%, ground truth 20%,
  LLM judge 10%, renormalized over the components a service has data for. \`null\` until the
  service has 20+ probes in the trailing 30 days: Assay does not score thin evidence.
- \`components\` are 0–1 rates over the trailing 30 days of probes.
- \`trend\`: the last 7 days' composite minus the 30-day composite (positive = improving);
  \`null\` when there are fewer than 5 recent probes.
- HTTP 404: Assay has not probed that service — absence of evidence, not a verdict.

### \`GET /tier/{serviceUrl}\` — free

\`{"service": ..., "tier": "gold" | "ok" | "avoid" | "unrated"}\` — gold ≥ 85, ok ≥ 60,
otherwise avoid; unrated while composite is null. Cacheable for 1 hour.

### \`GET /leaderboard\` — free

HTML table of every scored service with composite, tier, and probe count.

### \`GET /api/digests\` — free

Daily corpus digests: Merkle root, probe count, and the OpenTimestamps calendars each root
is anchored to. Use this to independently verify that scoring evidence predates its claims.

### \`GET /healthz\` — free

Liveness plus probe counts for the last 24 hours.

## Tooling (npm)

- **MCP server** — \`claude mcp add assay -- npx -y assay-oracle-mcp\` (or the equivalent
  MCP config in any client): tools \`check_service\`, \`get_score\`, \`top_services\`.
- **Spend guard** — \`npm install assay-x402-guard\`: wrap your paying fetch with
  \`wrapFetchWithAssay\` and payments to services rated *avoid* throw before any money moves.

## Trust model

- Every score derives solely from probes Assay itself paid for; probes carry settlement
  transaction hashes on Base.
- Scores publish only after 20+ probes spread across days — never from a single snapshot.
- Rate limit: 120 requests/min per IP.
`;
