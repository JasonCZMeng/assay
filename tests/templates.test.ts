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
    const validPayload = {
      serviceId: "https://x.com/a",
      url: "https://x.com/a",
      headers: {},
      responseSchema: { type: "object" },
      method: "DELETE",
    };
    expect(() => saveTemplate(db, validPayload as any)).toThrow();

    // Verify the same payload with valid method does NOT throw
    const validPayloadGet = { ...validPayload, method: "GET" };
    expect(() => saveTemplate(db, validPayloadGet as any)).not.toThrow();
  });
});
