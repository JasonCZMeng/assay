// Usage:
//   npm run curate -- list [--category data]     list discovered services
//   npm run curate -- add <serviceId> <templateFile.json>
import { openDb } from "./db.js";
import { saveTemplate, ProbeTemplateSchema } from "./templates.js";
import { readFileSync } from "node:fs";

const db = openDb();
const [cmd, ...args] = process.argv.slice(2);

if (cmd === "list") {
  const rows = db
    .prepare(
      "SELECT id, domain, category, price_usdc FROM services WHERE status='discovered' ORDER BY domain LIMIT 100"
    )
    .all();
  for (const r of rows as any[])
    console.log(`${r.domain}\t$${r.price_usdc ?? "?"}\t${r.category ?? "-"}\t${r.id}`);
} else if (cmd === "add") {
  const [serviceId, file] = args;
  const raw = JSON.parse(readFileSync(file, "utf8"));
  saveTemplate(db, ProbeTemplateSchema.parse({ ...raw, serviceId }));
  console.log(`curated: ${serviceId}`);
} else {
  console.log("commands: list | add <serviceId> <templateFile.json>");
}
