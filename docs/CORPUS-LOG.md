# Corpus log

Append-only operator's log of events affecting the evidence corpus or its integrity
records. The corpus itself is append-only by policy; anything that touches history —
migrations, re-anchoring, schema changes to the digest algorithm — gets an entry here,
because an auditor who finds an anomaly deserves the explanation in the open.

## 2026-07-19 — July 15 digest re-sealed (migration skew)

- **What:** the anchored digest for `2026-07-15` was deleted and recomputed over the
  rows present in the production database (16 probes), then re-anchored via
  OpenTimestamps. Its original anchor (created 2026-07-16 15:33 UTC on the Phase L
  home PC, covering 31 probes) no longer corresponded to the database contents.
- **Why:** launch-day skew from the home-PC → VPS migration on 2026-07-16. The July 15
  digest was frozen on the home PC after a second evening sweep (31 rows), but the DB
  snapshot migrated to the VPS carried only the first 16 of those rows. Nothing was
  altered after sealing — the seal and the box were mismatched by the move itself.
- **Evidence reviewed:** the 16 surviving rows are the launch smoke test (21:23–21:25
  UTC, 15 distinct services + initial suverse probe) — the canonical first production
  records. The 15 dropped rows were a redundant later home-PC sweep never migrated.
- **Verification after re-seal:** all anchored days match their rows exactly
  (07-15: 16/16, 07-16: 60/60, 07-17: 90/90, 07-18: 90/90).
- **Recurrence prevention:** `DIGEST_SAFETY_LAG_MS` (2h past day-end before a root is
  frozen) shipped 2026-07-19 in `src/digest.ts`; day iteration is calendar-based
  (DST-safe). Migrations must checkpoint + copy the DB and digests table atomically —
  see deploy/README.md step 3.

## 2026-07-16 — corpus migrated home PC → VPS

- WAL-checkpointed `data/assay.db` copied to `/opt/assay/app/data/` on the VPS;
  home-PC prober decommissioned. VPS (UTC) became authoritative — note this also moved
  digest day boundaries from US/Pacific to UTC from 2026-07-17 onward.

## 2026-07-15 — corpus began

- First live paid probe (suverse BTC feed, $0.001, block 48680639) followed by the
  15-service launch sweep. Probing cadence 3/day, raised to 6/day on 2026-07-16.
