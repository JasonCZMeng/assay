import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";
import { getSetting } from "./db.js";
import { getTemplates } from "./templates.js";
import { evalSchema, evalGroundTruth } from "./evaluate.js";
import { judgeResponse } from "./judge.js";

export function spentTodayUsdc(db: Database.Database, now: number): number {
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  const r: any = db
    .prepare("SELECT COALESCE(SUM(usdc_cost),0) s FROM probes WHERE ts >= ?")
    .get(dayStart);
  return r.s;
}

// Hard cap on any single x402 payment the prober will make, in 6-decimal atomic USDC units
// (0.05 USDC). Guards against a malicious or misconfigured service demanding an outsized amount.
export const HARD_CAP_USDC_UNITS = 50_000n;

// Base USDC token address on Ethereum L2 chain (Coinbase chain, eip155:8453)
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Pure helper so the cap check is unit-testable without going through x402Client/hooks.
export function withinCap(amountUnits: bigint | string | number): boolean {
  let n: bigint;
  try {
    n = typeof amountUnits === "bigint" ? amountUnits : BigInt(amountUnits);
  } catch {
    return false; // unparsable amount — fail closed
  }
  return n >= 0n && n <= HARD_CAP_USDC_UNITS;
}

// Pure helper to validate payment requirements: amount must be within cap and asset must be BASE_USDC.
// Returns { ok: true } if allowed, or { ok: false, reason } if denied.
export function paymentAllowed(req: {
  amount?: string | bigint | number;
  asset?: string;
}): { ok: true } | { ok: false; reason: string } {
  // Check asset is BASE_USDC (case-insensitive comparison)
  if (!req.asset || req.asset.toLowerCase() !== BASE_USDC.toLowerCase()) {
    return {
      ok: false,
      reason: `asset ${req.asset || "undefined"} is not BASE_USDC ${BASE_USDC}`,
    };
  }

  // Amount must be present AND within cap. Fail CLOSED on a missing amount: treating an absent
  // amount as 0 (the old `req.amount ?? 0`) let a requirement with no stated amount slip past
  // the hard-cap check, which is precisely the input we must not authorize blindly.
  if (req.amount == null || !withinCap(req.amount)) {
    return {
      ok: false,
      reason: `payment amount ${req.amount} is missing or exceeds hard cap ${HARD_CAP_USDC_UNITS}`,
    };
  }

  return { ok: true };
}

// Real paying fetch. `@x402/fetch` v2's `wrapFetchWithPayment(fetch, client)` takes an
// `x402Client` (or `x402HTTPClient`) built via the builder pattern, not an account directly
// (confirmed against node_modules/@x402/fetch/README.md — the brief's `wrapFetchWithPayment(fetch,
// account)` shape does not exist). `ExactEvmScheme` lives in `@x402/evm`, which was not yet a
// project dependency; added it at ^2.17.0 to match the other @x402/* packages.
// `onPay`, when supplied, is invoked with the exact atomic-USDC amount authorized for each
// payment — the source of truth for budget accounting (the `exact` scheme settles exactly this).
export function makePayFetch(onPay?: (amountUnits: bigint) => void): typeof fetch {
  let account;
  try {
    account = privateKeyToAccount(config.probeWalletKey as `0x${string}`);
  } catch {
    // Never echo the raw exception — it can contain fragments of the private key.
    throw new Error("invalid probe wallet key");
  }
  // Only the network we actually pay on — registering a wildcard would let a service demand
  // payment on a chain we never intended to send funds on.
  const client = new x402Client()
    .register("eip155:8453", new ExactEvmScheme(account))
    // `onBeforePaymentCreation` (confirmed in node_modules/@x402/core's x402Client-*.d.ts) fires
    // right before a payment payload is built for the selected requirement. Returning
    // `{ abort: true, reason }` makes `createPaymentPayload` throw, which surfaces through
    // `wrapFetchWithPayment` as a rejected fetch — caught by runProbes' try/catch below and
    // recorded as a failed probe instead of paying.
    .onBeforePaymentCreation(async ({ selectedRequirements }) => {
      const check = paymentAllowed(selectedRequirements);
      if (!check.ok) {
        return {
          abort: true,
          reason: check.reason,
        };
      }
      // Payment is about to be created — capture the authorized amount for real-spend accounting.
      if (onPay && selectedRequirements?.amount != null) {
        try {
          onPay(BigInt(selectedRequirements.amount));
        } catch {
          /* unparsable amount — leave unrecorded rather than crash the sweep */
        }
      }
    });
  return wrapFetchWithPayment(fetch, client);
}

type Deps = {
  payFetch?: typeof fetch;
  // Factory seam: receives the onPay callback so a test can drive the paid-amount accounting
  // without a wallet or network. Ignored when payFetch is supplied.
  makePayFetch?: (onPay?: (amountUnits: bigint) => void) => typeof fetch;
  refFetch?: typeof fetch;
  judge?: typeof judgeResponse;
  now?: () => number;
};

export async function runProbes(
  db: Database.Database,
  deps: Deps = {}
): Promise<{ probed: number; skipped: string | null }> {
  const now = deps.now ?? Date.now;
  const judge = deps.judge ?? judgeResponse;

  // Kill switch: the dashboard can pause all probing (cron and manual alike). Checked here,
  // not in the scheduler, so every entry point honors it.
  if (getSetting(db, "paused") === "1") {
    console.error("[prober] paused — skipping run");
    return { probed: 0, skipped: "paused" };
  }

  // Lazily built: only construct the paying fetch once we know at least one probe will run,
  // so a budget that's already exhausted never touches the wallet key.
  let payFetch = deps.payFetch;
  // Set by makePayFetch's onPay hook to the atomic-USDC amount authorized for the current probe.
  // Reset to null before each probe; a null after the fetch means no payment was made.
  let paidUnits: bigint | null = null;

  const insert = db.prepare(`
    INSERT INTO probes (service_id, ts, ok_settlement, ok_schema, gt_deviation_pct, llm_score,
                        http_status, latency_ms, usdc_cost, payment_tx, response_hash, response_excerpt, error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  let probed = 0;
  for (const t of getTemplates(db)) {
    // Re-check before every probe (not just once at the top of the run): a long run can cross
    // the daily budget mid-loop as earlier probes' costs land, or an operator can pause the
    // sweep from the dashboard — either must stop us immediately rather than keep paying.
    if (getSetting(db, "paused") === "1") {
      console.error(`[prober] paused mid-run — halting`);
      return { probed, skipped: "paused" };
    }
    if (spentTodayUsdc(db, now()) >= config.dailyBudgetUsdc) {
      console.error(`[prober] daily budget reached — halting`);
      return { probed, skipped: "budget" };
    }
    if (!payFetch) payFetch = (deps.makePayFetch ?? makePayFetch)((amt) => (paidUnits = amt));

    paidUnits = null; // cleared each probe; the pay hook sets it only if a payment is authorized
    const started = now();
    let status: number | null = null;
    let body = "";
    let error: string | null = null;
    let paymentTx: string | null = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await payFetch(t.url, {
          method: t.method,
          headers: t.headers,
          body: t.method === "POST" ? t.body : undefined,
          signal: controller.signal,
        });
        status = res.status;
        body = await res.text();
        // If the wrapped fetch surfaced an x402 settlement header, decode it for the tx hash.
        const paymentResponseHeader = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
        if (paymentResponseHeader) {
          try {
            paymentTx = decodePaymentResponseHeader(paymentResponseHeader)?.transaction ?? null;
          } catch {
            paymentTx = null;
          }
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (e: any) {
      error = String(e?.message ?? e).slice(0, 500);
    }
    const latency = now() - started;
    const okSettlement = status !== null && status >= 200 && status < 300 ? 1 : 0;

    let okSchema: number | null = null;
    let gtDev: number | null = null;
    let llm: number | null = null;
    if (okSettlement) {
      let json: unknown = null;
      let parseFailed = false;
      try {
        json = JSON.parse(body);
      } catch {
        parseFailed = true;
      }
      if (parseFailed || json === null) {
        // A parse failure and a literal `null` body are both schema failures: a paid endpoint
        // that returns nothing usable didn't satisfy its contract — this isn't "not run".
        okSchema = 0;
      } else {
        okSchema = evalSchema(json, t.responseSchema) ? 1 : 0;
        if (t.groundTruth) gtDev = await evalGroundTruth(json, t.groundTruth, deps.refFetch);
      }
      if (t.llmRubric) llm = await judge(body.slice(0, 2000), t.llmRubric);
    }

    // Record the amount ACTUALLY authorized this probe (0 if no payment was made), not the
    // Bazaar catalog price — the budget guard sums this column, so it must reflect real spend.
    const cost = paidUnits != null ? Number(paidUnits) / 1e6 : 0;
    insert.run(
      t.serviceId, started, okSettlement, okSchema, gtDev, llm, status, latency,
      cost,
      paymentTx,
      createHash("sha256").update(body).digest("hex"), body.slice(0, 2000), error
    );
    probed++;
  }
  return { probed, skipped: null };
}
