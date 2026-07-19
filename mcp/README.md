# assay-oracle-mcp

MCP server for [Assay](https://assay.nominal-labs.com), the x402 service-quality oracle.
Your agent asks Assay **before paying** any machine-payable (x402) service: is this thing
actually any good?

Assay's answer is earned, not self-reported: it pays real USDC to probe x402 services
several times a day, records whether payment settled (with the on-chain tx hash), whether
the response matched the advertised schema, whether the data agreed with independent
references, and how an LLM judged the response. Daily evidence digests are anchored to
Bitcoin via OpenTimestamps, so history can't be quietly rewritten.

## Install

**Claude Code**

```sh
claude mcp add assay -- npx -y assay-oracle-mcp
```

**Claude Desktop / any MCP client** — add to your MCP config:

```json
{
  "mcpServers": {
    "assay": {
      "command": "npx",
      "args": ["-y", "assay-oracle-mcp"]
    }
  }
}
```

Requires Node 18+. No API key. (Not related to the npm package `assay-mcp`, a code-verification tool — this is the MCP server for the [Assay x402 quality oracle](https://assay.nominal-labs.com).)

## Tools

| Tool | Cost | What it does |
|---|---|---|
| `check_service` | free | Quality tier (`gold` / `ok` / `avoid` / `unrated`) for an x402 resource URL, with a one-line verdict. Use before paying an unfamiliar endpoint. |
| `get_score` | free lookup¹ | Full report: composite 0–100, component breakdown (settlement, schema, ground truth, LLM judge), 7-day trend, probe count. |
| `top_services` | free | Ranked list of the x402 services Assay actively probes, best first. |

¹ `GET /score` is itself a paid x402 endpoint ($0.005 USDC on Base). The tool reports the
402 payment details when hit without payment; the free `check_service` tier verdict is
sufficient for most pre-payment decisions.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `ASSAY_URL` | `https://assay.nominal-labs.com` | Assay instance to query |

## How to read the tiers

- **gold** (composite ≥ 85) — consistently delivers what it charges for
- **ok** (≥ 60) — generally delivers, some failures
- **avoid** — frequently fails to deliver paid responses correctly
- **unrated** — under 20 probes so far; unproven, not bad
- a 404/`unknown` means Assay has no paid-probe evidence for that URL at all

Also see [`assay-x402-guard`](https://www.npmjs.com/package/assay-x402-guard) — a fetch
wrapper that enforces these tiers automatically on every paid request your agent makes.

Full agent guide: <https://assay.nominal-labs.com/SKILL.md> · MIT © Nominal Labs
