// /leaderboard — the assayer's ledger of record. Server-rendered page in the landing's
// "assay certificate" system: ruled rows with crop marks, Bodoni italic rank numerals,
// tier verdicts as struck stamps, unrated entries shown mid-assay with probe progress.

export type LeaderboardRow = {
  service_id: string;
  domain: string;
  composite: number | null;
  n_probes: number;
  trend: number | null;
  price_usdc: number | null;
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function tierChip(composite: number | null, nProbes: number): string {
  if (composite === null) {
    const n = Math.min(nProbes, 19);
    return `<span class="chip unrated">in assay · ${n}<span class="frac">∕</span>20</span>`;
  }
  if (composite >= 85) return `<span class="chip gold">gold</span>`;
  if (composite >= 60) return `<span class="chip ok">ok</span>`;
  return `<span class="chip avoid">avoid</span>`;
}

function trendMark(trend: number | null): string {
  if (trend === null) return `<span class="trend flat">—</span>`;
  const v = trend.toFixed(1);
  if (trend > 0.05) return `<span class="trend up">+${v}&#8599;</span>`;
  if (trend < -0.05) return `<span class="trend down">${v}&#8600;</span>`;
  return `<span class="trend flat">${v}</span>`;
}

export function renderLeaderboardPage(rows: LeaderboardRow[], now = Date.now()): string {
  const rated = rows.filter((r) => r.composite !== null).length;
  const tr = rows
    .map((r, i) => {
      const tierHref = `/tier/${encodeURIComponent(r.service_id)}`;
      const score =
        r.composite !== null
          ? `<span class="score">${r.composite.toFixed(1)}</span>`
          : `<span class="score dim">&mdash;</span>`;
      const price = r.price_usdc != null ? `$${r.price_usdc}` : "&mdash;";
      return `<a class="row" href="${tierHref}">
        <span class="no">${i + 1}</span>
        <span class="svc"><b>${esc(r.domain)}</b><i>${esc(r.service_id.replace(/^https?:\/\/[^/]*/, "") || "/")}</i></span>
        <span class="cell tier">${tierChip(r.composite, r.n_probes)}</span>
        <span class="cell num">${score}</span>
        <span class="cell num probes">${r.n_probes}</span>
        <span class="cell num trendc">${trendMark(r.trend)}</span>
        <span class="cell num price">${price}</span>
      </a>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Assay — Ledger of Record</title>
<meta name="description" content="Every x402 service Assay pays and verifies, ranked. Scores earned by real paid probes with on-chain receipts.">
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Bodoni+Moda:ital,opsz@1,6..96&family=IBM+Plex+Mono:ital,wght@0,400;0,500;1,400&display=swap" rel="stylesheet">
<style>
  :root{--carbon:#0b0a08;--panel:#12110e;--bone:#efe9da;--muted:#847e6f;--gold:#dfa939;--gold-hot:#f6c964;--fail:#c8442e;--line:#262319;--line-soft:#1a1812;}
  *{box-sizing:border-box;margin:0}
  body{background:var(--carbon);color:var(--bone);font:14px/1.6 "IBM Plex Mono",ui-monospace,monospace;-webkit-font-smoothing:antialiased}
  body::after{content:"";position:fixed;inset:0;pointer-events:none;opacity:.055;z-index:60;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.6'/%3E%3C/svg%3E")}
  .sheet{max-width:1080px;margin:0 auto;padding:0 22px}
  .rule{border:0;border-top:1px solid var(--line);position:relative;margin:0 -22px}
  .rule::before,.rule::after{content:"+";position:absolute;top:-9px;color:var(--muted);font:400 12px "IBM Plex Mono",monospace}
  .rule::before{left:8px}.rule::after{right:8px}

  header{padding:44px 0 26px;display:flex;align-items:flex-end;justify-content:space-between;gap:18px;flex-wrap:wrap}
  .masthead a{display:flex;align-items:center;gap:14px;text-decoration:none;color:inherit}
  .masthead img{width:44px;height:44px}
  .masthead h1{font-family:"Archivo Black",sans-serif;font-size:clamp(22px,4vw,34px);text-transform:uppercase;letter-spacing:.02em;line-height:1}
  .masthead small{display:block;font:italic 400 13px "Bodoni Moda",serif;color:var(--gold);letter-spacing:.08em;margin-top:6px}
  .tally{text-align:right;font-size:11.5px;color:var(--muted);letter-spacing:.14em;text-transform:uppercase;line-height:2}
  .tally b{color:var(--gold);font-weight:500}

  .colhead{display:grid;grid-template-columns:52px 1fr 128px 84px 74px 78px 70px;gap:0 14px;padding:12px 0 8px;font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted)}
  .colhead span:nth-child(n+3){text-align:right}
  .colhead .tier-h{text-align:left}

  .row{display:grid;grid-template-columns:52px 1fr 128px 84px 74px 78px 70px;gap:0 14px;align-items:baseline;
    padding:13px 0 11px;border-top:1px solid var(--line-soft);text-decoration:none;color:inherit;position:relative}
  .row:hover{background:linear-gradient(90deg,transparent,rgba(223,169,57,.05) 8%,rgba(223,169,57,.05) 92%,transparent)}
  .row:hover .no{color:var(--gold-hot)}
  .no{font:italic 400 19px "Bodoni Moda",serif;color:var(--gold);text-align:right;padding-right:2px}
  .svc b{font-weight:500;font-size:14.5px;letter-spacing:.01em}
  .svc i{display:block;font-style:normal;color:var(--muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52ch}
  .cell{text-align:right;font-size:13.5px}
  .tier{text-align:left}
  .score{color:var(--bone);font-weight:500;font-size:16px}
  .score.dim{color:var(--muted)}
  .probes{color:var(--muted)}
  .price{color:var(--muted)}
  .trend.up{color:var(--gold)}
  .trend.down{color:var(--fail)}
  .trend.flat{color:var(--muted)}

  .chip{display:inline-block;border:1.5px solid;padding:2px 9px 1px;font-size:10.5px;letter-spacing:.22em;text-transform:uppercase;transform:rotate(-1.2deg);
    mask-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='r'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.12' numOctaves='3'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.92 0'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23r)'/%3E%3C/svg%3E")}
  .chip.gold{color:var(--gold);border-color:var(--gold)}
  .chip.ok{color:var(--bone);border-color:var(--bone)}
  .chip.avoid{color:var(--fail);border-color:var(--fail)}
  .chip.unrated{color:var(--muted);border-color:var(--muted);transform:none;letter-spacing:.12em}
  .frac{padding:0 1px}

  footer{padding:30px 0 60px;color:var(--muted);font-size:12px;line-height:2}
  footer a{color:var(--gold);text-decoration:none}
  footer a:hover{color:var(--gold-hot)}
  footer code{color:var(--bone);background:var(--panel);padding:2px 7px;font-size:11px}

  @media (max-width:760px){
    .colhead{display:none}
    .row{grid-template-columns:34px 1fr 96px;grid-template-rows:auto auto;row-gap:4px}
    .no{font-size:16px;grid-row:span 2}
    .svc{grid-column:2}.tier{grid-column:3;text-align:right}
    .cell.num{grid-row:2;font-size:11.5px;text-align:left}
    .cell.num.probes::after{content:" probes";color:var(--muted)}
    .cell.num.price{text-align:right}
    .trendc{display:none}
  }
</style>
</head>
<body>
<div class="sheet">
  <header>
    <div class="masthead">
      <a href="/"><img src="/icon.svg" alt="Assay">
        <h1>Ledger of Record<small>Assay &middot; every entry paid for &middot; ${new Date(now).toISOString().slice(0, 10)}</small></h1>
      </a>
    </div>
    <div class="tally"><b>${rated}</b> scored &middot; <b>${rows.length - rated}</b> in assay<br>rank by composite, trailing 30 days</div>
  </header>
  <hr class="rule">
  <div class="colhead"><span></span><span>Service</span><span class="tier-h">Verdict</span><span>Score</span><span>Probes</span><span>7d</span><span>Price</span></div>
  ${tr}
  <hr class="rule" style="margin-top:-1px">
  <footer>
    Scores are earned, not claimed: settlement 40 &middot; schema 30 &middot; ground truth 20 &middot; judge 10, over real paid probes
    with on-chain receipts. Nothing publishes under 20 probes across multiple days.
    Daily evidence digests anchor to Bitcoin &mdash; <a href="/api/digests">verify</a>.<br>
    Scored operator? Show it: <code>&lt;img src="https://assay.nominal-labs.com/badge/&lt;url-encoded service URL&gt;.svg"&gt;</code>
    &mdash; the badge is live and can downgrade, which is why it means something.
    Agents: <a href="/SKILL.md">SKILL.md</a>
  </footer>
</div>
</body>
</html>`;
}
