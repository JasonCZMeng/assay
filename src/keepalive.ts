import type Database from "better-sqlite3";
import { config } from "./config.js";
import { makePayFetch } from "./prober.js";

// Bazaar activity floor. CDP excludes resources with no successful settlement in the last
// 30 days from discovery results entirely, so one $0.005 self-purchase of /score every few
// days keeps the catalog entry alive (and its metadata fresh) through slow periods. The
// probe wallet pays the receive wallet — both ours, so the cost is net zero. Deliberately a
// floor, not volume: unique-payer counts are public in the catalog, so inflating call counts
// from our own wallet would be both visible and counterproductive.
export async function keepalivePurchase(
  db: Database.Database,
  deps: { payFetch?: typeof fetch; baseUrl?: string } = {}
): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const target = (
    db.prepare("SELECT id FROM services WHERE status='curated' ORDER BY id LIMIT 1").get() as
      | { id: string }
      | undefined
  )?.id;
  if (!target) return { ok: false, status: null, error: "no curated service to query" };

  // Goes out through the public URL like any customer: 402 challenge → pay → JSON. The
  // payment passes the same makePayFetch guards as probe spending (USDC-only, hard cap).
  // Query form, not /score/:id — that route pins `resource` to the canonical public URL,
  // so every keep-alive settlement reinforces the ONE Bazaar catalog entry.
  const payFetch = deps.payFetch ?? makePayFetch();
  const base = deps.baseUrl ?? config.publicUrl;
  try {
    const res = await payFetch(`${base}/score?service=${encodeURIComponent(target)}`, {
      signal: AbortSignal.timeout(30_000),
    });
    return { ok: res.ok, status: res.status, error: null };
  } catch (e: unknown) {
    return { ok: false, status: null, error: String((e as any)?.message ?? e).slice(0, 200) };
  }
}
