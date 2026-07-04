import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// config.ts reads process.env once at import time, so each test needs a fresh module instance.
// Vitest gives each test file its own module registry, and vi.resetModules() forces re-evaluation
// within this file too.
describe("config", () => {
  const ENV_KEYS = ["DAILY_BUDGET_USDC", "PORT"];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    vi.resetModules();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
  });

  it("falls back to the default daily budget when the env var is not a finite number", async () => {
    process.env.DAILY_BUDGET_USDC = "not-a-number";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { config } = await import("../src/config.js");
    expect(config.dailyBudgetUsdc).toBe(5);
    expect(errSpy).toHaveBeenCalled();
  });

  it("falls back to the default port when the env var is not a finite number", async () => {
    process.env.PORT = "not-a-number";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { config } = await import("../src/config.js");
    expect(config.port).toBe(3402);
    expect(errSpy).toHaveBeenCalled();
  });

  it("never lets NaN through for the daily budget (would silently disable the spend guard)", async () => {
    process.env.DAILY_BUDGET_USDC = "NaN";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { config } = await import("../src/config.js");
    expect(Number.isNaN(config.dailyBudgetUsdc)).toBe(false);
  });

  it("uses valid env values when provided", async () => {
    process.env.DAILY_BUDGET_USDC = "10";
    process.env.PORT = "4000";
    const { config } = await import("../src/config.js");
    expect(config.dailyBudgetUsdc).toBe(10);
    expect(config.port).toBe(4000);
  });
});
