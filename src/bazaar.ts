import type Database from "better-sqlite3";

export const BAZAAR_URL =
  "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";

export async function ingestBazaar(
  db: Database.Database,
  fetchFn: typeof fetch = fetch
): Promise<{ upserted: number }> {
  const upsert = db.prepare(`
    INSERT INTO services (id, domain, name, category, price_usdc, network, status, first_seen, last_seen, raw)
    VALUES (@id, @domain, @name, @category, @price_usdc, @network, 'discovered', @now, @now, @raw)
    ON CONFLICT(id) DO UPDATE SET
      last_seen=@now, raw=@raw, price_usdc=@price_usdc, name=@name, category=@category
  `);
  let upserted = 0;
  let offset = 0;
  for (let pageN = 0; pageN < 50; pageN++) {
    const res = await fetchFn(`${BAZAAR_URL}?limit=100&offset=${offset}`);
    if (!res.ok) throw new Error(`Bazaar ingest failed: HTTP ${res.status}`);
    const data: any = await res.json();
    const items: any[] = data.items ?? [];
    const now = Date.now();
    for (const it of items) {
      const url: string = it.resource;
      if (!url?.startsWith("http")) continue;
      const accept = it.accepts?.[0] ?? {};
      upsert.run({
        id: url,
        domain: new URL(url).hostname,
        name: it.metadata?.name ?? null,
        category: it.metadata?.category ?? null,
        price_usdc: accept.maxAmountRequired ? Number(accept.maxAmountRequired) / 1e6 : null,
        network: accept.network ?? null,
        now,
        raw: JSON.stringify(it),
      });
      upserted++;
    }
    if (!data.nextOffset || items.length === 0) break;
    offset = data.nextOffset;
  }
  return { upserted };
}
