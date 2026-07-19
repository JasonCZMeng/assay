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
      last_seen=@now, raw=@raw, price_usdc=@price_usdc, name=@name, category=@category, network=@network
  `);
  const PAGE_CAP = 300;
  let upserted = 0;
  let malformed = 0;
  let offset = 0;
  // Tracks whether the loop ran out of pages (cap hit) vs. broke out because the walk
  // legitimately finished — used below to warn about un-ingested items.
  let capExhausted = true;
  let lastTotal: number | undefined;
  let lastNextOffset = offset;
  for (let pageN = 0; pageN < PAGE_CAP; pageN++) {
    const res = await fetchFn(`${BAZAAR_URL}?limit=100&offset=${offset}`);
    if (!res.ok) throw new Error(`Bazaar ingest failed: HTTP ${res.status}`);
    const data: any = await res.json();
    const items: any[] = data.items ?? [];
    const now = Date.now();
    // One transaction per page: ~26k individual auto-committed upserts per full walk is fsync
    // torture for zero benefit; a page is a natural atomic unit.
    const upsertPage = db.transaction((pageItems: any[]) => {
      for (const it of pageItems) {
        // A single malformed item (bad resource URL, etc.) must not abort the whole ingest run —
        // skip it, count it, and keep going.
        try {
          const url: string = it.resource;
          if (!url?.startsWith("http")) continue;
          const accept = it.accepts?.[0] ?? {};
          // Real Bazaar shape: serviceName, tags[], accepts[{amount, network, asset}]
          // Fallback: metadata.name, metadata.category, accepts[{maxAmountRequired}]
          const name = it.serviceName ?? it.metadata?.name ?? null;
          const tags = Array.isArray(it.tags) ? it.tags : [];
          const category = tags.length > 0 ? tags[0] : (it.metadata?.category ?? null);
          const amount = accept.amount ?? accept.maxAmountRequired;
          const price_usdc = amount ? Number(amount) / 1e6 : null;
          upsert.run({
            id: url,
            domain: new URL(url).hostname,
            name,
            category,
            price_usdc,
            network: accept.network ?? null,
            now,
            raw: JSON.stringify(it),
          });
          upserted++;
        } catch {
          malformed++;
        }
      }
    });
    upsertPage(items);
    if (items.length === 0) {
      capExhausted = false;
      break;
    }
    // Real API contract (verified live): top-level `pagination: { limit, offset, total }`,
    // not a `nextOffset` field. Advance by the page's own limit and stop once we've
    // passed the reported total. Use a null/undefined check, not falsiness, so a
    // legitimate offset/total of 0 doesn't terminate the walk prematurely.
    const pagination = data.pagination ?? {};
    const pageLimit: number = pagination.limit ?? items.length;
    const total: number | undefined = pagination.total;
    const nextOffset = offset + pageLimit;
    lastTotal = total;
    lastNextOffset = nextOffset;
    if (total !== null && total !== undefined && nextOffset >= total) {
      capExhausted = false;
      break;
    }
    offset = nextOffset;
  }
  if (capExhausted) {
    if (lastTotal !== undefined) {
      const remaining = Math.max(0, lastTotal - lastNextOffset);
      console.warn(`[bazaar] page cap (${PAGE_CAP}) reached — ${remaining} item(s) not ingested`);
    } else {
      console.warn(`[bazaar] page cap (${PAGE_CAP}) reached — remaining item count unknown`);
    }
  }
  if (malformed > 0) {
    console.warn(`[bazaar] skipped ${malformed} malformed item(s)`);
  }
  return { upserted };
}
