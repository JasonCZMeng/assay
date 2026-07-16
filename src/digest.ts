import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

// Daily corpus digests: a merkle root over each completed local day's probe rows,
// anchored via OpenTimestamps calendar servers (free, Bitcoin-attested). This makes the
// corpus's history provable — a competitor can spend money to replicate breadth, but a
// timestamped root proves OUR rows existed on that date. Also the first brick of Phase C:
// an attestation can later carry a merkle proof that its probe row is in an anchored set.
//
// Canonical leaf: JSON array (stable order, no object-key ambiguity) of the integrity-
// relevant probe columns. response_excerpt is deliberately excluded — response_hash
// already commits to the full body.
// Merkle: sha256 leaves; parent = sha256(left || right); odd node promoted unchanged.

export const OTS_CALENDARS = [
  "https://alice.btc.calendar.opentimestamps.org",
  "https://bob.btc.calendar.opentimestamps.org",
  "https://finney.calendar.eternitywall.com",
];

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();

export function canonicalProbeLeaf(r: any): string {
  return JSON.stringify([
    r.id, r.service_id, r.ts, r.ok_settlement, r.ok_schema, r.gt_deviation_pct,
    r.llm_score, r.http_status, r.latency_ms, r.usdc_cost, r.payment_tx,
    r.response_hash, r.error,
  ]);
}

export function merkleRoot(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) throw new Error("merkleRoot: no leaves");
  let level = leaves;
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? sha256(Buffer.concat([level[i], level[i + 1]])) : level[i]);
    }
    level = next;
  }
  return level[0];
}

export function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function computeDayDigest(
  db: Database.Database,
  day: string
): { root: string; nProbes: number } | null {
  const [y, m, d] = day.split("-").map(Number);
  const start = new Date(y, m - 1, d).getTime();
  const end = new Date(y, m - 1, d + 1).getTime();
  const rows = db
    .prepare("SELECT * FROM probes WHERE ts >= ? AND ts < ? ORDER BY id")
    .all(start, end) as any[];
  if (rows.length === 0) return null;
  const leaves = rows.map((r) => sha256(Buffer.from(canonicalProbeLeaf(r), "utf8")));
  return { root: merkleRoot(leaves).toString("hex"), nProbes: rows.length };
}

export type Anchor = { calendar: string; proof_b64: string; at: number };
export type Stamper = (rootHex: string) => Promise<Anchor[]>;

// Submit the 32-byte digest to each public calendar. The response is the calendar's pending
// attestation (stored as evidence); independently, calendars serve the Bitcoin-upgraded proof
// later at GET <calendar>/timestamp/<hex digest>, so third parties can verify from the root
// alone. Anchoring succeeds if at least one calendar accepts.
export async function otsStamp(rootHex: string, fetchFn: typeof fetch = fetch): Promise<Anchor[]> {
  const digest = Buffer.from(rootHex, "hex");
  const anchors: Anchor[] = [];
  for (const calendar of OTS_CALENDARS) {
    try {
      const res = await fetchFn(`${calendar}/digest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.opentimestamps.v1",
          Accept: "application/vnd.opentimestamps.v1",
        },
        body: digest,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const proof = Buffer.from(await res.arrayBuffer());
      if (proof.length > 0) anchors.push({ calendar, proof_b64: proof.toString("base64"), at: Date.now() });
    } catch {
      // calendar unreachable — others may still succeed
    }
  }
  return anchors;
}

// Digest + anchor every completed local day that needs it. Runs at boot and on a daily cron,
// so days missed while the PC slept are caught up. Idempotent: existing anchored rows are
// untouched; rows that exist but failed to anchor are retried.
export async function anchorMissingDigests(
  db: Database.Database,
  deps: { now?: () => number; stamper?: Stamper } = {}
): Promise<{ digested: string[]; anchored: string[] }> {
  const now = deps.now ?? Date.now;
  const stamper = deps.stamper ?? otsStamp;
  const today = localDay(now());
  const digested: string[] = [];
  const anchored: string[] = [];

  const first: any = db.prepare("SELECT MIN(ts) m FROM probes").get();
  if (!first?.m) return { digested, anchored };

  for (let ts = first.m; localDay(ts) < today; ts += 86_400_000) {
    const day = localDay(ts);
    let row: any = db.prepare("SELECT day, anchors FROM digests WHERE day=?").get(day);
    if (!row) {
      const dg = computeDayDigest(db, day);
      if (!dg) continue; // no probes that day
      db.prepare(
        "INSERT INTO digests (day, root, n_probes, created_at, anchors) VALUES (?,?,?,?,NULL)"
      ).run(day, dg.root, dg.nProbes, now());
      digested.push(day);
      row = { day, anchors: null };
    }
    if (row.anchors == null) {
      const root = (db.prepare("SELECT root FROM digests WHERE day=?").get(day) as any).root;
      const anchors = await stamper(root);
      if (anchors.length > 0) {
        db.prepare("UPDATE digests SET anchors=? WHERE day=?").run(JSON.stringify(anchors), day);
        anchored.push(day);
      }
    }
  }
  return { digested, anchored };
}
