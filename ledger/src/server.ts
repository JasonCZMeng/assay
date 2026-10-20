import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CATEGORIES, filterRows, flowGraph, ledgerRows, loadCtx, type RowFilter } from "./accounting.js";
import { CHAINS } from "./chains.js";
import { ledgerCsv, offrampCsv } from "./csv.js";
import {
  addEntity, deleteCounterparty, deleteEntity, deleteWallet, lastSyncedAt, listCounterparties, listEntities,
  listTokens, listWallets, setAnnotation, setTokenHidden, updateEntity, upsertCounterparty, upsertWallet, type DB,
} from "./db.js";
import type { ExplorerOpts } from "./explorer.js";
import { issueText, offrampTrails } from "./provenance.js";
import { syncAll, syncStatus } from "./sync.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const D3 = join(ROOT, "node_modules", "d3", "dist", "d3.min.js");
const STATIC: Record<string, [string, string]> = {
  "/": [join(PUBLIC, "index.html"), "text/html; charset=utf-8"],
  "/app.js": [join(PUBLIC, "app.js"), "text/javascript; charset=utf-8"],
  "/styles.css": [join(PUBLIC, "styles.css"), "text/css; charset=utf-8"],
  "/d3.min.js": [D3, "text/javascript; charset=utf-8"],
};

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => s.toLowerCase());
const chainIds = CHAINS.map((c) => c.id);
const EntityIn = z.object({ name: z.string().trim().min(1).max(80), kind: z.enum(["corporate", "personal"]) });
const WalletIn = z.object({
  label: z.string().trim().min(1).max(80),
  entityId: z.number().int(),
  chains: z.array(z.number().int().refine((c) => chainIds.includes(c), "unsupported chain")).min(1),
});
const CounterpartyIn = z.object({
  label: z.string().trim().min(1).max(80),
  group: z.string().trim().max(80).nullable().transform((s) => s || null),
  category: z.string().trim().min(1).max(40),
  isOfframp: z.boolean(),
  entityId: z.number().int().nullable(),
  notes: z.string().max(500).nullable(),
});
const AnnotationIn = z.object({
  category: z.string().max(40).nullable().transform((s) => s || null),
  memo: z.string().max(1000).nullable().transform((s) => s || null),
});

function parseFilter(q: Record<string, string>): RowFilter {
  const day = (s: string | undefined, plus = 0) => (s ? Math.floor(Date.parse(s + "T00:00:00Z") / 1000) + plus : undefined);
  const num = (s: string | undefined) => (s ? Number(s) : undefined);
  return {
    entityId: num(q.entity), wallet: q.wallet?.toLowerCase() || undefined, chainId: num(q.chain),
    from: day(q.from), to: day(q.to, 86400), flag: q.flag || undefined, q: q.q || undefined,
  };
}

export function createApp(db: DB, explorer: ExplorerOpts = {}): Hono {
  const app = new Hono();

  // Local-only tool: refuse foreign Host headers (DNS rebinding) and non-JSON writes (CSRF).
  app.use("*", async (c, next) => {
    const host = (c.req.header("host") ?? "").replace(/:\d+$/, "");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return c.text("forbidden host", 403);
    if (c.req.method !== "GET" && c.req.method !== "DELETE" && !(c.req.header("content-type") ?? "").includes("application/json")) {
      return c.text("expected application/json", 415);
    }
    if (c.req.method === "DELETE" && c.req.header("x-ledger") !== "1") return c.text("missing x-ledger header", 403);
    await next();
  });
  app.onError((err, c) => c.json({ error: err instanceof z.ZodError ? err.issues.map((i) => i.message).join("; ") : err.message }, 400));

  for (const [path, [file, type]] of Object.entries(STATIC)) {
    app.get(path, (c) => c.body(readFileSync(file), 200, { "content-type": type, "cache-control": "no-cache" }));
  }

  app.get("/api/state", (c) => {
    const synced = lastSyncedAt(db);
    return c.json({
      entities: listEntities(db),
      wallets: listWallets(db).map((w) => ({ ...w, lastSync: synced.get(w.address) ?? null })),
      counterparties: listCounterparties(db),
      chains: CHAINS.map(({ id, name, explorer: url }) => ({ id, name, explorer: url })),
      categories: CATEGORIES,
      provider: explorer.etherscanKey ? "Etherscan v2" : "Blockscout",
      sync: syncStatus,
    });
  });

  app.post("/api/entities", async (c) => {
    const e = EntityIn.parse(await c.req.json());
    return c.json({ id: addEntity(db, e.name, e.kind) });
  });
  app.put("/api/entities/:id", async (c) => {
    const e = EntityIn.parse(await c.req.json());
    updateEntity(db, Number(c.req.param("id")), e.name, e.kind);
    return c.json({ ok: true });
  });
  app.delete("/api/entities/:id", (c) => { deleteEntity(db, Number(c.req.param("id"))); return c.json({ ok: true }); });

  app.put("/api/wallets/:address", async (c) => {
    const w = WalletIn.parse(await c.req.json());
    if (!listEntities(db).some((e) => e.id === w.entityId)) throw new Error("unknown entity");
    if (listCounterparties(db).some((cp) => cp.address === address.parse(c.req.param("address")))) {
      throw new Error("address is labeled as a counterparty — remove that label first");
    }
    upsertWallet(db, { address: address.parse(c.req.param("address")), ...w });
    return c.json({ ok: true });
  });
  app.delete("/api/wallets/:address", (c) => { deleteWallet(db, address.parse(c.req.param("address"))); return c.json({ ok: true }); });

  app.put("/api/counterparties/:address", async (c) => {
    const a = address.parse(c.req.param("address"));
    if (listWallets(db).some((w) => w.address === a)) throw new Error("address is one of your wallets");
    upsertCounterparty(db, { address: a, ...CounterpartyIn.parse(await c.req.json()) });
    return c.json({ ok: true });
  });
  app.delete("/api/counterparties/:address", (c) => { deleteCounterparty(db, address.parse(c.req.param("address"))); return c.json({ ok: true }); });

  app.get("/api/tokens", (c) => c.json({ tokens: listTokens(db) }));
  app.put("/api/tokens/:chain/:contract", async (c) => {
    const { hidden } = z.object({ hidden: z.boolean() }).parse(await c.req.json());
    setTokenHidden(db, Number(c.req.param("chain")), c.req.param("contract").toLowerCase(), hidden);
    return c.json({ ok: true });
  });

  app.put("/api/annotations/:id", async (c) => {
    setAnnotation(db, c.req.param("id"), AnnotationIn.parse(await c.req.json()));
    return c.json({ ok: true });
  });

  app.post("/api/sync", async (c) => {
    if (syncStatus.running) return c.json({ error: "sync already running" }, 409);
    const { only } = z.object({ only: address.optional() }).parse(await c.req.json().catch(() => ({})));
    syncAll(db, { ...explorer, only }).catch(() => {}); // status/error surface via GET /api/sync
    return c.json({ started: true }, 202);
  });
  app.get("/api/sync", (c) => c.json(syncStatus));

  app.get("/api/ledger", (c) => {
    const rows = filterRows(ledgerRows(loadCtx(db)), parseFilter(c.req.query()));
    const sum = (d: string) => rows.filter((r) => r.direction === d).reduce((s, r) => s + (r.usd ?? 0), 0);
    const flags: Record<string, number> = {};
    for (const r of rows) for (const f of r.flags) flags[f] = (flags[f] ?? 0) + 1;
    return c.json({ rows: rows.reverse(), totals: { count: rows.length, inUsd: sum("in"), outUsd: sum("out"), feeUsd: sum("fee"), flags } });
  });
  app.get("/api/ledger.csv", (c) => {
    const ctx = loadCtx(db);
    const csv = ledgerCsv(ctx, filterRows(ledgerRows(ctx), parseFilter(c.req.query())));
    return c.body(csv, 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="ledger-${new Date().toISOString().slice(0, 10)}.csv"` });
  });

  app.get("/api/graph", (c) => {
    const q = c.req.query();
    const rows = filterRows(ledgerRows(loadCtx(db)), parseFilter(q));
    return c.json(flowGraph(rows, { minUsd: q.minUsd ? Number(q.minUsd) : 0 }));
  });

  app.get("/api/offramps", (c) => {
    const trails = offrampTrails(loadCtx(db));
    return c.json({ trails, issueText: Object.fromEntries(trails.flatMap((t) => t.issues).map((k) => [k, issueText(k)])) });
  });
  app.get("/api/offramps.csv", (c) => {
    const ctx = loadCtx(db);
    return c.body(offrampCsv(ctx, offrampTrails(ctx)), 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="offramp-trails-${new Date().toISOString().slice(0, 10)}.csv"` });
  });

  return app;
}
