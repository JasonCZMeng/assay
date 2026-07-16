// Public landing page served at "/". Self-contained except Google Fonts; live numbers
// come from the same-origin read APIs. The inline script avoids backticks/template
// literals so this file can hold it in one TS template string.
export const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ASSAY — the quality oracle for the x402 agent economy</title>
<meta name="description" content="Assay pays real USDC to probe x402 services, verifies what comes back, and sells the scores. Every rating is backed by on-chain receipts.">
<meta property="og:title" content="ASSAY — we pay, we probe, we prove.">
<meta property="og:description" content="The quality oracle for the agent economy. Real paid probes, on-chain receipts, timestamped history.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo+Black&amp;family=IBM+Plex+Mono:wght@400;500&amp;family=Instrument+Serif:ital@0;1&amp;display=swap" rel="stylesheet">
<style>
  :root {
    --carbon: #0a0a09; --panel: #111110; --bone: #f2efe6; --muted: #8a867b;
    --gold: #e9b44c; --gold-hot: #ffd27a; --fail: #d03b3b; --line: #26251f;
  }
  * { box-sizing: border-box; margin: 0; }
  html { scroll-behavior: smooth; }
  body {
    background: var(--carbon); color: var(--bone);
    font: 16px/1.6 "IBM Plex Mono", ui-monospace, monospace;
    -webkit-font-smoothing: antialiased; overflow-x: hidden;
  }
  body::after { /* grain */
    content: ""; position: fixed; inset: 0; pointer-events: none; opacity: .05; z-index: 50;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.6'/%3E%3C/svg%3E");
  }
  .rule { border: 0; border-top: 1px solid var(--line); }
  .wrap { max-width: 1240px; margin: 0 auto; padding: 0 28px; }
  a { color: inherit; }

  /* ---------- top bar ---------- */
  nav { display: flex; align-items: baseline; gap: 24px; padding: 22px 0; font-size: 12px; letter-spacing: .08em; }
  nav .mark { font-family: "Archivo Black", sans-serif; font-size: 15px; letter-spacing: .14em; color: var(--bone); text-decoration: none; }
  nav .mark span { color: var(--gold); }
  nav .links { margin-left: auto; display: flex; gap: 22px; }
  nav .links a { color: var(--muted); text-decoration: none; text-transform: uppercase; }
  nav .links a:hover { color: var(--gold-hot); }

  /* ---------- hero ---------- */
  .hero { position: relative; padding: 9vh 0 10vh; }
  .hero .glow {
    position: absolute; left: 50%; top: 42%; width: 900px; height: 520px; transform: translate(-50%,-50%);
    background: radial-gradient(ellipse at center, rgba(233,180,76,.13), transparent 62%); pointer-events: none;
  }
  .dict { font-family: "Instrument Serif", serif; font-style: italic; color: var(--muted); font-size: 17px; max-width: 480px; }
  .dict b { color: var(--bone); font-style: normal; font-family: "IBM Plex Mono", monospace; font-size: 13px; letter-spacing: .1em; }
  .hero-line { margin-top: 7vh; font-family: "Archivo Black", sans-serif; text-transform: uppercase; line-height: .92; }
  .hero-line .pre { display: block; font-size: clamp(20px, 3.4vw, 40px); color: var(--muted); letter-spacing: .06em; }
  .flicker-slot { display: block; position: relative; font-size: clamp(64px, 14.5vw, 176px); letter-spacing: -0.01em; min-height: 1em; }
  .flicker-slot .w { color: var(--bone); }
  .flicker-slot .w.jit1 { transform: translateX(2px) skewX(-1.2deg); opacity: .82; }
  .flicker-slot .w.jit2 { transform: translateX(-3px); opacity: .68; text-shadow: 3px 0 rgba(233,180,76,.35), -3px 0 rgba(208,59,59,.25); }
  .flicker-slot .w.jit3 { transform: translateY(1px) scaleY(.985); opacity: .9; }
  .flicker-slot .w.lock { color: var(--gold); text-shadow: 0 0 46px rgba(233,180,76,.4); }
  .hero-line .post { display: block; font-size: clamp(20px, 3.4vw, 40px); color: var(--muted); letter-spacing: .06em; }
  .hero-sub { margin-top: 4.5vh; max-width: 620px; color: var(--muted); font-size: 15px; }
  .hero-sub em { color: var(--bone); font-style: normal; }
  .cta-row { margin-top: 34px; display: flex; gap: 14px; flex-wrap: wrap; }
  .btn { font: 500 13px/1 "IBM Plex Mono", monospace; letter-spacing: .12em; text-transform: uppercase;
         padding: 15px 22px; text-decoration: none; border: 1px solid var(--gold); }
  .btn.solid { background: var(--gold); color: #141208; }
  .btn.solid:hover { background: var(--gold-hot); border-color: var(--gold-hot); }
  .btn.ghost { color: var(--gold); }
  .btn.ghost:hover { color: var(--gold-hot); border-color: var(--gold-hot); }
  .side-tag { position: absolute; right: -6px; top: 12vh; writing-mode: vertical-rl; font-size: 11px;
              letter-spacing: .3em; color: var(--muted); text-transform: uppercase; }
  @media (max-width: 800px) { .side-tag { display: none; } }

  /* ---------- live log marquee ---------- */
  .tape { border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); overflow: hidden; padding: 12px 0; }
  .tape-inner { display: inline-flex; gap: 48px; white-space: nowrap; animation: tape 46s linear infinite; font-size: 12.5px; color: var(--muted); }
  .tape-inner .ok { color: var(--gold); } .tape-inner .bad { color: var(--fail); }
  @keyframes tape { from { transform: translateX(0); } to { transform: translateX(-50%); } }

  /* ---------- sections ---------- */
  section { padding: 84px 0 72px; }
  .sec-label { font-size: 11px; letter-spacing: .3em; color: var(--gold); text-transform: uppercase; margin-bottom: 40px; }
  .sec-label::before { content: "— "; color: var(--muted); }

  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); }
  .stat { background: var(--carbon); padding: 26px 22px; }
  .stat .v { font-family: "Archivo Black", sans-serif; font-size: clamp(28px, 4vw, 44px); color: var(--gold); }
  .stat .k { margin-top: 8px; font-size: 11.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }

  .tiers { display: grid; gap: 0; border-top: 1px solid var(--line); }
  .tier { display: grid; grid-template-columns: 84px 1.1fr 2fr 120px; gap: 18px; align-items: center;
          padding: 22px 4px; border-bottom: 1px solid var(--line); }
  .tier .t { font-family: "Archivo Black", sans-serif; color: var(--muted); }
  .tier .n { font-size: 14px; letter-spacing: .1em; text-transform: uppercase; }
  .tier .d { color: var(--muted); font-size: 13.5px; }
  .tier .wgt { text-align: right; color: var(--gold); font-size: 13px; }
  .tier .bar { grid-column: 2 / -1; height: 3px; background: var(--panel); }
  .tier .bar i { display: block; height: 3px; background: var(--gold); }
  @media (max-width: 720px) { .tier { grid-template-columns: 60px 1fr 90px; } .tier .d { grid-column: 1 / -1; } }

  .api-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; }
  @media (max-width: 900px) { .api-grid { grid-template-columns: 1fr; } }
  .term { background: var(--panel); border: 1px solid var(--line); padding: 22px; font-size: 13px; overflow-x: auto; }
  .term .cmt { color: var(--muted); } .term .g { color: var(--gold); } .term .price { color: var(--gold-hot); }
  .term pre { font-family: inherit; white-space: pre; }
  .api-note { margin-top: 16px; color: var(--muted); font-size: 13px; }

  .proof p { max-width: 700px; color: var(--muted); font-size: 15px; margin-bottom: 18px; }
  .proof p em { color: var(--bone); font-style: normal; }
  .proof a { color: var(--gold); text-decoration: none; border-bottom: 1px solid rgba(233,180,76,.35); }
  .proof a:hover { color: var(--gold-hot); }

  footer { border-top: 1px solid var(--line); padding: 34px 0 60px; display: flex; flex-wrap: wrap; gap: 18px; align-items: baseline; font-size: 12px; color: var(--muted); }
  footer .mark { font-family: "Archivo Black", sans-serif; letter-spacing: .14em; color: var(--bone); }
  footer .mark span { color: var(--gold); }
  footer .right { margin-left: auto; display: flex; gap: 20px; }
  footer a { color: var(--muted); text-decoration: none; }
  footer a:hover { color: var(--gold-hot); }

  @media (prefers-reduced-motion: reduce) {
    .tape-inner { animation: none; }
  }
</style>
</head>
<body>
<div class="wrap">
  <nav>
    <a class="mark" href="/">ASSAY<span>.</span></a>
    <div class="links">
      <a href="/leaderboard">Leaderboard</a>
      <a href="#api">API</a>
      <a href="#proof">Receipts</a>
    </div>
  </nav>
</div>

<header class="hero">
  <div class="glow"></div>
  <div class="wrap" style="position:relative">
    <p class="dict"><b>as&middot;say /&aelig;&#712;se&#618;/ &middot; verb</b><br>
    to test a metal for purity &mdash; to judge the worth of a thing by trial, not by its label.</p>
    <h1 class="hero-line">
      <span class="pre">We</span>
      <span class="flicker-slot"><span class="w" id="flick">ASSAY</span></span>
      <span class="post">every agent service.</span>
    </h1>
    <p class="hero-sub">Assay is the quality oracle for the <em>x402 agent economy</em>. We spend real USDC buying from
    machine-payable services, verify what actually comes back, and publish the scores &mdash;
    <em>every rating backed by an on-chain receipt.</em></p>
    <div class="cta-row">
      <a class="btn solid" href="/leaderboard">View live scores &rarr;</a>
      <a class="btn ghost" href="#api">Query the oracle</a>
    </div>
    <div class="side-tag">x402 &middot; base mainnet &middot; est. 07&middot;2026</div>
  </div>
</header>

<div class="tape"><div class="tape-inner" id="tape"><span>loading probe log &hellip;</span></div></div>

<section>
  <div class="wrap">
    <div class="sec-label">01 / The corpus, live</div>
    <div class="stats" id="stats">
      <div class="stat"><div class="v" id="s-services">&mdash;</div><div class="k">services under continuous probe</div></div>
      <div class="stat"><div class="v" id="s-probes">&mdash;</div><div class="k">paid probes in the evidence corpus</div></div>
      <div class="stat"><div class="v" id="s-catalog">&mdash;</div><div class="k">x402 services catalogued</div></div>
      <div class="stat"><div class="v" id="s-cadence">6&times;</div><div class="k">sweeps per day, every day</div></div>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <div class="sec-label">02 / How a score is earned</div>
    <div class="tiers">
      <div class="tier"><div class="t">T0</div><div class="n">Settlement</div><div class="d">We pay the advertised price in USDC on Base. Did the service deliver after taking the money?</div><div class="wgt">40%</div><div class="bar"><i style="width:40%"></i></div></div>
      <div class="tier"><div class="t">T1</div><div class="n">Schema</div><div class="d">Does the response match the shape the service itself advertises? One in five don&rsquo;t.</div><div class="wgt">30%</div><div class="bar"><i style="width:30%"></i></div></div>
      <div class="tier"><div class="t">T2</div><div class="n">Ground truth</div><div class="d">Where reality is checkable &mdash; prices, rates, coordinates &mdash; we check it against independent references.</div><div class="wgt">20%</div><div class="bar"><i style="width:20%"></i></div></div>
      <div class="tier"><div class="t">T3</div><div class="n">Judge</div><div class="d">An LLM grades what mechanical checks can&rsquo;t: is the translation right, is the news real, is the answer useful?</div><div class="wgt">10%</div><div class="bar"><i style="width:10%"></i></div></div>
    </div>
    <p class="api-note">No score is published before 20 probes spread across days &mdash; a service that only works when it feels like it can&rsquo;t hide in an afternoon of good behavior.</p>
  </div>
</section>

<section id="api">
  <div class="wrap">
    <div class="sec-label">03 / Query the oracle</div>
    <div class="api-grid">
      <div>
        <div class="term"><pre><span class="cmt"># tier &mdash; free, cache-friendly</span>
curl https://assay.nominal-labs.com/tier/{service-url}

<span class="g">{"service":"…","tier":"gold"}</span></pre></div>
        <p class="api-note">gold &middot; ok &middot; avoid &middot; unrated &mdash; enough for a spend-guard.</p>
      </div>
      <div>
        <div class="term"><pre><span class="cmt"># full score &mdash; <span class="price">$0.005 USDC</span> via x402</span>
curl https://assay.nominal-labs.com/score/{service-url}
<span class="cmt"># &rarr; HTTP 402 &rarr; any x402 client pays &amp; retries</span>

<span class="g">{"composite":93.1,"components":{…},
 "nProbes":41,"trend":+1.2}</span></pre></div>
        <p class="api-note">Machine-payable, no API key, no account. The way it should be.</p>
      </div>
    </div>
  </div>
</section>

<section id="proof">
  <div class="wrap">
    <div class="sec-label">04 / Trust nothing, verify us</div>
    <div class="proof">
      <p><em>Every probe is a real purchase.</em> Our probe wallet&rsquo;s spending is public on
      <a href="https://basescan.org/address/0x8a1A037b4fb377fceCd0F8A0B91A6A35df78Aa53" rel="noopener" target="_blank">Basescan</a> &mdash;
      the receipts behind every score, visible to anyone.</p>
      <p><em>History is proven, not claimed.</em> Each day&rsquo;s corpus is sealed into a merkle root and anchored via
      OpenTimestamps to Bitcoin. Nobody &mdash; including us &mdash; can rewrite what we observed.</p>
      <p><em>Scores are never for sale.</em> Operators can pay for monitoring; the number itself can&rsquo;t be bought.
      The day that changes, this whole instrument is worthless &mdash; so it won&rsquo;t.</p>
    </div>
  </div>
</section>

<div class="wrap">
  <footer>
    <span class="mark">ASSAY<span>.</span></span>
    <span>an instrument of Nominal Labs</span>
    <div class="right">
      <a href="/leaderboard">leaderboard</a>
      <a href="/healthz">status</a>
      <a href="mailto:info@nominal-labs.com">contact</a>
    </div>
  </footer>
</div>

<script>
(function () {
  'use strict';
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var el = document.getElementById('flick');

  // ---- oscillating word ----
  if (!reduced && el) {
    var words = ['PAY', 'PROBE', 'TEST', 'SCORE', 'PROVE', 'VERIFY'];
    var jits = ['', 'jit1', 'jit2', 'jit3'];
    var i = 0;
    function strobe(framesLeft) {
      el.className = 'w ' + jits[Math.floor(Math.random() * jits.length)];
      el.textContent = words[i % words.length];
      i++;
      if (framesLeft > 0) {
        setTimeout(function () { strobe(framesLeft - 1); }, 70 + Math.random() * 80);
      } else {
        el.className = 'w lock';
        el.textContent = 'ASSAY';
        setTimeout(function () { strobe(12 + Math.floor(Math.random() * 8)); }, 1700);
      }
    }
    strobe(14);
  } else if (el) {
    el.className = 'w lock';
    el.textContent = 'ASSAY';
  }

  // ---- live stats ----
  function fmt(n) { return Number(n).toLocaleString('en-US'); }
  fetch('/api/status').then(function (r) { return r.json(); }).then(function (s) {
    document.getElementById('s-services').textContent = fmt(s.services.curated);
    document.getElementById('s-probes').textContent = fmt(s.probesTotal);
    document.getElementById('s-catalog').textContent = fmt(s.services.discovered);
  }).catch(function () {});

  // ---- probe log tape ----
  fetch('/api/probes?limit=18').then(function (r) { return r.json(); }).then(function (rows) {
    var bits = rows.map(function (p) {
      var ok = p.ok_settlement === 1 && (p.ok_schema === null || p.ok_schema === 1);
      return '<span>' + (ok ? '<span class="ok">&#10003;</span>' : '<span class="bad">&#10007;</span>') + ' ' +
        String(p.domain || '').replace(/[<>&]/g, '') +
        ' &middot; $' + p.usdc_cost + ' &middot; ' + (p.latency_ms || '?') + 'ms' +
        (p.payment_tx ? ' &middot; tx ' + String(p.payment_tx).slice(0, 10) + '&hellip;' : '') +
        '</span>';
    });
    if (bits.length) {
      var half = bits.join('<span style="opacity:.35">/</span>');
      document.getElementById('tape').innerHTML = half + '<span style="opacity:.35">/</span>' + half;
    }
  }).catch(function () {});
})();
</script>
</body>
</html>`;
