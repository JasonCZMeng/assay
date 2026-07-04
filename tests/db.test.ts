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
