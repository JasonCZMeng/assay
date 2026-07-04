# Assay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Phase L (local) Assay quality oracle — a single Node/TypeScript process that ingests the x402 Bazaar catalog, probes curated endpoints as a paying customer, evaluates response quality, computes rolling scores, and serves them via an x402-payable API (payments flag-gated off until Phase H).

**Architecture:** One long-running Node process. node-cron schedules ingest/probe/score jobs; Hono serves the read API; SQLite (better-sqlite3, WAL mode) is the only store; viem + `@x402/fetch` make paid probe calls; `@x402/hono` gates the paid score endpoint. Evaluation is tiered: settlement → schema (ajv) → ground-truth (CoinGecko) → LLM judge (Haiku), cheapest first.

**Tech Stack:** Node ≥ 22, TypeScript (tsx for dev), Hono, better-sqlite3, node-cron, viem, `@x402/fetch` v2, `@x402/hono` v2, ajv, `@anthropic-ai/sdk`, zod, vitest.

## Global Constraints

- All source in `C:\Users\Jason\Coding\assay` (paths below relative to repo root).
- SQLite file lives at `data/assay.db`; `data/` is gitignored. The DB file IS the migration artifact for Phase H — never store secrets in it.
- Secrets only in `.env` (gitignored): `PROBE_WALLET_KEY`, `RECEIVE_WALLET_ADDRESS`, `ANTHROPIC_API_KEY`. Never in code, DB, or logs.
- Spend safety: prober must refuse to start a probe when today's summed `usdc_cost` ≥ `DAILY_BUDGET_USDC` (default 5).
- `PAYMENTS_ENABLED=false` is the default; `/score/:id` returns 402-gated responses only when true (Phase H flag).
- Probes table is append-only: no UPDATE or DELETE statements against `probes` anywhere in the codebase.
- x402 network: Base mainnet (`base`), USDC. Probe wallet holds ≤ $50.
- Commit after every green test cycle. Run `npx tsc --noEmit` before every commit.
- The `@x402/*` v2 API surface should be verified against the installed package README (`npm view @x402/fetch readme`) at Task 6/8 time; if signatures differ from the plan's code, adapt at the call site only — interfaces defined between our own modules must not change.

---

### Task 1: Scaffold, config, and database schema

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `vitest.config.ts`
- Create: `src/config.ts`, `src/db.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `config` object (`src/config.ts`): `{ dbPath: string; dailyBudgetUsdc: number; paymentsEnabled: boolean; probeWalletKey: string; receiveWalletAddress: string; anthropicApiKey: string; port: number }`. `openDb(path?: string): Database.Database` (`src/db.ts`) — opens SQLite, enables WAL, runs idempotent schema creation. All later tasks call `openDb()` and use prepared statements against the tables defined here.

- [ ] **Step 1: Scaffold project**

```bash
cd /c/Users/Jason/Coding/assay
npm init -y
npm i hono better-sqlite3 node-cron viem @x402/fetch @x402/hono ajv @anthropic-ai/sdk zod dotenv
npm i -D typescript tsx vitest @types/node @types/better-sqlite3
```

`package.json` — set:

```json
{
  "name": "assay",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "curate": "tsx src/curate.ts"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

`.gitignore`:

```
node_modules/
data/
dist/
.env
```

`.env.example`:

```
PROBE_WALLET_KEY=0x...
RECEIVE_WALLET_ADDRESS=0x...
ANTHROPIC_API_KEY=sk-ant-...
DAILY_BUDGET_USDC=5
PAYMENTS_ENABLED=false
PORT=3402
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node" } });
```

- [ ] **Step 2: Write failing test for db schema**

`tests/db.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";

describe("db", () => {
  it("creates all tables idempotently", () => {
    const db = openDb(":memory:");
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(["probe_templates", "probes", "scores", "services", "wallets"])
    );
    // idempotent: opening again over same handle must not throw
    expect(() => openDb(":memory:")).not.toThrow();
  });

  it("probes table has no updated_at — append-only by design", () => {
    const db = openDb(":memory:");
    const cols = db.prepare("PRAGMA table_info(probes)").all().map((c: any) => c.name);
    expect(cols).not.toContain("updated_at");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL — cannot find module `../src/db.js`

- [ ] **Step 4: Implement config and db**

`src/config.ts`:

```ts
import "dotenv/config";

export const config = {
  dbPath: process.env.DB_PATH ?? "data/assay.db",
  dailyBudgetUsdc: Number(process.env.DAILY_BUDGET_USDC ?? 5),
  paymentsEnabled: process.env.PAYMENTS_ENABLED === "true",
  probeWalletKey: process.env.PROBE_WALLET_KEY ?? "",
  receiveWalletAddress: process.env.RECEIVE_WALLET_ADDRESS ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  port: Number(process.env.PORT ?? 3402),
};
```

`src/db.ts`:

```ts
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,            -- Bazaar resource URL
  domain TEXT NOT NULL,
  name TEXT,
  category TEXT,
  price_usdc REAL,
  network TEXT,
  status TEXT NOT NULL DEFAULT 'discovered', -- discovered|curated|retired
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  raw TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS probe_templates (
  service_id TEXT PRIMARY KEY REFERENCES services(id),
  method TEXT NOT NULL CHECK (method IN ('GET','POST')),
  url TEXT NOT NULL,
  headers TEXT NOT NULL DEFAULT '{}',
  body TEXT,                       -- JSON string or NULL
  response_schema TEXT NOT NULL,   -- JSON Schema
  ground_truth TEXT,               -- JSON config or NULL
  llm_rubric TEXT,                 -- rubric string or NULL
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS probes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id TEXT NOT NULL REFERENCES services(id),
  ts INTEGER NOT NULL,
  ok_settlement INTEGER NOT NULL,  -- 1|0
  ok_schema INTEGER,               -- 1|0|NULL(not run)
  gt_deviation_pct REAL,           -- NULL if not run
  llm_score REAL,                  -- 0..1, NULL if not run
  http_status INTEGER,
  latency_ms INTEGER,
  usdc_cost REAL NOT NULL DEFAULT 0,
  payment_tx TEXT,
  response_hash TEXT,
  response_excerpt TEXT,           -- first 2000 chars
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_probes_service_ts ON probes(service_id, ts);
CREATE TABLE IF NOT EXISTS scores (
  service_id TEXT NOT NULL REFERENCES services(id),
  ts INTEGER NOT NULL,
  composite REAL,                  -- NULL until n_probes >= 20
  components TEXT NOT NULL,        -- JSON
  n_probes INTEGER NOT NULL,
  trend REAL,
  PRIMARY KEY (service_id, ts)
);
CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('probe','receive')),
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);
`;

export function openDb(path?: string): Database.Database {
  const p = path ?? process.env.DB_PATH ?? "data/assay.db";
  if (p !== ":memory:") mkdirSync(dirname(p), { recursive: true });
  const db = new Database(p);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run tests/db.test.ts && npx tsc --noEmit`
Expected: 2 tests PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: scaffold project with config and sqlite schema"
```

---

### Task 2: Bazaar ingest

**Files:**
- Create: `src/bazaar.ts`
- Test: `tests/bazaar.test.ts`

**Interfaces:**
- Consumes: `openDb()` from Task 1.
- Produces: `ingestBazaar(db: Database.Database, fetchFn?: typeof fetch): Promise<{ upserted: number }>` — pages through the Bazaar discovery API, upserts into `services` (preserving `status` and `first_seen` on existing rows, updating `last_seen`/`raw`). Exported constant `BAZAAR_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources"`.

- [ ] **Step 1: Write failing test**

`tests/bazaar.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { ingestBazaar } from "../src/bazaar.js";

const page = (items: any[], nextOffset?: number) =>
  new Response(JSON.stringify({ items, ...(nextOffset ? { nextOffset } : {}) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const item = (url: string) => ({
  resource: url,
  type: "http",
  x402Version: 2,
  accepts: [{ maxAmountRequired: "5000", network: "base", asset: "USDC" }],
  metadata: { name: "Price API", category: "data" },
});

describe("ingestBazaar", () => {
  it("upserts services and preserves status on re-ingest", async () => {
    const db = openDb(":memory:");
    const fakeFetch = (async () => page([item("https://api.example.com/price")])) as typeof fetch;

    const r1 = await ingestBazaar(db, fakeFetch);
    expect(r1.upserted).toBe(1);

    db.prepare("UPDATE services SET status='curated' WHERE id=?").run(
      "https://api.example.com/price"
    );
    await ingestBazaar(db, fakeFetch);
    const row: any = db
      .prepare("SELECT status, domain, price_usdc FROM services WHERE id=?")
      .get("https://api.example.com/price");
    expect(row.status).toBe("curated"); // not clobbered
    expect(row.domain).toBe("api.example.com");
    expect(row.price_usdc).toBeCloseTo(0.005); // 5000 units of 6-decimal USDC
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bazaar.test.ts`
Expected: FAIL — cannot find module `../src/bazaar.js`

- [ ] **Step 3: Implement**

`src/bazaar.ts`:

```ts
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
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/bazaar.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: One-off live smoke (free, unauthenticated)**

Run: `npx tsx -e "import {openDb} from './src/db.js'; import {ingestBazaar} from './src/bazaar.js'; const db=openDb(); ingestBazaar(db).then(r=>console.log(r, db.prepare('SELECT COUNT(*) c FROM services').get()))"`
Expected: `{ upserted: <hundreds+> } { c: <hundreds+> }`. If the response shape differs from the mocked one (e.g. pagination field name), adjust `ingestBazaar` parsing now and re-run tests.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: bazaar catalog ingest with status-preserving upsert"
```

---

### Task 3: Probe templates and curation CLI

**Files:**
- Create: `src/templates.ts`, `src/curate.ts`
- Test: `tests/templates.test.ts`

**Interfaces:**
- Consumes: `openDb()`.
- Produces: `templates.ts` exports `ProbeTemplate` (zod-inferred type: `{ serviceId: string; method: "GET"|"POST"; url: string; headers: Record<string,string>; body?: string; responseSchema: object; groundTruth?: { path: string; refSource: "coingecko"; refId: string; refField: string; tolerancePct: number }; llmRubric?: string }`), `saveTemplate(db, t: ProbeTemplate): void` (also sets service status to `curated`), `getTemplates(db): ProbeTemplate[]`. `curate.ts` is a CLI (no exports).

- [ ] **Step 1: Write failing test**

`tests/templates.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { saveTemplate, getTemplates } from "../src/templates.js";

function seedService(db: any, id: string) {
  db.prepare(
    "INSERT INTO services (id, domain, status, first_seen, last_seen, raw) VALUES (?,?,?,?,?,?)"
  ).run(id, new URL(id).hostname, "discovered", 1, 1, "{}");
}

describe("templates", () => {
  it("saves a template, marks service curated, round-trips", () => {
    const db = openDb(":memory:");
    seedService(db, "https://api.example.com/price");
    saveTemplate(db, {
      serviceId: "https://api.example.com/price",
      method: "GET",
      url: "https://api.example.com/price?pair=ETH-USD",
      headers: {},
      responseSchema: { type: "object", required: ["price"] },
      groundTruth: {
        path: "price",
        refSource: "coingecko",
        refId: "ethereum",
        refField: "usd",
        tolerancePct: 1.5,
      },
    });
    const status: any = db
      .prepare("SELECT status FROM services WHERE id=?")
      .get("https://api.example.com/price");
    expect(status.status).toBe("curated");
    const [t] = getTemplates(db);
    expect(t.method).toBe("GET");
    expect(t.groundTruth?.refId).toBe("ethereum");
  });

  it("rejects invalid method", () => {
    const db = openDb(":memory:");
    seedService(db, "https://x.com/a");
    expect(() =>
      saveTemplate(db, { serviceId: "https://x.com/a", method: "DELETE" } as any)
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/templates.test.ts`
Expected: FAIL — cannot find module `../src/templates.js`

- [ ] **Step 3: Implement `src/templates.ts`**

```ts
import { z } from "zod";
import type Database from "better-sqlite3";

export const ProbeTemplateSchema = z.object({
  serviceId: z.string().url(),
  method: z.enum(["GET", "POST"]),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().optional(),
  responseSchema: z.record(z.string(), z.unknown()),
  groundTruth: z
    .object({
      path: z.string(), // dot-path into response JSON, e.g. "data.price"
      refSource: z.literal("coingecko"),
      refId: z.string(), // e.g. "ethereum"
      refField: z.string(), // e.g. "usd"
      tolerancePct: z.number().positive(),
    })
    .optional(),
  llmRubric: z.string().optional(),
});
export type ProbeTemplate = z.infer<typeof ProbeTemplateSchema>;

export function saveTemplate(db: Database.Database, input: ProbeTemplate): void {
  const t = ProbeTemplateSchema.parse(input);
  db.prepare(`
    INSERT INTO probe_templates (service_id, method, url, headers, body, response_schema, ground_truth, llm_rubric, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(service_id) DO UPDATE SET
      method=excluded.method, url=excluded.url, headers=excluded.headers, body=excluded.body,
      response_schema=excluded.response_schema, ground_truth=excluded.ground_truth, llm_rubric=excluded.llm_rubric
  `).run(
    t.serviceId, t.method, t.url, JSON.stringify(t.headers), t.body ?? null,
    JSON.stringify(t.responseSchema),
    t.groundTruth ? JSON.stringify(t.groundTruth) : null,
    t.llmRubric ?? null, Date.now()
  );
  db.prepare("UPDATE services SET status='curated' WHERE id=?").run(t.serviceId);
}

export function getTemplates(db: Database.Database): ProbeTemplate[] {
  return db.prepare("SELECT * FROM probe_templates").all().map((r: any) => ({
    serviceId: r.service_id,
    method: r.method,
    url: r.url,
    headers: JSON.parse(r.headers),
    body: r.body ?? undefined,
    responseSchema: JSON.parse(r.response_schema),
    groundTruth: r.ground_truth ? JSON.parse(r.ground_truth) : undefined,
    llmRubric: r.llm_rubric ?? undefined,
  }));
}
```

- [ ] **Step 4: Run tests, typecheck**

Run: `npx vitest run tests/templates.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Implement `src/curate.ts` (CLI, no test — thin I/O shell)**

```ts
// Usage:
//   npm run curate -- list [--category data]     list discovered services
//   npm run curate -- add <serviceId> <templateFile.json>
import { openDb } from "./db.js";
import { saveTemplate, ProbeTemplateSchema } from "./templates.js";
import { readFileSync } from "node:fs";

const db = openDb();
const [cmd, ...args] = process.argv.slice(2);

if (cmd === "list") {
  const rows = db
    .prepare(
      "SELECT id, domain, category, price_usdc FROM services WHERE status='discovered' ORDER BY domain LIMIT 100"
    )
    .all();
  for (const r of rows as any[])
    console.log(`${r.domain}\t$${r.price_usdc ?? "?"}\t${r.category ?? "-"}\t${r.id}`);
} else if (cmd === "add") {
  const [serviceId, file] = args;
  const raw = JSON.parse(readFileSync(file, "utf8"));
  saveTemplate(db, ProbeTemplateSchema.parse({ ...raw, serviceId }));
  console.log(`curated: ${serviceId}`);
} else {
  console.log("commands: list | add <serviceId> <templateFile.json>");
}
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: probe templates with zod validation and curation CLI"
```

---

### Task 4: Deterministic evaluators (T1 schema, T2 ground truth)

**Files:**
- Create: `src/evaluate.ts`
- Test: `tests/evaluate.test.ts`

**Interfaces:**
- Consumes: `ProbeTemplate` from Task 3.
- Produces: `evalSchema(responseJson: unknown, schema: object): boolean`; `evalGroundTruth(responseJson: unknown, gt: NonNullable<ProbeTemplate["groundTruth"]>, fetchFn?: typeof fetch): Promise<number | null>` — returns absolute deviation percent vs reference, or null if reference unavailable; `getPath(obj: unknown, dotPath: string): unknown` (exported for reuse). T0 (settlement) lives in the prober (Task 6) because it is a property of the HTTP/payment exchange, not the payload.

- [ ] **Step 1: Write failing test**

`tests/evaluate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { evalSchema, evalGroundTruth, getPath } from "../src/evaluate.js";

describe("evalSchema", () => {
  const schema = { type: "object", required: ["price"], properties: { price: { type: "number" } } };
  it("passes conforming payload", () => expect(evalSchema({ price: 3021.5 }, schema)).toBe(true));
  it("fails missing field", () => expect(evalSchema({ px: 1 }, schema)).toBe(false));
  it("fails wrong type", () => expect(evalSchema({ price: "3021" }, schema)).toBe(false));
});

describe("getPath", () => {
  it("walks dot paths", () => expect(getPath({ data: { price: 5 } }, "data.price")).toBe(5));
});

describe("evalGroundTruth", () => {
  const gt = { path: "price", refSource: "coingecko" as const, refId: "ethereum", refField: "usd", tolerancePct: 1.5 };
  const cgFetch = (async () =>
    new Response(JSON.stringify({ ethereum: { usd: 3000 } }), { status: 200 })) as typeof fetch;

  it("computes deviation pct", async () => {
    expect(await evalGroundTruth({ price: 3030 }, gt, cgFetch)).toBeCloseTo(1.0);
  });
  it("returns null when reference is down", async () => {
    const down = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    expect(await evalGroundTruth({ price: 3030 }, gt, down)).toBeNull();
  });
  it("returns 100 when value is not a number (worst case, not null)", async () => {
    expect(await evalGroundTruth({ price: "abc" }, gt, cgFetch)).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/evaluate.test.ts`
Expected: FAIL — cannot find module `../src/evaluate.js`

- [ ] **Step 3: Implement `src/evaluate.ts`**

```ts
import { Ajv } from "ajv";
import type { ProbeTemplate } from "./templates.js";

const ajv = new Ajv({ strict: false });

export function evalSchema(responseJson: unknown, schema: object): boolean {
  try {
    return ajv.compile(schema)(responseJson) === true;
  } catch {
    return false;
  }
}

export function getPath(obj: unknown, dotPath: string): unknown {
  return dotPath.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), obj);
}

export async function evalGroundTruth(
  responseJson: unknown,
  gt: NonNullable<ProbeTemplate["groundTruth"]>,
  fetchFn: typeof fetch = fetch
): Promise<number | null> {
  let refValue: number;
  try {
    const res = await fetchFn(
      `https://api.coingecko.com/api/v3/simple/price?ids=${gt.refId}&vs_currencies=${gt.refField}`
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    refValue = Number(data?.[gt.refId]?.[gt.refField]);
    if (!Number.isFinite(refValue) || refValue === 0) return null;
  } catch {
    return null; // reference unavailable — not the service's fault
  }
  const actual = Number(getPath(responseJson, gt.path));
  if (!Number.isFinite(actual)) return 100; // service returned garbage — worst case
  return Math.abs((actual - refValue) / refValue) * 100;
}
```

- [ ] **Step 4: Run tests, typecheck**

Run: `npx vitest run tests/evaluate.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: schema and ground-truth evaluators"
```

---

### Task 5: LLM judge (T3)

**Files:**
- Create: `src/judge.ts`
- Test: `tests/judge.test.ts`

**Interfaces:**
- Consumes: `config` (for API key).
- Produces: `judgeResponse(excerpt: string, rubric: string, client?: Anthropic): Promise<number | null>` — 0..1 usefulness score, null on API failure (never throws). Uses model `claude-haiku-4-5-20251001`, max_tokens 100.

- [ ] **Step 1: Write failing test**

`tests/judge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { judgeResponse } from "../src/judge.js";

const mockClient = (text: string, fail = false) =>
  ({
    messages: {
      create: async () => {
        if (fail) throw new Error("api down");
        return { content: [{ type: "text", text }] };
      },
    },
  }) as any;

describe("judgeResponse", () => {
  it("parses a numeric verdict", async () => {
    expect(await judgeResponse("{...}", "rate usefulness", mockClient("0.8"))).toBe(0.8);
  });
  it("clamps out-of-range verdicts", async () => {
    expect(await judgeResponse("{...}", "r", mockClient("7"))).toBe(1);
  });
  it("returns null on API failure", async () => {
    expect(await judgeResponse("{...}", "r", mockClient("", true))).toBeNull();
  });
  it("returns null on unparseable verdict", async () => {
    expect(await judgeResponse("{...}", "r", mockClient("great!"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/judge.test.ts`
Expected: FAIL — cannot find module `../src/judge.js`

- [ ] **Step 3: Implement `src/judge.ts`**

```ts
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

let defaultClient: Anthropic | null = null;

export async function judgeResponse(
  excerpt: string,
  rubric: string,
  client?: Anthropic
): Promise<number | null> {
  const c = client ?? (defaultClient ??= new Anthropic({ apiKey: config.anthropicApiKey }));
  try {
    const msg = await c.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content:
            `You are scoring an API response for quality. Rubric: ${rubric}\n\n` +
            `Response excerpt:\n${excerpt.slice(0, 2000)}\n\n` +
            `Reply with ONLY a number from 0.0 (worthless) to 1.0 (excellent).`,
        },
      ],
    });
    const text = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "";
    const n = Number(text.match(/[01](?:\.\d+)?|\.\d+/)?.[0]);
    if (!Number.isFinite(n)) return null;
    return Math.min(1, Math.max(0, n));
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests, typecheck**

Run: `npx vitest run tests/judge.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: LLM judge evaluator with haiku"
```

---

### Task 6: Prober (pay, call, evaluate, record) with spend guard

**Files:**
- Create: `src/prober.ts`
- Test: `tests/prober.test.ts`

**Interfaces:**
- Consumes: `getTemplates`, `evalSchema`, `evalGroundTruth`, `judgeResponse`, `openDb`, `config`.
- Produces: `runProbes(db, deps?: { payFetch?: typeof fetch; refFetch?: typeof fetch; judge?: typeof judgeResponse; now?: () => number }): Promise<{ probed: number; skipped: string | null }>` — probes every curated template once, inserts one `probes` row each, returns `skipped: "budget"` without probing when today's spend ≥ budget. `makePayFetch(): typeof fetch` builds the real x402-paying fetch from `config.probeWalletKey` (verify exact `@x402/fetch` v2 signature against its README when implementing; keep the `typeof fetch` return contract).
- `spentTodayUsdc(db, now: number): number` exported for reuse by Task 8's health endpoint.

- [ ] **Step 1: Write failing test**

`tests/prober.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { saveTemplate } from "../src/templates.js";
import { runProbes, spentTodayUsdc } from "../src/prober.js";

function seed(db: any) {
  db.prepare(
    "INSERT INTO services (id, domain, status, price_usdc, first_seen, last_seen, raw) VALUES (?,?,?,?,?,?,?)"
  ).run("https://api.example.com/price", "api.example.com", "discovered", 0.005, 1, 1, "{}");
  saveTemplate(db, {
    serviceId: "https://api.example.com/price",
    method: "GET",
    url: "https://api.example.com/price?pair=ETH-USD",
    headers: {},
    responseSchema: { type: "object", required: ["price"], properties: { price: { type: "number" } } },
    groundTruth: { path: "price", refSource: "coingecko", refId: "ethereum", refField: "usd", tolerancePct: 1.5 },
  });
}

const okPayFetch = (async () =>
  new Response(JSON.stringify({ price: 3030 }), { status: 200 })) as typeof fetch;
const cgFetch = (async () =>
  new Response(JSON.stringify({ ethereum: { usd: 3000 } }), { status: 200 })) as typeof fetch;

describe("runProbes", () => {
  it("records a successful probe with evaluations", async () => {
    const db = openDb(":memory:");
    seed(db);
    const r = await runProbes(db, { payFetch: okPayFetch, refFetch: cgFetch });
    expect(r.probed).toBe(1);
    const p: any = db.prepare("SELECT * FROM probes").get();
    expect(p.ok_settlement).toBe(1);
    expect(p.ok_schema).toBe(1);
    expect(p.gt_deviation_pct).toBeCloseTo(1.0);
    expect(p.usdc_cost).toBeCloseTo(0.005);
  });

  it("records paid-but-denied as data, not an exception", async () => {
    const db = openDb(":memory:");
    seed(db);
    const denyFetch = (async () => new Response("err", { status: 500 })) as typeof fetch;
    const r = await runProbes(db, { payFetch: denyFetch, refFetch: cgFetch });
    expect(r.probed).toBe(1);
    const p: any = db.prepare("SELECT * FROM probes").get();
    expect(p.ok_settlement).toBe(0);
    expect(p.http_status).toBe(500);
  });

  it("halts when daily budget is spent", async () => {
    const db = openDb(":memory:");
    seed(db);
    db.prepare(
      "INSERT INTO probes (service_id, ts, ok_settlement, usdc_cost) VALUES (?,?,1,?)"
    ).run("https://api.example.com/price", Date.now(), 999);
    const r = await runProbes(db, { payFetch: okPayFetch, refFetch: cgFetch });
    expect(r.skipped).toBe("budget");
    expect(r.probed).toBe(0);
    expect(spentTodayUsdc(db, Date.now())).toBe(999);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/prober.test.ts`
Expected: FAIL — cannot find module `../src/prober.js`

- [ ] **Step 3: Implement `src/prober.ts`**

```ts
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { config } from "./config.js";
import { getTemplates, type ProbeTemplate } from "./templates.js";
import { evalSchema, evalGroundTruth } from "./evaluate.js";
import { judgeResponse } from "./judge.js";

export function spentTodayUsdc(db: Database.Database, now: number): number {
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  const r: any = db
    .prepare("SELECT COALESCE(SUM(usdc_cost),0) s FROM probes WHERE ts >= ?")
    .get(dayStart);
  return r.s;
}

// Real paying fetch. VERIFY the @x402/fetch v2 signature against
// `npm view @x402/fetch readme` before first live run; adapt ONLY inside
// this function — it must keep returning a standard `typeof fetch`.
export function makePayFetch(): typeof fetch {
  // Expected v2 shape:
  //   import { wrapFetchWithPayment } from "@x402/fetch";
  //   import { privateKeyToAccount } from "viem/accounts";
  //   return wrapFetchWithPayment(fetch, privateKeyToAccount(config.probeWalletKey as `0x${string}`));
  const { wrapFetchWithPayment } = require("@x402/fetch");
  const { privateKeyToAccount } = require("viem/accounts");
  return wrapFetchWithPayment(fetch, privateKeyToAccount(config.probeWalletKey as `0x${string}`));
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
  const payFetch = deps.payFetch ?? makePayFetch();
  const judge = deps.judge ?? judgeResponse;

  if (spentTodayUsdc(db, now()) >= config.dailyBudgetUsdc) {
    console.error(`[prober] daily budget reached — halting`);
    return { probed: 0, skipped: "budget" };
  }

  const insert = db.prepare(`
    INSERT INTO probes (service_id, ts, ok_settlement, ok_schema, gt_deviation_pct, llm_score,
                        http_status, latency_ms, usdc_cost, response_hash, response_excerpt, error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  let probed = 0;
  for (const t of getTemplates(db)) {
    const price: any = db.prepare("SELECT price_usdc FROM services WHERE id=?").get(t.serviceId);
    const cost = price?.price_usdc ?? 0;
    const started = now();
    let status: number | null = null;
    let body = "";
    let error: string | null = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      const res = await payFetch(t.url, {
        method: t.method,
        headers: t.headers,
        body: t.method === "POST" ? t.body : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);
      status = res.status;
      body = await res.text();
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
      okSettlement ? cost : cost, // payment may settle even on failure — charge conservatively
      createHash("sha256").update(body).digest("hex"), body.slice(0, 2000), error
    );
    probed++;
  }
  return { probed, skipped: null };
}
```

Note: `require` inside ESM will fail — implement `makePayFetch` with a top-level `import { wrapFetchWithPayment } from "@x402/fetch"` and `import { privateKeyToAccount } from "viem/accounts"` instead; the inline comment shows intent. Tests never call `makePayFetch` (they inject `payFetch`).

- [ ] **Step 4: Run tests, typecheck**

Run: `npx vitest run tests/prober.test.ts && npx tsc --noEmit`
Expected: PASS (3 tests). Fix the `require` → `import` note from Step 3 if tsc complains.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: prober with tiered evaluation and daily spend guard"
```

---

### Task 7: Scorer

**Files:**
- Create: `src/score.ts`
- Test: `tests/score.test.ts`

**Interfaces:**
- Consumes: `openDb`; reads `probes`, writes `scores`.
- Produces: `computeScores(db, now?: number): number` (services scored, returns count); `latestScore(db, serviceId): { composite: number | null; components: Record<string, number | null>; nProbes: number; trend: number | null; ts: number } | null`; `tierFor(composite: number | null): "gold" | "ok" | "avoid" | "unrated"` (gold ≥ 85, ok ≥ 60, avoid < 60, unrated when composite null).

Composite formula over trailing 30 days (min 20 probes, else composite = null):
`composite = 100 × (0.4·settlementRate + 0.3·schemaRate + 0.2·gtScore + 0.1·llmAvg)` where
`gtScore = clamp(1 − avgDeviationPct/tolerance-free-cap(10%), 0, 1)`; components missing from every probe redistribute their weight proportionally to present components. `trend = composite(last 7d probes) − composite(full 30d window)`, null under 5 probes in the 7d window.

- [ ] **Step 1: Write failing test**

`tests/score.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { computeScores, latestScore, tierFor } from "../src/score.js";

function seedProbes(db: any, id: string, n: number, opts: { fail?: boolean } = {}) {
  db.prepare(
    "INSERT INTO services (id, domain, status, first_seen, last_seen, raw) VALUES (?,?,?,?,?,?)"
  ).run(id, "x", "curated", 1, 1, "{}");
  const ins = db.prepare(
    "INSERT INTO probes (service_id, ts, ok_settlement, ok_schema, gt_deviation_pct, usdc_cost) VALUES (?,?,?,?,?,0.005)"
  );
  for (let i = 0; i < n; i++)
    ins.run(id, Date.now() - i * 3_600_000, opts.fail ? 0 : 1, opts.fail ? null : 1, opts.fail ? null : 0.5);
}

describe("scorer", () => {
  it("scores a healthy service high", () => {
    const db = openDb(":memory:");
    seedProbes(db, "https://good.example/a", 30);
    expect(computeScores(db)).toBe(1);
    const s = latestScore(db, "https://good.example/a")!;
    expect(s.composite).toBeGreaterThan(85);
    expect(s.nProbes).toBe(30);
    expect(tierFor(s.composite)).toBe("gold");
  });

  it("returns null composite under 20 probes (cold start)", () => {
    const db = openDb(":memory:");
    seedProbes(db, "https://new.example/a", 5);
    computeScores(db);
    const s = latestScore(db, "https://new.example/a")!;
    expect(s.composite).toBeNull();
    expect(tierFor(s.composite)).toBe("unrated");
  });

  it("scores a paid-but-denied service near zero", () => {
    const db = openDb(":memory:");
    seedProbes(db, "https://bad.example/a", 30, { fail: true });
    computeScores(db);
    const s = latestScore(db, "https://bad.example/a")!;
    expect(s.composite).toBeLessThan(20);
    expect(tierFor(s.composite)).toBe("avoid");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/score.test.ts`
Expected: FAIL — cannot find module `../src/score.js`

- [ ] **Step 3: Implement `src/score.ts`**

```ts
import type Database from "better-sqlite3";

const DAY = 86_400_000;
const GT_CAP_PCT = 10; // deviation ≥ 10% scores 0 on the gt component

type Row = {
  ok_settlement: number;
  ok_schema: number | null;
  gt_deviation_pct: number | null;
  llm_score: number | null;
};

function composite(rows: Row[]): { value: number; components: Record<string, number | null> } {
  const rate = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const settlement = rate(rows.map((r) => r.ok_settlement));
  const schema = rate(rows.filter((r) => r.ok_schema !== null).map((r) => r.ok_schema!));
  const gtDevs = rows.filter((r) => r.gt_deviation_pct !== null).map((r) => r.gt_deviation_pct!);
  const gt = gtDevs.length
    ? Math.max(0, Math.min(1, 1 - rate(gtDevs)! / GT_CAP_PCT))
    : null;
  const llm = rate(rows.filter((r) => r.llm_score !== null).map((r) => r.llm_score!));

  const parts: [number | null, number][] = [[settlement, 0.4], [schema, 0.3], [gt, 0.2], [llm, 0.1]];
  const present = parts.filter(([v]) => v !== null) as [number, number][];
  const wTotal = present.reduce((a, [, w]) => a + w, 0);
  const value = wTotal === 0 ? 0 : (present.reduce((a, [v, w]) => a + v * w, 0) / wTotal) * 100;
  return { value, components: { settlement, schema, groundTruth: gt, llm } };
}

export function computeScores(db: Database.Database, now: number = Date.now()): number {
  const services = db.prepare("SELECT id FROM services WHERE status='curated'").all() as { id: string }[];
  const getRows = db.prepare(
    "SELECT ok_settlement, ok_schema, gt_deviation_pct, llm_score, ts FROM probes WHERE service_id=? AND ts >= ?"
  );
  const insert = db.prepare(
    "INSERT OR REPLACE INTO scores (service_id, ts, composite, components, n_probes, trend) VALUES (?,?,?,?,?,?)"
  );
  let count = 0;
  for (const { id } of services) {
    const rows = getRows.all(id, now - 30 * DAY) as (Row & { ts: number })[];
    const full = composite(rows);
    const recent = rows.filter((r) => r.ts >= now - 7 * DAY);
    const comp = rows.length >= 20 ? full.value : null;
    const trend = comp !== null && recent.length >= 5 ? composite(recent).value - full.value : null;
    insert.run(id, now, comp, JSON.stringify(full.components), rows.length, trend);
    count++;
  }
  return count;
}

export function latestScore(db: Database.Database, serviceId: string) {
  const r: any = db
    .prepare("SELECT * FROM scores WHERE service_id=? ORDER BY ts DESC LIMIT 1")
    .get(serviceId);
  if (!r) return null;
  return {
    composite: r.composite,
    components: JSON.parse(r.components),
    nProbes: r.n_probes,
    trend: r.trend,
    ts: r.ts,
  };
}

export function tierFor(composite: number | null): "gold" | "ok" | "avoid" | "unrated" {
  if (composite === null) return "unrated";
  if (composite >= 85) return "gold";
  if (composite >= 60) return "ok";
  return "avoid";
}
```

- [ ] **Step 4: Run tests, typecheck**

Run: `npx vitest run tests/score.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: rolling 30-day scorer with cold-start gate and tiers"
```

---

### Task 8: HTTP server (free tier, paid score, leaderboard, health)

**Files:**
- Create: `src/server.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `latestScore`, `tierFor`, `spentTodayUsdc`, `config`.
- Produces: `buildApp(db): Hono` — routes:
  - `GET /tier/:id` (id = URL-encoded service id) → `{ service, tier }`, `Cache-Control: public, max-age=3600`. Free always.
  - `GET /score/:id` → full `{ service, composite, components, nProbes, trend, ts }`. When `config.paymentsEnabled`, wrapped by `@x402/hono` `paymentMiddleware` at $0.005 to `config.receiveWalletAddress` on `base`; otherwise open (Phase L).
  - `GET /leaderboard` → HTML table of curated services ordered by composite desc.
  - `GET /healthz` → `{ ok: true, spentToday, services, probes24h }`.
  - Unknown service id → 404 `{ error: "unknown service" }`.

- [ ] **Step 1: Write failing test**

`tests/server.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { computeScores } from "../src/score.js";
import { buildApp } from "../src/server.js";

function seed(db: any) {
  db.prepare(
    "INSERT INTO services (id, domain, status, first_seen, last_seen, raw) VALUES (?,?,?,?,?,?)"
  ).run("https://good.example/a", "good.example", "curated", 1, 1, "{}");
  const ins = db.prepare(
    "INSERT INTO probes (service_id, ts, ok_settlement, ok_schema, usdc_cost) VALUES (?,?,1,1,0.005)"
  );
  for (let i = 0; i < 25; i++) ins.run("https://good.example/a", Date.now() - i * 3600_000);
  computeScores(db);
}

describe("server", () => {
  it("serves free tier labels", async () => {
    const db = openDb(":memory:");
    seed(db);
    const app = buildApp(db);
    const res = await app.request(`/tier/${encodeURIComponent("https://good.example/a")}`);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.tier).toBe("gold");
    expect(res.headers.get("cache-control")).toContain("max-age=3600");
  });

  it("serves full score when payments disabled (Phase L)", async () => {
    const db = openDb(":memory:");
    seed(db);
    const app = buildApp(db);
    const res = await app.request(`/score/${encodeURIComponent("https://good.example/a")}`);
    const j: any = await res.json();
    expect(j.composite).toBeGreaterThan(85);
    expect(j.components).toBeDefined();
  });

  it("404s unknown services", async () => {
    const db = openDb(":memory:");
    const app = buildApp(db);
    const res = await app.request(`/score/${encodeURIComponent("https://nope.example/x")}`);
    expect(res.status).toBe(404);
  });

  it("healthz reports counts", async () => {
    const db = openDb(":memory:");
    seed(db);
    const res = await buildApp(db).request("/healthz");
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.services).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — cannot find module `../src/server.js`

- [ ] **Step 3: Implement `src/server.ts`**

```ts
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { config } from "./config.js";
import { latestScore, tierFor } from "./score.js";
import { spentTodayUsdc } from "./prober.js";

export function buildApp(db: Database.Database): Hono {
  const app = new Hono();

  if (config.paymentsEnabled) {
    // Phase H: gate /score behind x402. VERIFY exact @x402/hono v2 API via
    // `npm view @x402/hono readme` when enabling; adapt only this block.
    const { paymentMiddleware } = await import("@x402/hono"); // move to top-level import when enabling
    app.use(
      "/score/*",
      paymentMiddleware(
        { "/score/*": { price: "$0.005", network: "base" } },
        { address: config.receiveWalletAddress }
      )
    );
  }

  app.get("/tier/:id", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const s = latestScore(db, id);
    if (!s) return c.json({ error: "unknown service" }, 404);
    c.header("Cache-Control", "public, max-age=3600");
    return c.json({ service: id, tier: tierFor(s.composite) });
  });

  app.get("/score/:id", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const s = latestScore(db, id);
    if (!s) return c.json({ error: "unknown service" }, 404);
    return c.json({ service: id, ...s });
  });

  app.get("/leaderboard", (c) => {
    const rows = db
      .prepare(
        `SELECT s.service_id, s.composite, s.n_probes, sv.domain
         FROM scores s JOIN services sv ON sv.id = s.service_id
         WHERE s.ts = (SELECT MAX(ts) FROM scores WHERE service_id = s.service_id)
         ORDER BY s.composite DESC NULLS LAST`
      )
      .all() as any[];
    const tr = rows
      .map(
        (r) =>
          `<tr><td>${r.domain}</td><td>${r.composite?.toFixed(1) ?? "unrated"}</td><td>${tierFor(r.composite)}</td><td>${r.n_probes}</td></tr>`
      )
      .join("");
    return c.html(
      `<!doctype html><title>Assay Leaderboard</title><h1>Assay — x402 Quality Scores</h1>
       <table border=1 cellpadding=6><tr><th>Service</th><th>Score</th><th>Tier</th><th>Probes</th></tr>${tr}</table>`
    );
  });

  app.get("/healthz", (c) => {
    const services = (db.prepare("SELECT COUNT(*) c FROM services WHERE status='curated'").get() as any).c;
    const probes24h = (db
      .prepare("SELECT COUNT(*) c FROM probes WHERE ts >= ?")
      .get(Date.now() - 86_400_000) as any).c;
    return c.json({ ok: true, spentToday: spentTodayUsdc(db, Date.now()), services, probes24h });
  });

  return app;
}
```

Note: the `await import` inside a non-async function is illustrative of the Phase-H block; since `paymentsEnabled` is false throughout Phase L, implement it as a top-level static import guarded by the flag, and confirm the middleware signature when flipping the flag.

- [ ] **Step 4: Run tests, typecheck**

Run: `npx vitest run tests/server.test.ts && npx tsc --noEmit`
Expected: PASS (4 tests). If `NULLS LAST` is unsupported by the SQLite version, use `ORDER BY s.composite IS NULL, s.composite DESC`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: hono server with tier/score/leaderboard/healthz"
```

---

### Task 9: Entry point, cron wiring, Phase L runbook

**Files:**
- Create: `src/index.ts`, `README.md`
- Test: full suite only (wiring is thin; jobs are already tested units)

**Interfaces:**
- Consumes: everything above.
- Produces: `npm run dev` starts: server on `config.port`; ingest hourly (`0 * * * *`); probes 3×/day with jitter (base crons `15 6 * * *`, `15 13 * * *`, `15 21 * * *`, each delayed by `Math.random()*3600_000` ms); scoring after each probe run.

- [ ] **Step 1: Implement `src/index.ts`**

```ts
import { serve } from "@hono/node-server"; // npm i @hono/node-server
import cron from "node-cron";
import { openDb } from "./db.js";
import { config } from "./config.js";
import { ingestBazaar } from "./bazaar.js";
import { runProbes } from "./prober.js";
import { computeScores } from "./score.js";
import { buildApp } from "./server.js";

const db = openDb();

cron.schedule("0 * * * *", () =>
  ingestBazaar(db).then((r) => console.log(`[ingest] upserted ${r.upserted}`))
    .catch((e) => console.error("[ingest]", e))
);

async function probeAndScore() {
  const jitterMs = Math.random() * 3_600_000; // anti-fingerprinting jitter
  await new Promise((r) => setTimeout(r, jitterMs));
  const r = await runProbes(db).catch((e) => (console.error("[probe]", e), null));
  if (r) console.log(`[probe] probed=${r.probed} skipped=${r.skipped ?? "no"}`);
  console.log(`[score] scored ${computeScores(db)} services`);
}
for (const c of ["15 6 * * *", "15 13 * * *", "15 21 * * *"]) cron.schedule(c, probeAndScore);

serve({ fetch: buildApp(db).fetch, port: config.port }, (i) =>
  console.log(`[assay] listening on :${i.port} payments=${config.paymentsEnabled}`)
);
```

Run: `npm i @hono/node-server` first.

- [ ] **Step 2: Run full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS.

- [ ] **Step 3: Boot smoke test**

Run: `npm run dev` (then Ctrl+C after verifying)
Expected: `[assay] listening on :3402 payments=false`; `curl http://localhost:3402/healthz` returns `{"ok":true,...}`.

- [ ] **Step 4: Write `README.md` (Phase L runbook)**

```markdown
# Assay — x402 Quality Oracle

See SUMMARY.md (what/why) and docs/specs/ (design).

## Phase L: run locally (Windows)

1. `cp .env.example .env`, fill in:
   - PROBE_WALLET_KEY: fresh wallet, fund with ≤ $50 USDC on Base + ~$2 ETH for gas
   - ANTHROPIC_API_KEY (LLM judge)
2. `npm install && npm test`
3. `npm run dev` once; let ingest populate, then curate:
   - `npm run curate -- list`
   - write a template JSON (see docs/templates/example.json), then
     `npm run curate -- add <serviceUrl> template.json`
   - start with 10–20 endpoints; grow toward 200 as templates prove out
4. Keep it running 24/7: `npx pm2 start "npm run dev" --name assay`
   and `npx pm2 save`; or Windows Task Scheduler "At startup" task.
5. Watch spend: `curl localhost:3402/healthz` → `spentToday`.

## Phase H: go public (later)

1. $5–10/mo VPS (Hetzner CAX11 / Railway / Fly).
2. Stop local process; copy repo + `data/assay.db` to VPS; `npm ci`; run under pm2.
3. Domain + Caddy for TLS → reverse proxy :3402.
4. Set `PAYMENTS_ENABLED=true` + `RECEIVE_WALLET_ADDRESS` (separate wallet);
   verify @x402/hono middleware signature; live-test one paid call.
5. List Assay itself in the x402 Bazaar; publish leaderboard URL.
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: process entry with cron wiring and Phase L runbook"
```

---

### Task 10: First live probe (manual gate — real money, ~$0.05)

**Files:**
- Create: `docs/templates/example.json` (first real template)

No code changes; this task validates the `@x402/fetch` integration against a real Base-mainnet endpoint before trusting the prober unattended.

- [ ] **Step 1: Verify SDK surface**

Run: `npm view @x402/fetch readme | head -60`
Expected: usage example. If `wrapFetchWithPayment`'s v2 signature differs from `makePayFetch`'s expectation, fix `makePayFetch` now (call-site only), re-run `npx vitest run`.

- [ ] **Step 2: Fund the probe wallet**

Create a fresh wallet; send it $10 USDC on Base and ~$2 of ETH. Put the key in `.env` `PROBE_WALLET_KEY`. Record the address in the `wallets` table:
`npx tsx -e "import {openDb} from './src/db.js'; openDb().prepare('INSERT OR IGNORE INTO wallets (address,purpose,created_at) VALUES (?,?,?)').run('0xYOURADDR','probe',Date.now())"`

- [ ] **Step 3: Curate one known-good cheap endpoint**

Pick a price-category endpoint from `npm run curate -- list` with price ≤ $0.01 and a recognizable domain. Write `docs/templates/example.json` with its real URL, a minimal schema (`{"type":"object"}` to start), and ground truth if it serves a major asset price. `npm run curate -- add <url> docs/templates/example.json`.

- [ ] **Step 4: Run one live probe**

Run: `npx tsx -e "import {openDb} from './src/db.js'; import {runProbes} from './src/prober.js'; runProbes(openDb()).then(console.log)"`
Expected: `{ probed: 1, skipped: null }`; then
`npx tsx -e "import {openDb} from './src/db.js'; console.log(openDb().prepare('SELECT service_id, ok_settlement, ok_schema, http_status, usdc_cost FROM probes ORDER BY id DESC LIMIT 1').get())"`
shows `ok_settlement: 1` and plausible cost. Check the wallet on Basescan — exactly one USDC transfer of the advertised price.

- [ ] **Step 5: Commit and tag**

```bash
git add -A && git commit -m "feat: first live probe validated on Base mainnet"
git tag v0.1-phase-l
```

---

## Out of scope for this plan (deliberately)

- **ERC-8004 attestor** — post-MVP per design (Draft-status standard, small registered intersection). Plan it when Phase H is live.
- **Wallet rotation automation** — manual rotation (new key in `.env`, new `wallets` row) is fine at this scale.
- **Operator subscriptions / B & A product phases** — after revenue signal from per-call scores.

## Self-review notes

- Spec coverage: ingest ✓ (T2), curation ✓ (T3), tiered evaluation ✓ (T4–T6), append-only probes ✓ (schema + constraint note), scoring with cold-start gate ✓ (T7), free/paid API + leaderboard ✓ (T8), spend guard ✓ (T6), jitter ✓ (T9), Phase L→H hosting ✓ (T9 runbook), live validation gate ✓ (T10). Attestor explicitly deferred, matching design.
- Known verification points called out inline (Bazaar pagination field, @x402 v2 signatures) with adapt-at-call-site-only instructions.
