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
  it("clamps out-of-range verdicts", async () => {
    expect(await judgeResponse("{...}", "r", mockClient("7"))).toBe(1);
  });
  it("returns null on API failure", async () => {
    expect(await judgeResponse("{...}", "r", mockClient("", true))).toBeNull();
  });
  it("returns null on unparseable verdict", async () => {
    expect(await judgeResponse("{...}", "r", mockClient("great!"))).toBeNull();
  });
});
