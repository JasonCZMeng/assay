// Public landing page served at "/" — v2 "assay certificate" design.
// Self-contained except Google Fonts; live numbers come from same-origin read APIs.
// Inline script avoids backticks/template literals so this file holds it in one TS string.
export const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ASSAY — the quality oracle for the x402 agent economy</title>
<meta name="description" content="Assay pays real USDC to probe x402 services, verifies what comes back, and sells the scores. Every rating is backed by an on-chain receipt.">
<meta property="og:title" content="ASSAY — tested by purchase, proven on-chain.">
<meta property="og:description" content="The quality oracle for the agent economy. Real paid probes, on-chain receipts, timestamped history.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo+Black&amp;family=Bodoni+Moda:ital,opsz,wght@0,6..96,400;0,6..96,700;1,6..96,400&amp;family=Fraunces:ital,opsz,wght@0,9..144,900;1,9..144,300&amp;family=Bebas+Neue&amp;family=Six+Caps&amp;family=Saira+Stencil+One&amp;family=IBM+Plex+Mono:ital,wght@0,400;0,500;1,400&amp;family=Instrument+Serif:ital@0;1&amp;display=swap" rel="stylesheet">
<style>
  :root {
    --carbon:#0b0a08; --panel:#12110e; --bone:#efe9da; --muted:#847e6f;
    --gold:#dfa939; --gold-hot:#f6c964; --fail:#c8442e; --line:#262319; --line-soft:#1a1812;
  }
  * { box-sizing:border-box; margin:0; }
  html { scroll-behavior:smooth; }
  body {
    background:var(--carbon); color:var(--bone);
    font:15px/1.65 "IBM Plex Mono", ui-monospace, monospace;
    -webkit-font-smoothing:antialiased; overflow-x:hidden;
  }
  body::after { content:""; position:fixed; inset:0; pointer-events:none; opacity:.055; z-index:60;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.6'/%3E%3C/svg%3E"); }

  /* full-bleed ledger rules */
  .ledger-rule { border:0; border-top:1px solid var(--line); position:relative; }
  .ledger-rule::before, .ledger-rule::after { content:"+"; position:absolute; top:-9px; color:var(--muted);
    font:400 12px "IBM Plex Mono",monospace; }
  .ledger-rule::before { left:10px; } .ledger-rule::after { right:10px; }

  .sheet { max-width:1280px; margin:0 auto; padding:0 24px 0 76px; position:relative; }
  @media (max-width:760px){ .sheet{ padding-left:24px; } }

  /* left margin rail */
  .rail { position:fixed; left:0; top:0; bottom:0; width:52px; border-right:1px solid var(--line-soft);
    display:flex; flex-direction:column; align-items:center; justify-content:space-between;
    padding:18px 0; z-index:40; background:var(--carbon); }
  .rail .v { writing-mode:vertical-rl; font-size:10px; letter-spacing:.34em; color:var(--muted); text-transform:uppercase; }
  .rail .au { font-family:"Bodoni Moda",serif; color:var(--gold); font-size:15px; }
  @media (max-width:760px){ .rail{ display:none; } }

  nav { display:flex; align-items:baseline; gap:26px; padding:20px 0 18px; font-size:11.5px; letter-spacing:.1em; }
  nav .mark { font-family:"Archivo Black",sans-serif; font-size:14px; letter-spacing:.16em; text-decoration:none; color:var(--bone); }
  nav .mark i { font-style:normal; color:var(--gold); }
  nav .no { color:var(--muted); font-size:10.5px; }
  nav .links { margin-left:auto; display:flex; gap:20px; }
  nav .links a { color:var(--muted); text-decoration:none; text-transform:uppercase; }
  nav .links a:hover { color:var(--gold-hot); }

  /* ---------- HERO: certificate head ---------- */
  .hero { position:relative; padding:7vh 0 9vh; overflow-x:clip; }
  .hero .au-mark { position:absolute; right:-2%; top:2%; font-family:"Bodoni Moda",serif; font-weight:700;
    font-size:clamp(180px,30vw,420px); line-height:.8; color:transparent; -webkit-text-stroke:1px var(--line);
    user-select:none; pointer-events:none; z-index:0; }
  .hero .au-mark small { display:block; font-size:.22em; -webkit-text-stroke:0; color:var(--line);
    font-family:"IBM Plex Mono",monospace; letter-spacing:.4em; text-align:right; }
  .dict { position:relative; z-index:2; font-family:"Instrument Serif",serif; font-style:italic;
    color:var(--muted); font-size:17px; max-width:430px; }
  .dict b { color:var(--bone); font-style:normal; font-family:"IBM Plex Mono",monospace; font-size:12px; letter-spacing:.12em; }

  /* the morphing word */
  .word-stage { position:relative; z-index:2; margin-top:5vh; height:clamp(120px,21vw,260px); }
  .word-stage .v { position:absolute; left:0; bottom:0; line-height:.86; white-space:nowrap;
    opacity:0; visibility:hidden; will-change:opacity,transform; }
  .word-stage .v.on { opacity:1; visibility:visible; }
  .word-stage .v.echo { opacity:.13; visibility:visible; }
  .word-stage .v.echo2 { opacity:.06; visibility:visible; }
  .word-stage .v.final { opacity:1; visibility:visible; color:var(--gold);
    text-shadow:0 0 60px rgba(223,169,57,.35); }
  /* 20 identities of the word */
  .v1  { font:400 clamp(96px,17vw,208px) "Archivo Black",sans-serif; letter-spacing:-.015em; }
  .v2  { font:700 clamp(96px,17vw,208px) "Bodoni Moda",serif; }
  .v3  { font:italic 400 clamp(96px,17vw,208px) "Bodoni Moda",serif; }
  .v4  { font:900 clamp(96px,17vw,208px) "Fraunces",serif; letter-spacing:-.02em; }
  .v5  { font:italic 300 clamp(96px,17vw,208px) "Fraunces",serif; }
  .v6  { font:400 clamp(110px,19vw,236px) "Bebas Neue",sans-serif; letter-spacing:.02em; }
  .v7  { font:400 clamp(120px,21vw,258px) "Six Caps",sans-serif; letter-spacing:.04em; }
  .v8  { font:400 clamp(90px,16vw,196px) "Saira Stencil One",sans-serif; }
  .v9  { font:500 clamp(78px,14vw,170px) "IBM Plex Mono",monospace; letter-spacing:-.04em; }
  .v10 { font:italic 400 clamp(96px,17vw,208px) "Instrument Serif",serif; }
  .v11 { font:400 clamp(96px,17vw,208px) "Archivo Black",sans-serif; color:transparent !important;
         -webkit-text-stroke:2px var(--bone); }
  .v12 { font:700 clamp(96px,17vw,208px) "Bodoni Moda",serif; color:transparent !important;
         -webkit-text-stroke:1.5px var(--gold); }
  .v13 { font:400 clamp(110px,19vw,236px) "Bebas Neue",sans-serif; color:transparent !important;
         -webkit-text-stroke:1.5px var(--muted); }
  .v14 { font:400 clamp(64px,11vw,140px) "Archivo Black",sans-serif; letter-spacing:.28em; }
  .v15 { font:400 clamp(78px,14vw,170px) "IBM Plex Mono",monospace; letter-spacing:.18em; }
  .v16 { font:900 clamp(96px,17vw,208px) "Fraunces",serif; color:transparent !important;
         -webkit-text-stroke:1.5px var(--bone); }
  .v17 { font:italic 400 clamp(88px,15vw,190px) "Bodoni Moda",serif; letter-spacing:.06em; }
  .v18 { font:400 clamp(120px,21vw,258px) "Six Caps",sans-serif; color:transparent !important;
         -webkit-text-stroke:1px var(--gold); letter-spacing:.1em; }
  .v19 { font:400 clamp(90px,16vw,196px) "Saira Stencil One",sans-serif; color:var(--gold) !important; opacity:.0; }
  .v20 { font:italic 300 clamp(96px,17vw,208px) "Fraunces",serif; letter-spacing:-.01em; }

  .hero-caption { position:relative; z-index:2; display:flex; gap:26px; align-items:flex-start; flex-wrap:wrap; margin-top:26px; }
  .hero-caption .no { font-family:"Bodoni Moda",serif; font-style:italic; color:var(--gold); font-size:20px; }
  .hero-sub { max-width:560px; color:var(--muted); font-size:14.5px; }
  .hero-sub em { color:var(--bone); font-style:normal; }
  .cta-row { margin-top:30px; display:flex; gap:0; flex-wrap:wrap; position:relative; z-index:2; }
  .btn { font:500 12px/1 "IBM Plex Mono",monospace; letter-spacing:.14em; text-transform:uppercase;
         padding:16px 24px; text-decoration:none; border:1px solid var(--gold); }
  .btn.solid { background:var(--gold); color:#171205; }
  .btn.solid:hover { background:var(--gold-hot); border-color:var(--gold-hot); }
  .btn.ghost { color:var(--gold); border-left:0; }
  .btn.ghost:hover { color:var(--gold-hot); }

  /* stamp */
  .stamp { position:absolute; z-index:3; right:4%; bottom:-26px; transform:rotate(-8deg);
    border:2px solid var(--gold); color:var(--gold); padding:10px 16px 8px; font-size:10.5px;
    letter-spacing:.22em; text-transform:uppercase; line-height:1.8; opacity:.85;
    mask-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='r'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.12' numOctaves='3'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.92 0'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23r)'/%3E%3C/svg%3E"); }
  .stamp b { display:block; font-size:13px; letter-spacing:.3em; }
  @media (max-width:900px){ .stamp{ position:static; transform:rotate(-4deg); display:inline-block; margin-top:34px; } }

  /* ---------- tape ---------- */
  .tape { border-top:1px solid var(--line); border-bottom:1px solid var(--line); overflow:hidden; padding:10px 0; }
  .tape-inner { display:inline-flex; gap:44px; white-space:nowrap; animation:tape 52s linear infinite;
    font-size:12px; color:var(--muted); }
  .tape-inner .ok { color:var(--gold); } .tape-inner .bad { color:var(--fail); }
  @keyframes tape { from{transform:translateX(0);} to{transform:translateX(-50%);} }

  /* ---------- specimen sections ---------- */
  section { padding:76px 0 64px; position:relative; }
  .spec-head { display:flex; align-items:baseline; gap:18px; margin-bottom:44px; }
  .spec-head .num { font-family:"Bodoni Moda",serif; font-style:italic; font-size:44px; color:var(--gold); line-height:1; }
  .spec-head h2 { font-family:"Archivo Black",sans-serif; font-size:clamp(20px,3vw,30px); text-transform:uppercase; letter-spacing:.02em; }
  .spec-head .fill { flex:1; border-bottom:1px dotted var(--line); transform:translateY(-6px); }
  .spec-head .side { font-size:10px; letter-spacing:.28em; color:var(--muted); text-transform:uppercase; }

  /* ledger rows for live figures */
  .ledger { max-width:880px; }
  .ledger .row { display:flex; align-items:baseline; gap:10px; padding:13px 0; border-bottom:1px solid var(--line-soft); }
  .ledger .k { font-size:12.5px; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
  .ledger .dots { flex:1; border-bottom:1px dotted var(--line); transform:translateY(-4px); }
  .ledger .val { font-family:"Bodoni Moda",serif; font-weight:700; font-size:clamp(24px,3.4vw,38px); color:var(--gold); }
  .ledger .unit { font-size:11px; color:var(--muted); letter-spacing:.1em; }
  .ledger .row.annot { border:0; padding-top:4px; }
  .ledger .row.annot .a { font-family:"Instrument Serif",serif; font-style:italic; color:var(--muted); font-size:14.5px; }

  /* method: asymmetric two-col */
  .method { display:grid; grid-template-columns:minmax(0,5fr) minmax(0,4fr); gap:60px; align-items:start; }
  @media (max-width:900px){ .method{ grid-template-columns:1fr; gap:30px; } }
  .method .tier { padding:18px 0 16px; border-top:1px solid var(--line); display:grid;
    grid-template-columns:56px 1fr auto; gap:14px; align-items:baseline; }
  .method .tier:last-child { border-bottom:1px solid var(--line); }
  .method .t { font-family:"Saira Stencil One",sans-serif; color:var(--muted); font-size:15px; }
  .method .n { font-family:"Archivo Black",sans-serif; text-transform:uppercase; font-size:14px; letter-spacing:.06em; }
  .method .w { font-family:"Bodoni Moda",serif; font-style:italic; color:var(--gold); font-size:19px; }
  .method .d { grid-column:2 / -1; color:var(--muted); font-size:13px; margin-top:4px; }
  .method-side { font-family:"Instrument Serif",serif; font-style:italic; font-size:19px; line-height:1.75; color:var(--muted); }
  .method-side em { color:var(--bone); }
  .method-side .rulebox { margin-top:26px; border:1px solid var(--line); padding:18px 20px;
    font:400 12.5px/1.7 "IBM Plex Mono",monospace; font-style:normal; color:var(--muted); }
  .method-side .rulebox b { color:var(--gold); font-weight:500; }

  /* api */
  .api-grid { display:grid; grid-template-columns:1fr 1fr; gap:0; border:1px solid var(--line); }
  @media (max-width:900px){ .api-grid{ grid-template-columns:1fr; } }
  .api-cell { padding:26px 26px 22px; }
  .api-cell + .api-cell { border-left:1px solid var(--line); }
  @media (max-width:900px){ .api-cell + .api-cell { border-left:0; border-top:1px solid var(--line); } }
  .api-cell .tag { font-size:10px; letter-spacing:.3em; text-transform:uppercase; color:var(--muted); margin-bottom:14px; }
  .api-cell .tag b { color:var(--gold); font-weight:500; }
  .api-cell pre { font:400 12.5px/1.75 "IBM Plex Mono",monospace; white-space:pre; overflow-x:auto; }
  .api-cell .g { color:var(--gold); } .api-cell .cmt { color:var(--muted); }
  .api-note { margin-top:18px; color:var(--muted); font-size:12.5px; }

  /* proof */
  .proof { max-width:760px; }
  .proof p { font-family:"Instrument Serif",serif; font-size:21px; line-height:1.7; color:var(--muted); margin-bottom:22px; }
  .proof p em { color:var(--bone); font-style:normal; }
  .proof p a { color:var(--gold); text-decoration:none; border-bottom:1px solid rgba(223,169,57,.4); font-family:"IBM Plex Mono",monospace; font-size:15px; }
  .proof p a:hover { color:var(--gold-hot); }

  footer { border-top:1px solid var(--line); padding:30px 0 70px; font-size:11.5px; color:var(--muted); }
  footer .cols { display:flex; flex-wrap:wrap; gap:26px; align-items:baseline; }
  footer .mark { font-family:"Archivo Black",sans-serif; letter-spacing:.16em; color:var(--bone); }
  footer .mark i { font-style:normal; color:var(--gold); }
  footer .right { margin-left:auto; display:flex; gap:20px; }
  footer a { color:var(--muted); text-decoration:none; }
  footer a:hover { color:var(--gold-hot); }
  footer .colophon { margin-top:16px; font-family:"Instrument Serif",serif; font-style:italic; font-size:13.5px; }

  @media (prefers-reduced-motion: reduce){ .tape-inner{ animation:none; } }
</style>
</head>
<body>
<div class="rail">
  <span class="au">Au&#8202;79</span>
  <span class="v">assay &middot; n. &middot; the trial of metals &middot; est. 07&middot;2026 &middot; base mainnet &middot; x402</span>
  <span class="au">&#9878;</span>
</div>

<div class="sheet">
  <nav>
    <a class="mark" href="/">ASSAY<i>.</i></a>
    <span class="no">CERTIFICATE N&deg; 402-8453</span>
    <div class="links">
      <a href="/leaderboard">Leaderboard</a>
      <a href="#api">API</a>
      <a href="#proof">Receipts</a>
    </div>
  </nav>
</div>
<hr class="ledger-rule">

<header class="hero">
  <div class="sheet">
    <div class="au-mark">Au<small>AURUM &middot; 79</small></div>
    <p class="dict"><b>as&middot;say /&aelig;&#712;se&#618;/ &middot; verb, noun</b><br>
    the testing of a metal to determine its purity; judgment of worth by trial, never by label.</p>

    <div class="word-stage" id="stage" aria-label="ASSAY"></div>

    <div class="hero-caption">
      <span class="no">est.&#8202;2026</span>
      <p class="hero-sub">The quality oracle for the <em>x402 agent economy</em>. We spend real USDC buying from
      machine-payable services, verify what actually comes back, and publish the scores.
      <em>Every rating carries an on-chain receipt.</em></p>
    </div>

    <div class="cta-row">
      <a class="btn solid" href="/leaderboard">View live scores &rarr;</a>
      <a class="btn ghost" href="#api">Query the oracle</a>
    </div>

    <div class="stamp"><b>Settled &#10003;</b> base mainnet &middot; usdc<br>first sale &middot; block 48727514</div>
  </div>
</header>

<div class="tape"><div class="tape-inner" id="tape"><span>reading the ledger &hellip;</span></div></div>

<section>
  <div class="sheet">
    <div class="spec-head"><span class="num">i.</span><h2>The corpus, live</h2><span class="fill"></span><span class="side">specimen record</span></div>
    <div class="ledger">
      <div class="row"><span class="k">services under continuous probe</span><span class="dots"></span><span class="val" id="s-services">&mdash;</span></div>
      <div class="row"><span class="k">paid probes in the evidence corpus</span><span class="dots"></span><span class="val" id="s-probes">&mdash;</span></div>
      <div class="row"><span class="k">x402 services catalogued</span><span class="dots"></span><span class="val" id="s-catalog">&mdash;</span></div>
      <div class="row"><span class="k">sweeps per day, every day</span><span class="dots"></span><span class="val">6<span class="unit">&thinsp;&times;</span></span></div>
      <div class="row annot"><span class="a">figures drawn from the working database at page-load; nothing here is a mock-up.</span></div>
    </div>
  </div>
</section>
<hr class="ledger-rule">

<section>
  <div class="sheet">
    <div class="spec-head"><span class="num">ii.</span><h2>How a score is earned</h2><span class="fill"></span><span class="side">method of trial</span></div>
    <div class="method">
      <div>
        <div class="tier"><span class="t">T&middot;0</span><span class="n">Settlement</span><span class="w">40%</span>
          <span class="d">We pay the advertised price in USDC on Base. Did the service deliver after taking the money?</span></div>
        <div class="tier"><span class="t">T&middot;1</span><span class="n">Schema</span><span class="w">30%</span>
          <span class="d">Does the response match the shape the service itself advertises? One in five don&rsquo;t.</span></div>
        <div class="tier"><span class="t">T&middot;2</span><span class="n">Ground truth</span><span class="w">20%</span>
          <span class="d">Where reality is checkable &mdash; prices, rates, coordinates &mdash; we check it against independent references.</span></div>
        <div class="tier"><span class="t">T&middot;3</span><span class="n">Judge</span><span class="w">10%</span>
          <span class="d">A language model grades what mechanical checks can&rsquo;t: is the translation right, is the news real, is the answer worth its price?</span></div>
      </div>
      <div class="method-side">
        <p>A score is a <em>verdict rendered by purchase</em>. No synthetic pings, no self-reported uptime &mdash;
        the same 402, the same payment, the same response any paying agent would get.</p>
        <div class="rulebox"><b>house rule</b> &mdash; no score is published before <b>20 probes</b> spread across
        days. A service that only behaves when it feels like it cannot hide inside one good afternoon.</div>
      </div>
    </div>
  </div>
</section>
<hr class="ledger-rule">

<section id="api">
  <div class="sheet">
    <div class="spec-head"><span class="num">iii.</span><h2>Query the oracle</h2><span class="fill"></span><span class="side">two counters, one door</span></div>
    <div class="api-grid">
      <div class="api-cell">
        <div class="tag">tier &middot; <b>free</b> &middot; cache 1h</div>
        <pre>curl https://assay.nominal-labs.com/tier/{url}

<span class="g">{ "service": "&hellip;", "tier": "gold" }</span></pre>
        <p class="api-note">gold &middot; ok &middot; avoid &middot; unrated &mdash; all a spend-guard needs.</p>
      </div>
      <div class="api-cell">
        <div class="tag">score &middot; <b>$0.005 usdc</b> &middot; x402</div>
        <pre>curl https://assay.nominal-labs.com/score/{url}
<span class="cmt">&rarr; HTTP 402 &rarr; any x402 client pays &amp; retries</span>

<span class="g">{ "composite": 93.1, "nProbes": 41,
  "components": { &hellip; }, "trend": +1.2 }</span></pre>
        <p class="api-note">Machine-payable. No key, no account, no sales call.</p>
      </div>
    </div>
  </div>
</section>
<hr class="ledger-rule">

<section id="proof">
  <div class="sheet">
    <div class="spec-head"><span class="num">iv.</span><h2>Trust nothing, verify us</h2><span class="fill"></span><span class="side">the receipts</span></div>
    <div class="proof">
      <p><em>Every probe is a real purchase.</em> The probe wallet spends in public &mdash;
      <a href="https://basescan.org/address/0x8a1A037b4fb377fceCd0F8A0B91A6A35df78Aa53" rel="noopener" target="_blank">watch it on Basescan</a> &mdash;
      the receipts behind every score, inspectable by anyone.</p>
      <p><em>History is proven, not claimed.</em> Each day&rsquo;s corpus is sealed under a merkle root and anchored
      through OpenTimestamps to Bitcoin. Nobody &mdash; including us &mdash; can quietly rewrite what was observed.</p>
      <p><em>The number is not for sale.</em> Operators may pay for monitoring; the score itself cannot be bought.
      The day that changes, this instrument is scrap metal. So it won&rsquo;t.</p>
    </div>
  </div>
</section>

<div class="sheet">
  <footer>
    <div class="cols">
      <span class="mark">ASSAY<i>.</i></span>
      <span>an instrument of Nominal Labs</span>
      <div class="right">
        <a href="/leaderboard">leaderboard</a>
        <a href="/healthz">status</a>
        <a href="mailto:info@nominal-labs.com">contact</a>
      </div>
    </div>
    <p class="colophon">Set in Archivo Black, Bodoni Moda &amp; IBM Plex Mono. Figures live; typos permanent &mdash; they&rsquo;re timestamped.</p>
  </footer>
</div>

<script>
(function () {
  'use strict';
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- 20 identities of the word, overlaying and replacing ----
  var stage = document.getElementById('stage');
  var CASES = { 1:'ASSAY', 2:'Assay', 3:'Assay', 4:'Assay', 5:'assay', 6:'ASSAY', 7:'ASSAY', 8:'ASSAY',
                9:'assay', 10:'Assay', 11:'ASSAY', 12:'Assay', 13:'ASSAY', 14:'ASSAY', 15:'A S S A Y',
                16:'Assay', 17:'Assay', 18:'ASSAY', 19:'ASSAY', 20:'assay' };
  var els = [];
  if (stage) {
    for (var n = 1; n <= 20; n++) {
      var s = document.createElement('span');
      s.className = 'v v' + n;
      s.textContent = CASES[n];
      stage.appendChild(s);
      els.push(s);
    }
  }
  if (stage && !reduced) {
    var cur = -1, prev = -1, prev2 = -1;
    var order = [], oi = 0;
    function reshuffle() {
      order = els.map(function (_, i) { return i; });
      for (var i = order.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1)), t = order[i]; order[i] = order[j]; order[j] = t;
      }
      oi = 0;
    }
    reshuffle();
    function paint(finalLock) {
      for (var i = 0; i < els.length; i++) els[i].className = els[i].className.replace(/ (on|echo|echo2|final)/g, '');
      if (finalLock) { els[0].className += ' final'; return; } // v1 Archivo = canonical
      if (prev2 >= 0) els[prev2].className += ' echo2';
      if (prev >= 0) els[prev].className += ' echo';
      if (cur >= 0) els[cur].className += ' on';
    }
    function step(framesLeft) {
      prev2 = prev; prev = cur;
      cur = order[oi++ % order.length];
      if (oi >= order.length) reshuffle();
      paint(false);
      if (framesLeft > 0) {
        setTimeout(function () { step(framesLeft - 1); }, 80 + Math.random() * 90);
      } else {
        paint(true);
        setTimeout(function () { step(16 + Math.floor(Math.random() * 10)); }, 2100);
      }
    }
    step(18);
  } else if (stage) {
    els[0].className += ' final';
  }

  // ---- live figures ----
  function fmt(x) { return Number(x).toLocaleString('en-US'); }
  fetch('/api/status').then(function (r) { return r.json(); }).then(function (s) {
    document.getElementById('s-services').textContent = fmt(s.services.curated);
    document.getElementById('s-probes').textContent = fmt(s.probesTotal);
    document.getElementById('s-catalog').textContent = fmt(s.services.discovered);
  }).catch(function () {});

  // ---- probe-log tape ----
  fetch('/api/probes?limit=18').then(function (r) { return r.json(); }).then(function (rows) {
    var bits = rows.map(function (p) {
      var ok = p.ok_settlement === 1 && (p.ok_schema === null || p.ok_schema === 1);
      return '<span>' + (ok ? '<span class="ok">&#10003;</span>' : '<span class="bad">&#10007;</span>') + ' ' +
        String(p.domain || '').replace(/[<>&]/g, '') +
        ' &middot; $' + p.usdc_cost + ' &middot; ' + (p.latency_ms || '?') + 'ms' +
        (p.payment_tx ? ' &middot; tx ' + String(p.payment_tx).slice(0, 10) + '&hellip;' : '') + '</span>';
    });
    if (bits.length) {
      var half = bits.join('<span style="opacity:.3">&#8213;</span>');
      document.getElementById('tape').innerHTML = half + '<span style="opacity:.3">&#8213;</span>' + half;
    }
  }).catch(function () {});
})();
</script>
</body>
</html>`;
