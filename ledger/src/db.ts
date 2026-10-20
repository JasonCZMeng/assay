import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('corporate','personal')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,          -- lowercase 0x…
  label TEXT NOT NULL,
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  chains TEXT NOT NULL,              -- JSON array of chain ids
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS counterparties (
  address TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  grp TEXT,                          -- bubble-map cluster, e.g. "Coinbase"
  category TEXT NOT NULL DEFAULT 'other',
  is_offramp INTEGER NOT NULL DEFAULT 0,
  entity_id INTEGER REFERENCES entities(id), -- external account you control under this entity
  notes TEXT
);
CREATE TABLE IF NOT EXISTS tokens (
  chain_id INTEGER NOT NULL,
  contract TEXT NOT NULL,            -- lowercase address, or 'native'
  symbol TEXT NOT NULL,
  name TEXT,
  decimals INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain_id, contract)
);
CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,               -- chain:tx:kind:index
  chain_id INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  block INTEGER NOT NULL,
  ts INTEGER NOT NULL,               -- unix seconds
  seq INTEGER NOT NULL,              -- ordering within tx
  kind TEXT NOT NULL CHECK (kind IN ('native','internal','erc20','fee')),
  from_addr TEXT NOT NULL,
  to_addr TEXT,                      -- NULL for fee
  contract TEXT NOT NULL,
  amount TEXT NOT NULL               -- raw integer units
);
CREATE INDEX IF NOT EXISTS transfers_ts ON transfers(ts, block, tx_hash, seq);
CREATE INDEX IF NOT EXISTS transfers_from ON transfers(from_addr);
CREATE INDEX IF NOT EXISTS transfers_to ON transfers(to_addr);
CREATE TABLE IF NOT EXISTS annotations (
  transfer_id TEXT PRIMARY KEY,
  category TEXT,
  memo TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS prices (
  coin TEXT NOT NULL,
  hour INTEGER NOT NULL,
  usd REAL,                          -- NULL = looked up, no price
  PRIMARY KEY (coin, hour)
);
CREATE TABLE IF NOT EXISTS sync_cursors (
  address TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  last_block INTEGER NOT NULL,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (address, chain_id, action)
);
`;

export type DB = Database.Database;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

const now = () => Math.floor(Date.now() / 1000);

// ---------- entities ----------
export interface Entity { id: number; name: string; kind: "corporate" | "personal" }

export function listEntities(db: DB): Entity[] {
  return db.prepare("SELECT id, name, kind FROM entities ORDER BY id").all() as Entity[];
}
export function addEntity(db: DB, name: string, kind: Entity["kind"]): number {
  return Number(db.prepare("INSERT INTO entities (name, kind, created_at) VALUES (?, ?, ?)")
    .run(name, kind, now()).lastInsertRowid);
}
export function updateEntity(db: DB, id: number, name: string, kind: Entity["kind"]): void {
  db.prepare("UPDATE entities SET name = ?, kind = ? WHERE id = ?").run(name, kind, id);
}
export function deleteEntity(db: DB, id: number): void {
  const used = db.prepare("SELECT COUNT(*) AS n FROM wallets WHERE entity_id = ?").get(id) as { n: number };
  if (used.n > 0) throw new Error("entity still has wallets");
  db.prepare("UPDATE counterparties SET entity_id = NULL WHERE entity_id = ?").run(id);
  db.prepare("DELETE FROM entities WHERE id = ?").run(id);
}

// ---------- wallets ----------
export interface Wallet { address: string; label: string; entityId: number; chains: number[] }

export function listWallets(db: DB): Wallet[] {
  return (db.prepare("SELECT address, label, entity_id, chains FROM wallets ORDER BY created_at").all() as
    { address: string; label: string; entity_id: number; chains: string }[])
    .map((r) => ({ address: r.address, label: r.label, entityId: r.entity_id, chains: JSON.parse(r.chains) }));
}
export function upsertWallet(db: DB, w: Wallet): void {
  db.prepare(`INSERT INTO wallets (address, label, entity_id, chains, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET label = excluded.label, entity_id = excluded.entity_id, chains = excluded.chains`)
    .run(w.address.toLowerCase(), w.label, w.entityId, JSON.stringify(w.chains), now());
}
export function deleteWallet(db: DB, address: string): void {
  db.prepare("DELETE FROM wallets WHERE address = ?").run(address.toLowerCase());
  db.prepare("DELETE FROM sync_cursors WHERE address = ?").run(address.toLowerCase());
}

// ---------- counterparties ----------
export interface Counterparty {
  address: string; label: string; group: string | null; category: string;
  isOfframp: boolean; entityId: number | null; notes: string | null;
}

export function listCounterparties(db: DB): Counterparty[] {
  return (db.prepare("SELECT * FROM counterparties ORDER BY label").all() as any[]).map((r) => ({
    address: r.address, label: r.label, group: r.grp, category: r.category,
    isOfframp: r.is_offramp === 1, entityId: r.entity_id, notes: r.notes,
  }));
}
export function upsertCounterparty(db: DB, c: Counterparty): void {
  db.prepare(`INSERT INTO counterparties (address, label, grp, category, is_offramp, entity_id, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET label = excluded.label, grp = excluded.grp, category = excluded.category,
      is_offramp = excluded.is_offramp, entity_id = excluded.entity_id, notes = excluded.notes`)
    .run(c.address.toLowerCase(), c.label, c.group, c.category, c.isOfframp ? 1 : 0, c.entityId, c.notes);
}
export function deleteCounterparty(db: DB, address: string): void {
  db.prepare("DELETE FROM counterparties WHERE address = ?").run(address.toLowerCase());
}

// ---------- tokens ----------
export interface Token { chainId: number; contract: string; symbol: string; name: string | null; decimals: number; hidden: boolean }

const SPAM = /(https?:|www\.|\.com|\.io|\.org|\.xyz|\.net|claim|visit|reward|airdrop|t\.me|voucher)/i;

export function isSpammy(symbol: string, name: string | null): boolean {
  return SPAM.test(symbol) || SPAM.test(name ?? "");
}

/** Insert token metadata if unseen; never overrides a user's hidden choice. */
export function ensureToken(db: DB, t: Omit<Token, "hidden">): void {
  db.prepare(`INSERT OR IGNORE INTO tokens (chain_id, contract, symbol, name, decimals, hidden) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(t.chainId, t.contract, t.symbol, t.name, t.decimals, isSpammy(t.symbol, t.name) ? 1 : 0);
}
export function listTokens(db: DB): Token[] {
  return (db.prepare("SELECT * FROM tokens ORDER BY hidden, symbol").all() as any[]).map((r) => ({
    chainId: r.chain_id, contract: r.contract, symbol: r.symbol, name: r.name, decimals: r.decimals, hidden: r.hidden === 1,
  }));
}
export function setTokenHidden(db: DB, chainId: number, contract: string, hidden: boolean): void {
  db.prepare("UPDATE tokens SET hidden = ? WHERE chain_id = ? AND contract = ?").run(hidden ? 1 : 0, chainId, contract);
}

// ---------- transfers ----------
export interface Transfer {
  id: string; chainId: number; txHash: string; block: number; ts: number; seq: number;
  kind: "native" | "internal" | "erc20" | "fee"; from: string; to: string | null; contract: string; amount: string;
}

export function insertTransfers(db: DB, rows: Transfer[]): number {
  const stmt = db.prepare(`INSERT OR IGNORE INTO transfers
    (id, chain_id, tx_hash, block, ts, seq, kind, from_addr, to_addr, contract, amount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  db.transaction(() => {
    for (const r of rows) n += stmt.run(r.id, r.chainId, r.txHash, r.block, r.ts, r.seq, r.kind, r.from, r.to, r.contract, r.amount).changes;
  })();
  return n;
}

/** All transfers touching an owned wallet, chronological. Hidden tokens excluded unless asked. */
export function listTransfers(db: DB, opts: { includeHidden?: boolean } = {}): Transfer[] {
  const rows = db.prepare(`SELECT t.* FROM transfers t
    LEFT JOIN tokens k ON k.chain_id = t.chain_id AND k.contract = t.contract
    WHERE (? = 1 OR COALESCE(k.hidden, 0) = 0)
      AND (t.from_addr IN (SELECT address FROM wallets) OR t.to_addr IN (SELECT address FROM wallets))
    ORDER BY t.ts, t.block, t.chain_id, t.tx_hash, t.seq`).all(opts.includeHidden ? 1 : 0) as any[];
  return rows.map((r) => ({
    id: r.id, chainId: r.chain_id, txHash: r.tx_hash, block: r.block, ts: r.ts, seq: r.seq,
    kind: r.kind, from: r.from_addr, to: r.to_addr, contract: r.contract, amount: r.amount,
  }));
}

// ---------- annotations ----------
export interface Annotation { category: string | null; memo: string | null }

export function listAnnotations(db: DB): Map<string, Annotation> {
  const rows = db.prepare("SELECT transfer_id, category, memo FROM annotations").all() as any[];
  return new Map(rows.map((r) => [r.transfer_id, { category: r.category, memo: r.memo }]));
}
export function setAnnotation(db: DB, transferId: string, a: Annotation): void {
  if (!a.category && !a.memo) {
    db.prepare("DELETE FROM annotations WHERE transfer_id = ?").run(transferId);
    return;
  }
  db.prepare(`INSERT INTO annotations (transfer_id, category, memo, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(transfer_id) DO UPDATE SET category = excluded.category, memo = excluded.memo, updated_at = excluded.updated_at`)
    .run(transferId, a.category, a.memo, now());
}

// ---------- prices ----------
export const hourOf = (ts: number) => Math.floor(ts / 3600) * 3600;

export function priceMap(db: DB): Map<string, number | null> {
  const rows = db.prepare("SELECT coin, hour, usd FROM prices").all() as any[];
  return new Map(rows.map((r) => [`${r.coin}@${r.hour}`, r.usd]));
}
export function savePrices(db: DB, rows: { coin: string; hour: number; usd: number | null }[]): void {
  const stmt = db.prepare("INSERT OR REPLACE INTO prices (coin, hour, usd) VALUES (?, ?, ?)");
  db.transaction(() => { for (const r of rows) stmt.run(r.coin, r.hour, r.usd); })();
}

// ---------- sync cursors ----------
export function getCursor(db: DB, address: string, chainId: number, action: string): number {
  const r = db.prepare("SELECT last_block FROM sync_cursors WHERE address = ? AND chain_id = ? AND action = ?")
    .get(address, chainId, action) as { last_block: number } | undefined;
  return r?.last_block ?? -1;
}
export function setCursor(db: DB, address: string, chainId: number, action: string, block: number): void {
  db.prepare(`INSERT INTO sync_cursors (address, chain_id, action, last_block, synced_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(address, chain_id, action) DO UPDATE SET last_block = excluded.last_block, synced_at = excluded.synced_at`)
    .run(address, chainId, action, block, now());
}
export function lastSyncedAt(db: DB): Map<string, number> {
  const rows = db.prepare("SELECT address, MAX(synced_at) AS at FROM sync_cursors GROUP BY address").all() as any[];
  return new Map(rows.map((r) => [r.address, r.at]));
}
