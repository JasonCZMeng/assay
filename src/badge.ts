import { tierFor } from "./score.js";

// Embeddable tier badge — a miniature of the site's "assay certificate" system: the ingot
// mark, a struck verdict, the live composite. Served from our domain so the badge always
// shows the CURRENT tier — a badge that can downgrade is a badge worth trusting.
// Self-contained SVG: no webfonts (generic mono stack), no external refs.

const COLORS: Record<string, { fg: string; label: string }> = {
  gold: { fg: "#dfa939", label: "GOLD" },
  ok: { fg: "#efe9da", label: "OK" },
  avoid: { fg: "#c8442e", label: "AVOID" },
  unrated: { fg: "#847e6f", label: "UNRATED" },
};

export function renderBadge(composite: number | null, nProbes: number): string {
  const tier = tierFor(composite);
  const { fg, label } = COLORS[tier];
  const value =
    composite !== null ? composite.toFixed(1) : `${Math.min(nProbes, 19)}/20 PROBES`;
  const text = `ASSAY · ${label} · ${value}`;
  // 12px mono ≈ 7.3px advance + 1.5px letter-spacing per char; padded so the widest
  // font in the stack never clips.
  const textW = Math.ceil(text.length * 9) + 6;
  const H = 32;
  const markW = 30;
  const W = markW + 10 + textW + 14;
  // Mini ingot mark: the brand icon's geometry scaled to a 20-unit face.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Assay tier: ${label}">
<rect width="${W}" height="${H}" rx="4" fill="#0b0a08"/>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="3.5" fill="none" stroke="${fg}" stroke-opacity="0.55"/>
<g transform="translate(7,6)">
  <rect width="20" height="20" rx="2.5" fill="#dfa939"/>
  <polygon points="7,3 13,3 17.5,14 2.5,14" fill="#0b0a08"/>
  <polygon points="8.6,6.6 11.4,6.6 12.3,8.8 7.7,8.8" fill="#f6c964"/>
  <polygon points="7,11 13,11 14.2,14 5.8,14" fill="#dfa939"/>
  <rect x="7.5" y="16" width="5" height="1.6" rx="0.6" fill="#0b0a08"/>
</g>
<text x="${markW + 10}" y="20.5" font-family="ui-monospace,'Cascadia Mono',Menlo,Consolas,monospace" font-size="12" letter-spacing="1.5" fill="${fg}">${text}</text>
</svg>`;
}
