# assay-x402-guard

A spend-guard for x402 agents. Wrap your paying `fetch` once, and every request is
pre-checked against [Assay](https://assay.nominal-labs.com)'s quality tier for that exact
resource URL — payments to services Assay rates **avoid** are blocked *before* any money
moves.

Assay's tiers are earned, not self-reported: real paid probes with on-chain receipts,
scored on settlement reliability, schema conformance, ground-truth accuracy, and LLM-judged
quality, with the evidence corpus anchored to Bitcoin daily.

## Install

```sh
npm install assay-x402-guard
```

## Use

```ts
import { privateKeyToAccount } from "viem/accounts";
import { ExactEvmScheme } from "@x402/evm";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { wrapFetchWithAssay } from "assay-x402-guard";

const account = privateKeyToAccount(process.env.WALLET_KEY as `0x${string}`);
const client = new x402Client().register("eip155:8453", new ExactEvmScheme(account));
const payFetch = wrapFetchWithPayment(fetch, client);
const safeFetch = wrapFetchWithAssay(payFetch); // guard goes OUTSIDE the payer

await safeFetch("https://some-x402-service.example/api");
// → AssayBlockedError if Assay rates that service "avoid" — thrown BEFORE payment
```

The guard consults Assay's **free** `/tier` endpoint (no API key), caches verdicts for an
hour, and adds one lookup per unique URL — nothing on the hot path after the first call.
ESM package; `require()` also works on Node ≥ 20.19.

## Options

```ts
wrapFetchWithAssay(payFetch, {
  minTier: "ok",        // "ok" (default): block only "avoid". "gold": block "ok" too.
  onUnrated: "allow",   // services with <20 probes — unproven, not bad (default allow)
  onUnknown: "allow",   // services Assay has never catalogued (default allow)
  failOpen: true,       // if the Assay lookup itself fails, let the request through (default)
  cacheTtlMs: 3_600_000,
  assayUrl: "https://assay.nominal-labs.com",
});
```

Blocked requests throw `AssayBlockedError` with `.service` and `.tier` — catch it to route
around bad services or surface the verdict to your agent.

## Semantics worth knowing

- **Fail-open by default.** A guard that bricks your agent when the oracle hiccups is worse
  than no guard; set `failOpen: false` if you'd rather halt than pay unverified. Failed
  lookups are only cached for 60s (successful verdicts for the full TTL), so one blip never
  disables the guard for long.
- **Only origin + path leave your process.** Query strings and fragments are stripped before
  the tier lookup — API keys or payloads in query params are never sent to Assay, and
  query-varying agent traffic shares one cache entry per resource.
- **Origin-exact, normalization-proof.** URLs are parsed (not regex-matched), so uppercase
  schemes or padded strings can't slip past the guard, and lookalike hosts can't ride an
  allowlist. Requests to Assay itself are never guarded (no recursion).
- **Strict-tier mode.** `minTier: "gold"` + `onUnrated: "block"` + `onUnknown: "block"`
  yields "only pay services with proven track records."

Full agent guide: <https://assay.nominal-labs.com/SKILL.md> · MIT © Nominal Labs
