import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { openDb } from "../src/db.js";
import {
  merkleRoot,
  canonicalProbeLeaf,
  computeDayDigest,
  anchorMissingDigests,
  completedDays,
  localDay,
} from "../src/digest.js";
import { buildApp } from "../src/server.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest();

function seedProbe(db: any, serviceId: string, ts: number) {
  db.prepare(
    "INSERT INTO probes (service_id, ts, ok_settlement, ok_schema, usdc_cost, response_hash) VALUES (?,?,1,1,0.001,'abc')"
  ).run(serviceId, ts);
}

function seedService(db: any, id = "https://svc.example/a") {
  db.prepare(
    "INSERT INTO services (id, domain, status, first_seen, last_seen, raw) VALUES (?,?,?,?,?,?)"
  ).run(id, "svc.example", "curated", 1, 1, "{}");
}

describe("merkleRoot", () => {
  const l1 = sha(Buffer.from("a"));
  const l2 = sha(Buffer.from("b"));
  const l3 = sha(Buffer.from("c"));

  it("single leaf is the root", () => {
    expect(merkleRoot([l1]).equals(l1)).toBe(true);
  });

  it("two leaves hash pairwise", () => {
    expect(merkleRoot([l1, l2]).equals(sha(Buffer.concat([l1, l2])))).toBe(true);
  });

  it("odd leaf is promoted unchanged", () => {
    const expected = sha(Buffer.concat([sha(Buffer.concat([l1, l2])), l3]));
    expect(merkleRoot([l1, l2, l3]).equals(expected)).toBe(true);
  });

  it("is deterministic and order-sensitive", () => {
    expect(merkleRoot([l1, l2]).equals(merkleRoot([l2, l1]))).toBe(false);
  });
});

describe("canonical leaf", () => {
  it("excludes the response excerpt and is stable", () => {
    const row = {
      id: 1, service_id: "s", ts: 2, ok_settlement: 1, ok_schema: null,
      gt_deviation_pct: null, llm_score: 0.5, http_status: 200, latency_ms: 10,
      usdc_cost: 0.001, payment_tx: "0xdead", response_hash: "h", error: null,
      response_excerpt: "SHOULD NOT APPEAR",
    };
    const leaf = canonicalProbeLeaf(row);
    expect(leaf).not.toContain("SHOULD NOT APPEAR");
    expect(leaf).toBe(canonicalProbeLeaf({ ...row, response_excerpt: "other" }));
  });
});

describe("anchorMissingDigests", () => {
  // Fixed "now": two days after an arbitrary probe day, so that day is completed.
  const probeTs = new Date(2026, 6, 10, 12, 0, 0).getTime();
  const nowTs = new Date(2026, 6, 12, 1, 0, 0).getTime();

  it("digests completed days only, anchors via the stamper, and is idempotent", async () => {
    const db = openDb(":memory:");
    seedService(db);
    seedProbe(db, "https://svc.example/a", probeTs);
    seedProbe(db, "https://svc.example/a", probeTs + 1000);
    seedProbe(db, "https://svc.example/a", nowTs - 1000); // "today" — must NOT be digested

    let stamps = 0;
    const stamper = async () => (stamps++, [{ calendar: "https://cal.test", proof_b64: "cHJvb2Y=", at: 1 }]);

    const r1 = await anchorMissingDigests(db, { now: () => nowTs, stamper });
    expect(r1.digested).toEqual([localDay(probeTs)]);
    expect(r1.anchored).toEqual([localDay(probeTs)]);
    expect(stamps).toBe(1);

    const dg = computeDayDigest(db, localDay(probeTs));
    const row: any = db.prepare("SELECT * FROM digests WHERE day=?").get(localDay(probeTs));
    expect(row.root).toBe(dg!.root);
    expect(row.n_probes).toBe(2);
    expect(JSON.parse(row.anchors)[0].calendar).toBe("https://cal.test");

    // second run: nothing new, stamper untouched
    const r2 = await anchorMissingDigests(db, { now: () => nowTs, stamper });
    expect(r2).toEqual({ digested: [], anchored: [] });
    expect(stamps).toBe(1);
  });

  it("retries anchoring when a digest row exists but anchoring previously failed", async () => {
    const db = openDb(":memory:");
    seedService(db);
    seedProbe(db, "https://svc.example/a", probeTs);

    const failing = async () => [] as any[];
    await anchorMissingDigests(db, { now: () => nowTs, stamper: failing });
    let row: any = db.prepare("SELECT anchors FROM digests WHERE day=?").get(localDay(probeTs));
    expect(row.anchors).toBeNull();

    const ok = async () => [{ calendar: "https://cal.test", proof_b64: "cA==", at: 1 }];
    const r = await anchorMissingDigests(db, { now: () => nowTs, stamper: ok });
    expect(r.digested).toEqual([]); // row already existed
    expect(r.anchored).toEqual([localDay(probeTs)]);
    row = db.prepare("SELECT anchors FROM digests WHERE day=?").get(localDay(probeTs));
    expect(JSON.parse(row.anchors)).toHaveLength(1);
  });

  it("serves digests via the API without raw proofs", async () => {
    const db = openDb(":memory:");
    seedService(db);
    seedProbe(db, "https://svc.example/a", probeTs);
    await anchorMissingDigests(db, {
      now: () => nowTs,
      stamper: async () => [{ calendar: "https://cal.test", proof_b64: "cA==", at: 1 }],
    });
    const res = await buildApp(db).request("/api/digests");
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j).toHaveLength(1);
    expect(j[0].n_probes).toBe(1);
    expect(j[0].anchors).toEqual(["https://cal.test"]);
    expect(JSON.stringify(j)).not.toContain("cA==");
  });
});

describe("digest race protection", () => {
  it("does not freeze yesterday inside the safety lag, and captures late-landing rows after it", async () => {
    const db = openDb(":memory:");
    seedService(db);
    const yesterdayNoon = new Date(2026, 6, 10, 12).getTime();
    seedProbe(db, "https://svc.example/a", yesterdayNoon);
    const stamper = async () => [{ calendar: "https://cal.test", proof_b64: "cA==", at: 1 }];

    // 00:30 next day — inside the lag: a midnight-straddling sweep may still be landing rows.
    const justAfterMidnight = new Date(2026, 6, 11, 0, 30).getTime();
    let r = await anchorMissingDigests(db, { now: () => justAfterMidnight, stamper });
    expect(r.digested).toEqual([]);

    // The race: a probe stamped with YESTERDAY's ts lands late (sweep started before midnight).
    seedProbe(db, "https://svc.example/a", new Date(2026, 6, 10, 23, 59, 50).getTime());

    // 02:30 — past the lag: the digest freezes and includes the late row.
    const pastLag = new Date(2026, 6, 11, 2, 30).getTime();
    r = await anchorMissingDigests(db, { now: () => pastLag, stamper });
    expect(r.digested).toEqual([localDay(yesterdayNoon)]);
    const row: any = db
      .prepare("SELECT n_probes FROM digests WHERE day=?")
      .get(localDay(yesterdayNoon));
    expect(row.n_probes).toBe(2); // digest<->DB correspondence intact
  });

  it("iterates calendar days without skips or repeats across a DST-spanning range", () => {
    const start = new Date(2026, 0, 1, 8).getTime(); // Jan 1
    const now = new Date(2026, 3, 10, 12).getTime(); // Apr 10 — spans spring-forward in DST zones
    const days = [...completedDays(start, now)];
    expect(days[0]).toBe("2026-01-01");
    expect(days[days.length - 1]).toBe("2026-04-09");
    expect(new Set(days).size).toBe(days.length); // no repeats
    for (let i = 1; i < days.length; i++) {
      const [y, m, d] = days[i - 1].split("-").map(Number);
      expect(days[i]).toBe(localDay(new Date(y, m - 1, d + 1).getTime())); // exactly +1 calendar day
    }
  });
});
