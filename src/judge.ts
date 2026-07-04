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
    // Accept ONLY a standalone decimal in [0,1]: whole match against anchored pattern
    if (!/^(0(\.\d+)?|1(\.0+)?|\.\d+)$/.test(text)) return null;
    return Number(text);
  } catch {
    return null;
  }
}
