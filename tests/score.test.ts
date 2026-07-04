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
