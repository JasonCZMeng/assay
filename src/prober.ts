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
  const client = new x402Client().register("eip155:*", new ExactEvmScheme(account));
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

  if (spentTodayUsdc(db, now()) >= config.dailyBudgetUsdc) {
    console.error(`[prober] daily budget reached — halting`);
    return { probed: 0, skipped: "budget" };
  }

  const payFetch = deps.payFetch ?? makePayFetch();

  const insert = db.prepare(`
    INSERT INTO probes (service_id, ts, ok_settlement, ok_schema, gt_deviation_pct, llm_score,
                        http_status, latency_ms, usdc_cost, payment_tx, response_hash, response_excerpt, error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  let probed = 0;
  for (const t of getTemplates(db)) {
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
      try {
        json = JSON.parse(body);
      } catch {
        okSchema = 0;
      }
      if (json !== null) {
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
