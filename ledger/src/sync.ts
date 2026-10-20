import { chainById } from "./chains.js";
import { ensureToken, getCursor, insertTransfers, listTransfers, listWallets, setCursor, type DB } from "./db.js";
import { ACTIONS, fetchRows, normalize, type ExplorerOpts } from "./explorer.js";
import { fillPrices } from "./prices.js";

export interface SyncStatus {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  log: string[];
}

export const syncStatus: SyncStatus = { running: false, startedAt: null, finishedAt: null, error: null, log: [] };

export async function syncAll(db: DB, opts: ExplorerOpts & { only?: string } = {}): Promise<void> {
  if (syncStatus.running) throw new Error("sync already running");
  Object.assign(syncStatus, { running: true, startedAt: Date.now(), finishedAt: null, error: null, log: [] });
  const log = (s: string) => { syncStatus.log.push(`${new Date().toISOString().slice(11, 19)} ${s}`); if (syncStatus.log.length > 200) syncStatus.log.shift(); };
  try {
    for (const w of listWallets(db)) {
      if (opts.only && opts.only !== w.address) continue;
      for (const chainId of w.chains) {
        for (const action of ACTIONS) {
          const start = getCursor(db, w.address, chainId, action) + 1;
          const rows = await fetchRows(chainId, action, w.address, start, opts);
          const { transfers, tokens } = normalize(chainId, action, w.address, rows);
          for (const t of tokens) ensureToken(db, t);
          const added = insertTransfers(db, transfers);
          const maxBlock = rows.reduce((m, r) => Math.max(m, Number(r.blockNumber)), start - 1);
          if (maxBlock >= start) setCursor(db, w.address, chainId, action, maxBlock);
          log(`${w.label} · ${chainById(chainId).name} · ${action}: ${rows.length} rows, ${added} new`);
        }
      }
    }
    for (const c of new Set(listWallets(db).flatMap((w) => w.chains))) {
      const meta = chainById(c);
      ensureToken(db, { chainId: c, contract: "native", symbol: meta.nativeSymbol, name: meta.nativeSymbol, decimals: 18 });
    }
    log("pricing…");
    await fillPrices(db, listTransfers(db), { fetch: opts.fetch, delayMs: opts.delayMs, log });
    log("done");
  } catch (e) {
    syncStatus.error = (e as Error).message;
    log(`error: ${(e as Error).message}`);
    throw e;
  } finally {
    syncStatus.running = false;
    syncStatus.finishedAt = Date.now();
  }
}
