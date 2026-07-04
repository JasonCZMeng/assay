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
