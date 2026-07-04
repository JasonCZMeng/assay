import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

let defaultClient: Anthropic | null = null;

export async function judgeResponse(
  excerpt: string,
  rubric: string,
  client?: Anthropic
): Promise<number | null> {
  const c = client ?? (defaultClient ??= new Anthropic({ apiKey: config.anthropicApiKey }));
  try {
    const msg = await c.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content:
            `You are scoring an API response for quality. Rubric: ${rubric}\n\n` +
            `Response excerpt:\n${excerpt.slice(0, 2000)}\n\n` +
            `Reply with ONLY a number from 0.0 (worthless) to 1.0 (excellent).`,
        },
      ],
    });
    const text = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "";
    const n = Number(text.match(/\d+(?:\.\d+)?|\.\d+/)?.[0]);
    if (!Number.isFinite(n)) return null;
    return Math.min(1, Math.max(0, n));
  } catch {
    return null;
  }
}
