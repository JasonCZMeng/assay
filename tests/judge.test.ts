import { describe, it, expect } from "vitest";
import { judgeResponse } from "../src/judge.js";

const mockClient = (text: string, fail = false) =>
  ({
    messages: {
      create: async () => {
        if (fail) throw new Error("api down");
        return { content: [{ type: "text", text }] };
      },
    },
  }) as any;

describe("judgeResponse", () => {
  it("parses a numeric verdict", async () => {
    expect(await judgeResponse("{...}", "rate usefulness", mockClient("0.8"))).toBe(0.8);
  });
  it("parses a decimal-only verdict", async () => {
    expect(await judgeResponse("{...}", "r", mockClient(".5"))).toBe(0.5);
  });
  it("returns null for out-of-range verdicts", async () => {
    // fail-safe semantics per user ruling 2026-07-04: out-of-range → null
    expect(await judgeResponse("{...}", "r", mockClient("7"))).toBeNull();
  });
  it("returns null for multi-digit out-of-range verdicts", async () => {
    expect(await judgeResponse("{...}", "r", mockClient("85"))).toBeNull();
  });
  it("returns null on API failure", async () => {
    expect(await judgeResponse("{...}", "r", mockClient("", true))).toBeNull();
  });
  it("returns null on unparseable verdict", async () => {
    expect(await judgeResponse("{...}", "r", mockClient("great!"))).toBeNull();
  });
});
