import { coinKey } from "./chains.js";
import { hourOf, priceMap, savePrices, type DB, type Transfer } from "./db.js";
import type { Fetch } from "./explorer.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Look up hourly USD prices for every (asset, hour) the ledger needs and hasn't cached. */
export async function fillPrices(db: DB, transfers: Transfer[], opts: { fetch?: Fetch; delayMs?: number; log?: (s: string) => void } = {}): Promise<number> {
  const f = opts.fetch ?? fetch;
  const cached = priceMap(db);
  const byHour = new Map<number, Set<string>>();
  for (const t of transfers) {
    const coin = coinKey(t.chainId, t.contract);
    const hour = hourOf(t.ts);
    if (cached.has(`${coin}@${hour}`)) continue;
    if (!byHour.has(hour)) byHour.set(hour, new Set());
    byHour.get(hour)!.add(coin);
  }
  let done = 0;
  for (const [hour, coins] of byHour) {
    const list = [...coins];
    for (let i = 0; i < list.length; i += 40) {
      const chunk = list.slice(i, i + 40);
      const url = `https://coins.llama.fi/prices/historical/${hour + 1800}/${chunk.join(",")}?searchWidth=6h`;
      const res = await f(url);
      if (!res.ok) throw new Error(`price lookup HTTP ${res.status}`);
      const json = (await res.json()) as { coins: Record<string, { price: number }> };
      savePrices(db, chunk.map((coin) => ({ coin, hour, usd: json.coins?.[coin]?.price ?? null })));
      done += chunk.length;
      if (opts.delayMs !== 0) await sleep(opts.delayMs ?? 120);
    }
    opts.log?.(`priced ${done} asset-hours`);
  }
  return done;
}
