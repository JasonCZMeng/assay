import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { computeScores, latestScore, tierFor } from "../src/score.js";

const NOW = Date.now();
const DAY = 86_400_000;

function seedProbes(
  db: any,
  id: string,
  n: number,
  opts: { fail?: boolean; timestamps?: number[] } = {}
) {
  db.prepare(
    "INSERT INTO services (id, domain, status, first_seen, last_seen, raw) VALUES (?,?,?,?,?,?)"
  ).run(id, "x", "curated", 1, 1, "{}");
  const ins = db.prepare(
    "INSERT INTO probes (service_id, ts, ok_settlement, ok_schema, gt_deviation_pct, usdc_cost) VALUES (?,?,?,?,?,0.005)"
  );
  for (let i = 0; i < n; i++) {
    const ts = opts.timestamps ? opts.timestamps[i] : NOW - i * 3_600_000;
    ins.run(id, ts, opts.fail ? 0 : 1, opts.fail ? null : 1, opts.fail ? null : 0.5);
  }
}

describe("scorer", () => {
  it("scores a healthy service high", () => {
    const db = openDb(":memory:");
    seedProbes(db, "https://good.example/a", 30);
    expect(computeScores(db, NOW)).toBe(1);
    const s = latestScore(db, "https://good.example/a")!;
    expect(s.composite).toBeGreaterThan(85);
    expect(s.nProbes).toBe(30);
    expect(tierFor(s.composite)).toBe("gold");
  });

  it("returns null composite under 20 probes (cold start)", () => {
    const db = openDb(":memory:");
    seedProbes(db, "https://new.example/a", 5);
    computeScores(db, NOW);
    const s = latestScore(db, "https://new.example/a")!;
    expect(s.composite).toBeNull();
    expect(tierFor(s.composite)).toBe("unrated");
  });

  it("scores a paid-but-denied service near zero", () => {
    const db = openDb(":memory:");
    seedProbes(db, "https://bad.example/a", 30, { fail: true });
    computeScores(db, NOW);
    const s = latestScore(db, "https://bad.example/a")!;
    expect(s.composite).toBeLessThan(20);
    expect(tierFor(s.composite)).toBe("avoid");
  });

  describe("cold-start gate boundary", () => {
    it("exactly 19 probes yields null composite", () => {
      const db = openDb(":memory:");
      seedProbes(db, "https://boundary.example/a", 19);
      computeScores(db, NOW);
      const s = latestScore(db, "https://boundary.example/a")!;
      expect(s.composite).toBeNull();
      expect(s.nProbes).toBe(19);
    });

    it("exactly 20 probes across two days yields non-null composite", () => {
      const db = openDb(":memory:");
      // Explicit timestamps: hourly seeds can land in a single calendar day depending on
      // wall-clock time, which the distinct-day gate rejects — pin two days deterministically.
      const timestamps = Array.from({ length: 20 }, (_, i) => NOW - (i < 10 ? 0 : DAY));
      seedProbes(db, "https://boundary.example/b", 20, { timestamps });
      computeScores(db, NOW);
      const s = latestScore(db, "https://boundary.example/b")!;
      expect(s.composite).not.toBeNull();
      expect(s.nProbes).toBe(20);
    });

    it("20+ probes bursted within a single day stay unrated (across-days gate)", () => {
      const db = openDb(":memory:");
      const timestamps = Array.from({ length: 25 }, () => NOW); // same instant, same day
      seedProbes(db, "https://burst.example/a", 25, { timestamps });
      computeScores(db, NOW);
      const s = latestScore(db, "https://burst.example/a")!;
      expect(s.composite).toBeNull();
      expect(tierFor(s.composite)).toBe("unrated");
    });
  });

  describe("tier boundaries", () => {
    it("tierFor(85) === 'gold'", () => {
      expect(tierFor(85)).toBe("gold");
    });

    it("tierFor(84.99) === 'ok'", () => {
      expect(tierFor(84.99)).toBe("ok");
    });

    it("tierFor(60) === 'ok'", () => {
      expect(tierFor(60)).toBe("ok");
    });

    it("tierFor(59.99) === 'avoid'", () => {
      expect(tierFor(59.99)).toBe("avoid");
    });

    it("tierFor(0) === 'avoid'", () => {
      expect(tierFor(0)).toBe("avoid");
    });

    it("tierFor(null) === 'unrated'", () => {
      expect(tierFor(null)).toBe("unrated");
    });
  });

  describe("trend semantics", () => {
    // trend requires a rated composite (>=20 probes in 30d) AND >=5 probes in 7d — confirmed spec intent
    it("service with 10 total probes (6 within last 7 days) → trend null because composite is null (cold start)", () => {
      const db = openDb(":memory:");
      // Create 10 probes total, with 6 in the last 7 days
      const timestamps: number[] = [];
      // 6 probes in last 7 days
      for (let i = 0; i < 6; i++) {
        timestamps.push(NOW - i * DAY);
      }
      // 4 probes outside last 7 days (but within 30 days)
      for (let i = 0; i < 4; i++) {
        timestamps.push(NOW - (10 + i) * DAY);
      }
      seedProbes(db, "https://trend-test.example/a", 10, { timestamps });
      computeScores(db, NOW);
      const s = latestScore(db, "https://trend-test.example/a")!;
      expect(s.composite).toBeNull(); // cold start (< 20 probes)
      expect(s.trend).toBeNull(); // trend also null because composite is null
    });

    it("service with 25 probes spread so >=5 are in last 7 days → trend non-null", () => {
      const db = openDb(":memory:");
      const timestamps: number[] = [];
      // 5 probes in last 7 days
      for (let i = 0; i < 5; i++) {
        timestamps.push(NOW - i * DAY);
      }
      // 20 probes outside last 7 days (but within 30 days)
      for (let i = 0; i < 20; i++) {
        timestamps.push(NOW - (10 + i) * DAY);
      }
      seedProbes(db, "https://trend-test.example/b", 25, { timestamps });
      computeScores(db, NOW);
      const s = latestScore(db, "https://trend-test.example/b")!;
      expect(s.composite).not.toBeNull(); // rated (>= 20 probes)
      expect(s.trend).not.toBeNull(); // trend calculated (>=5 probes in 7d)
    });

    it("service with 25 probes where only 4 are in last 7 days → trend null", () => {
      const db = openDb(":memory:");
      const timestamps: number[] = [];
      // 4 probes in last 7 days
      for (let i = 0; i < 4; i++) {
        timestamps.push(NOW - i * DAY);
      }
      // 21 probes outside last 7 days (but within 30 days)
      for (let i = 0; i < 21; i++) {
        timestamps.push(NOW - (10 + i) * DAY);
      }
      seedProbes(db, "https://trend-test.example/c", 25, { timestamps });
      computeScores(db, NOW);
      const s = latestScore(db, "https://trend-test.example/c")!;
      expect(s.composite).not.toBeNull(); // rated (>= 20 probes)
      expect(s.trend).toBeNull(); // trend null (< 5 probes in 7d)
    });
  });
});
