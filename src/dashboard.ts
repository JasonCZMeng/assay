// Self-contained ops dashboard served at /dashboard. No build step, no external assets;
// all data comes from the /api/* routes on this same server. The inline script deliberately
// avoids backticks/template literals so this file can hold it in one TS template string.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Assay · Ops</title>
<style>
  :root { color-scheme: light dark; }
  body {
    --surface:#fcfcfb; --plane:#f9f9f7; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
    --grid:#e1e0d9; --axis:#c3c2b7; --border:rgba(11,11,11,.10);
    --good:#0ca30c; --good-text:#006300; --warning:#fab219; --critical:#d03b3b; --gold:#eda100;
    --accent:#2a78d6;
    margin:0; background:var(--plane); color:var(--ink);
    font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    body {
      --surface:#1a1a19; --plane:#0d0d0d; --ink:#ffffff; --ink2:#c3c2b7; --muted:#898781;
      --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
      --good-text:#0ca30c; --gold:#c98500; --accent:#3987e5;
    }
  }
  .wrap { max-width:1160px; margin:0 auto; padding:20px 20px 48px; }
  header { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
  h1 { font-size:17px; margin:0; font-weight:650; }
  h2 { font-size:13px; margin:0 0 10px; font-weight:600; color:var(--ink2); text-transform:uppercase; letter-spacing:.04em; }
  .pill { display:inline-flex; align-items:center; gap:6px; padding:3px 10px; border-radius:999px;
          font-size:12px; font-weight:600; border:1px solid var(--border); }
  .pill .dot { width:8px; height:8px; border-radius:50%; }
  .addr { font-family:ui-monospace, Consolas, monospace; font-size:12px; color:var(--muted); }
  .spacer { flex:1; }
  button {
    font:inherit; font-size:13px; padding:6px 12px; border-radius:8px; cursor:pointer;
    border:1px solid var(--border); background:var(--surface); color:var(--ink);
  }
  button:hover:not(:disabled) { border-color:var(--axis); }
  button:disabled { opacity:.45; cursor:not-allowed; }
  button.danger { color:var(--critical); }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px,1fr)); gap:10px; margin-bottom:14px; }
  .tile { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px 14px; }
  .tile .k { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; }
  .tile .v { font-size:24px; font-weight:650; margin-top:2px; }
  .tile .s { font-size:12px; color:var(--ink2); margin-top:2px; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:14px 16px; margin-bottom:14px; }
  .legend { display:flex; gap:16px; font-size:12px; color:var(--ink2); margin-bottom:8px; }
  .legend .sw { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; vertical-align:-1px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em;
       font-weight:600; padding:6px 8px; border-bottom:1px solid var(--grid); }
  td { padding:7px 8px; border-bottom:1px solid var(--grid); vertical-align:top; }
  tr:hover td { background:color-mix(in srgb, var(--ink) 4%, transparent); }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  .chip { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; font-weight:650; }
  .chip.gold { background:color-mix(in srgb, var(--gold) 18%, transparent); color:var(--gold); }
  .chip.ok { background:color-mix(in srgb, var(--good) 15%, transparent); color:var(--good-text); }
  .chip.avoid { background:color-mix(in srgb, var(--critical) 14%, transparent); color:var(--critical); }
  .chip.unrated, .chip.retired { background:color-mix(in srgb, var(--muted) 15%, transparent); color:var(--muted); }
  .pass { color:var(--good-text); } .fail { color:var(--critical); } .na { color:var(--muted); }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .foot { font-size:12px; color:var(--muted); margin-top:6px; }
  .err { color:var(--critical); font-size:12px; }
  svg text { font:10.5px system-ui, sans-serif; fill:var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Assay · Ops</h1>
    <span class="pill" id="pill"><span class="dot" style="background:var(--muted)"></span>loading…</span>
    <span class="addr" id="addr"></span>
    <span class="spacer"></span>
    <button id="btnPause">Pause probing</button>
    <button id="btnProbe">Probe now</button>
    <button id="btnIngest">Ingest catalog now</button>
  </header>

  <div class="tiles" id="tiles"></div>

  <div class="card">
    <h2>Daily probe outcomes</h2>
    <div class="legend">
      <span><span class="sw" style="background:var(--good)"></span>&#10003; pass (paid &amp; schema ok)</span>
      <span><span class="sw" style="background:var(--critical)"></span>&#10007; fail</span>
    </div>
    <div id="chart"></div>
  </div>

  <div class="card">
    <h2>Services</h2>
    <div style="overflow-x:auto"><table id="services"></table></div>
  </div>

  <div class="card">
    <h2>Recent probes</h2>
    <div style="overflow-x:auto"><table id="probes"></table></div>
    <div class="foot">Sweeps run at 06:15 · 13:15 · 21:15 (+ up to 1h anti-fingerprint jitter). Auto-refresh every 15s.</div>
  </div>
</div>

<script>
(function () {
  'use strict';
  var paused = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtAgo(ts) {
    if (!ts) return '—';
    var s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 90) return Math.round(s) + 's ago';
    if (s < 5400) return Math.round(s / 60) + 'm ago';
    if (s < 129600) return (s / 3600).toFixed(1) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }
  function chip(t) { return '<span class="chip ' + esc(t) + '">' + esc(t) + '</span>'; }
  function pf(v, textPass, textFail) {
    if (v === null || v === undefined) return '<span class="na">—</span>';
    return v ? '<span class="pass">' + textPass + '</span>' : '<span class="fail">' + textFail + '</span>';
  }
  function txLink(tx) {
    if (!tx) return '<span class="na">—</span>';
    return '<a target="_blank" rel="noopener" href="https://basescan.org/tx/' + esc(tx) + '">' +
      esc(tx.slice(0, 10)) + '…</a>';
  }
  function getJSON(url) { return fetch(url).then(function (r) { return r.json(); }); }
  function ctl(path, body) {
    return fetch('/api/control/' + path, {
      method: 'POST',
      headers: { 'x-assay-control': '1', 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  function renderStatus(st) {
    paused = st.paused;
    var pill = document.getElementById('pill');
    pill.innerHTML = paused
      ? '<span class="dot" style="background:var(--warning)"></span>paused'
      : '<span class="dot" style="background:var(--good)"></span>probing live';
    document.getElementById('addr').textContent =
      st.wallet ? st.wallet.address : 'wallet: n/a';
    document.getElementById('btnPause').textContent = paused ? 'Resume probing' : 'Pause probing';
    document.getElementById('btnProbe').disabled = paused;

    var budgetPct = st.dailyBudgetUsdc ? Math.round(100 * st.spentToday / st.dailyBudgetUsdc) : 0;
    var tiles = [
      ['Wallet balance', st.wallet ? ('$' + st.wallet.usdc.toFixed(4)) : 'n/a', 'USDC on Base'],
      ['Spent today', '$' + Number(st.spentToday).toFixed(4), budgetPct + '% of $' + st.dailyBudgetUsdc + ' budget'],
      ['Probes (24h)', st.probes24h, st.probesTotal + ' total in corpus'],
      ['Services curated', st.services.curated, st.services.retired + ' retired'],
      ['Catalog size', st.services.discovered.toLocaleString(), 'Bazaar services discovered'],
      ['Last probe', fmtAgo(st.lastProbeTs), 'uptime ' + Math.floor(st.uptimeSec / 3600) + 'h ' + Math.floor(st.uptimeSec % 3600 / 60) + 'm']
    ];
    document.getElementById('tiles').innerHTML = tiles.map(function (t) {
      return '<div class="tile"><div class="k">' + t[0] + '</div><div class="v">' + t[1] +
        '</div><div class="s">' + t[2] + '</div></div>';
    }).join('');
  }

  function renderChart(days) {
    var el = document.getElementById('chart');
    if (!days.length) { el.innerHTML = '<div class="na">No probes yet.</div>'; return; }
    var W = 720, H = 150, L = 30, B = 20, plotW = W - L - 6, plotH = H - B - 8;
    var max = 1;
    days.forEach(function (d) { if (d.probes > max) max = d.probes; });
    var bw = Math.min(26, Math.floor(plotW / days.length) - 6);
    var y = function (v) { return 8 + plotH - (v / max) * plotH; };
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-width:760px;display:block">';
    [0, 0.5, 1].forEach(function (f) {
      var gy = y(max * f);
      s += '<line x1="' + L + '" y1="' + gy + '" x2="' + W + '" y2="' + gy +
        '" stroke="var(--grid)" stroke-width="1"/>';
      s += '<text x="' + (L - 5) + '" y="' + (gy + 3.5) + '" text-anchor="end">' + Math.round(max * f) + '</text>';
    });
    days.forEach(function (d, i) {
      var x = L + 4 + i * (plotW / days.length);
      var passH = (d.pass / max) * plotH;
      var failH = (d.fail / max) * plotH;
      var base = 8 + plotH;
      var title = '<title>' + esc(d.day) + ': ' + d.pass + ' pass, ' + d.fail + ' fail, $' + d.usdc + '</title>';
      if (d.pass > 0) s += '<rect x="' + x + '" y="' + (base - passH) + '" width="' + bw + '" height="' +
        Math.max(passH, 2) + '" rx="2" fill="var(--good)">' + title + '</rect>';
      if (d.fail > 0) s += '<rect x="' + x + '" y="' + (base - passH - 2 - failH) + '" width="' + bw +
        '" height="' + Math.max(failH, 2) + '" rx="2" fill="var(--critical)">' + title + '</rect>';
      s += '<text x="' + (x + bw / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' +
        esc(d.day.slice(5)) + '</text>';
    });
    s += '</svg>';
    el.innerHTML = s;
  }

  function renderServices(rows) {
    var h = '<tr><th>Service</th><th>Tier</th><th class="num">Score</th><th class="num">Probes</th>' +
      '<th>Last result</th><th class="num">GT dev %</th><th class="num">LLM</th><th class="num">ms</th>' +
      '<th class="num">$/probe</th><th>Last probed</th><th>Tx</th><th></th></tr>';
    rows.forEach(function (r) {
      var retired = r.status === 'retired';
      var lastResult = r.last_ts
        ? pf(r.ok_settlement, 'paid', 'no-pay') + ' · ' + pf(r.ok_schema, 'schema', 'schema')
        : '<span class="na">—</span>';
      var action = retired
        ? '<button data-restore="' + esc(r.id) + '">Restore</button>'
        : '<button class="danger" data-retire="' + esc(r.id) + '">Retire</button>';
      h += '<tr' + (retired ? ' style="opacity:.55"' : '') + '>' +
        '<td title="' + esc(r.id) + '">' + esc(r.domain) + (r.name ? ' <span class="na">· ' + esc(r.name) + '</span>' : '') + '</td>' +
        '<td>' + chip(retired ? 'retired' : r.tier) + '</td>' +
        '<td class="num">' + (r.composite != null ? r.composite.toFixed(1) : '—') + '</td>' +
        '<td class="num">' + (r.n_probes != null ? r.n_probes : 0) + '</td>' +
        '<td>' + lastResult + '</td>' +
        '<td class="num">' + (r.gt_deviation_pct != null ? r.gt_deviation_pct.toFixed(3) : '—') + '</td>' +
        '<td class="num">' + (r.llm_score != null ? r.llm_score.toFixed(2) : '—') + '</td>' +
        '<td class="num">' + (r.latency_ms != null ? r.latency_ms : '—') + '</td>' +
        '<td class="num">' + (r.price_usdc != null ? r.price_usdc : '—') + '</td>' +
        '<td>' + fmtAgo(r.last_ts) + '</td>' +
        '<td>' + txLink(r.payment_tx) + '</td>' +
        '<td>' + action + '</td></tr>';
    });
    document.getElementById('services').innerHTML = h;
  }

  function renderProbes(rows) {
    var h = '<tr><th>Time</th><th>Service</th><th class="num">HTTP</th><th>Paid</th><th>Schema</th>' +
      '<th class="num">GT dev %</th><th class="num">LLM</th><th class="num">ms</th><th class="num">$</th>' +
      '<th>Tx</th><th>Error</th></tr>';
    rows.forEach(function (r) {
      h += '<tr><td>' + fmtAgo(r.ts) + '</td>' +
        '<td title="' + esc(r.service_id) + '">' + esc(r.domain) + '</td>' +
        '<td class="num">' + (r.http_status != null ? r.http_status : '—') + '</td>' +
        '<td>' + pf(r.ok_settlement, '&#10003;', '&#10007;') + '</td>' +
        '<td>' + pf(r.ok_schema, '&#10003;', '&#10007;') + '</td>' +
        '<td class="num">' + (r.gt_deviation_pct != null ? r.gt_deviation_pct.toFixed(3) : '—') + '</td>' +
        '<td class="num">' + (r.llm_score != null ? r.llm_score.toFixed(2) : '—') + '</td>' +
        '<td class="num">' + (r.latency_ms != null ? r.latency_ms : '—') + '</td>' +
        '<td class="num">' + (r.usdc_cost != null ? r.usdc_cost : '—') + '</td>' +
        '<td>' + txLink(r.payment_tx) + '</td>' +
        '<td class="err" title="' + esc(r.error || '') + '">' + esc((r.error || '').slice(0, 60)) + '</td></tr>';
    });
    document.getElementById('probes').innerHTML = h;
  }

  function refresh() {
    getJSON('/api/status').then(renderStatus).catch(function () {});
    getJSON('/api/days?days=14').then(renderChart).catch(function () {});
    getJSON('/api/services').then(renderServices).catch(function () {});
    getJSON('/api/probes?limit=30').then(renderProbes).catch(function () {});
  }

  function busy(btn, fn) {
    btn.disabled = true;
    fn().catch(function (e) { alert(e.message); })
      .then(function () { btn.disabled = false; refresh(); });
  }

  document.getElementById('btnPause').addEventListener('click', function () {
    busy(this, function () { return ctl(paused ? 'resume' : 'pause'); });
  });
  document.getElementById('btnProbe').addEventListener('click', function () {
    if (!confirm('Run a full probe sweep now? This spends real USDC on every curated service.')) return;
    busy(document.getElementById('btnProbe'), function () { return ctl('probe-now'); });
  });
  document.getElementById('btnIngest').addEventListener('click', function () {
    busy(this, function () { return ctl('ingest-now'); });
  });
  document.body.addEventListener('click', function (ev) {
    var t = ev.target;
    if (t.dataset && t.dataset.retire) {
      if (!confirm('Retire ' + t.dataset.retire + '?\\nProbing stops immediately; history is kept.')) return;
      busy(t, function () { return ctl('service/retire', { id: t.dataset.retire }); });
    } else if (t.dataset && t.dataset.restore) {
      busy(t, function () { return ctl('service/restore', { id: t.dataset.restore }); });
    }
  });

  refresh();
  setInterval(refresh, 15000);
})();
</script>
</body>
</html>`;
