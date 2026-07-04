import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";
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

// Real paying fetch. `@x402/fetch` v2's `wrapFetchWithPayment(fetch, client)` takes an
// `x402Client` (or `x402HTTPClient`) built via the builder pattern, not an account directly
// (confirmed against node_modules/@x402/fetch/README.md — the brief's `wrapFetchWithPayment(fetch,
// account)` shape does not exist). `ExactEvmScheme` lives in `@x402/evm`, which was not yet a
// project dependency; added it at ^2.17.0 to match the other @x402/* packages.
export function makePayFetch(): typeof fetch {
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
      if (!withinCap(selectedRequirements.amount)) {
        return {
          abort: true,
          reason: `payment amount ${selectedRequirements.amount} exceeds hard cap ${HARD_CAP_USDC_UNITS}`,
        };
      }
    });
  return wrapFetchWithPayment(fetch, client);
}

type Deps = {
  payFetch?: typeof fetch;
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

  // Lazily built: only construct the paying fetch once we know at least one probe will run,
  // so a budget that's already exhausted never touches the wallet key.
  let payFetch = deps.payFetch;

  const insert = db.prepare(`
    INSERT INTO probes (service_id, ts, ok_settlement, ok_schema, gt_deviation_pct, llm_score,
                        http_status, latency_ms, usdc_cost, payment_tx, response_hash, response_excerpt, error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  let probed = 0;
  for (const t of getTemplates(db)) {
    // Re-check before every probe (not just once at the top of the run): a long run can cross
    // the daily budget mid-loop as earlier probes' costs land, and we must stop immediately
    // rather than keep paying past the cap.
    if (spentTodayUsdc(db, now()) >= config.dailyBudgetUsdc) {
      console.error(`[prober] daily budget reached — halting`);
      return { probed, skipped: "budget" };
    }
    if (!payFetch) payFetch = makePayFetch();

    const price: any = db.prepare("SELECT price_usdc FROM services WHERE id=?").get(t.serviceId);
    const cost = price?.price_usdc ?? 0;
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

    insert.run(
      t.serviceId, started, okSettlement, okSchema, gtDev, llm, status, latency,
      cost, // payment may settle even on failure — record the price regardless of outcome
      paymentTx,
      createHash("sha256").update(body).digest("hex"), body.slice(0, 2000), error
    );
    probed++;
  }
  return { probed, skipped: null };
}
