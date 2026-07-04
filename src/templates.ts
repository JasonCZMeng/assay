import { z } from "zod";
import type Database from "better-sqlite3";

export const ProbeTemplateSchema = z.object({
  serviceId: z.string().url(),
  method: z.enum(["GET", "POST"]),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().optional(),
  responseSchema: z.record(z.string(), z.unknown()),
  groundTruth: z
    .object({
      path: z.string(), // dot-path into response JSON, e.g. "data.price"
      refSource: z.literal("coingecko"),
      refId: z.string(), // e.g. "ethereum"
      refField: z.string(), // e.g. "usd"
      tolerancePct: z.number().positive(),
    })
    .optional(),
  llmRubric: z.string().optional(),
});
export type ProbeTemplate = z.infer<typeof ProbeTemplateSchema>;

export function saveTemplate(db: Database.Database, input: ProbeTemplate): void {
  const t = ProbeTemplateSchema.parse(input);
  db.prepare(`
    INSERT INTO probe_templates (service_id, method, url, headers, body, response_schema, ground_truth, llm_rubric, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(service_id) DO UPDATE SET
      method=excluded.method, url=excluded.url, headers=excluded.headers, body=excluded.body,
      response_schema=excluded.response_schema, ground_truth=excluded.ground_truth, llm_rubric=excluded.llm_rubric
  `).run(
    t.serviceId, t.method, t.url, JSON.stringify(t.headers), t.body ?? null,
    JSON.stringify(t.responseSchema),
    t.groundTruth ? JSON.stringify(t.groundTruth) : null,
    t.llmRubric ?? null, Date.now()
  );
  db.prepare("UPDATE services SET status='curated' WHERE id=?").run(t.serviceId);
}

export function getTemplates(db: Database.Database): ProbeTemplate[] {
  return db.prepare("SELECT * FROM probe_templates").all().map((r: any) => ({
    serviceId: r.service_id,
    method: r.method,
    url: r.url,
    headers: JSON.parse(r.headers),
    body: r.body ?? undefined,
    responseSchema: JSON.parse(r.response_schema),
    groundTruth: r.ground_truth ? JSON.parse(r.ground_truth) : undefined,
    llmRubric: r.llm_rubric ?? undefined,
  }));
}
