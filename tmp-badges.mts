// Rasterize the four badge variants at 1x and 2x for visual review.
import sharp from "file:///C:/Users/Jason/AppData/Local/Temp/claude/C--Users-Jason-Coding-assay/74b6c68d-c85d-4b15-b838-d2701478115d/scratchpad/node_modules/sharp/lib/index.js";
import { renderBadge } from "./src/badge.js";

const variants = [renderBadge(94.3, 41), renderBadge(72.0, 40), renderBadge(41.5, 21), renderBadge(null, 13)];
const rendered = [];
let y = 16, maxW = 0;
for (const svg of variants) {
  const buf = await sharp(Buffer.from(svg), { density: 144 }).png().toBuffer();
  const meta = await sharp(buf).metadata();
  rendered.push({ buf, y, h: meta.height });
  maxW = Math.max(maxW, meta.width);
  y += meta.height + 14;
}
await sharp({ create: { width: maxW + 32, height: y + 2, channels: 3, background: "#efe9da" } })
  .composite(rendered.map((r) => ({ input: r.buf, left: 16, top: r.y })))
  .png()
  .toFile("C:/Users/Jason/AppData/Local/Temp/claude/C--Users-Jason-Coding-assay/74b6c68d-c85d-4b15-b838-d2701478115d/scratchpad/badges-check.png");
console.log("badges-check.png written");
