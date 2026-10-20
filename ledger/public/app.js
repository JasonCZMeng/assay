// Wallet Ledger UI — vanilla JS, no build step. d3 is loaded globally for the flow map.
const $ = (sel, el = document) => el.querySelector(sel);
const view = $("#view");
const tooltip = $("#tooltip");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usd = (n) => (n === null || n === undefined ? "—" : n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(n) < 1 && n !== 0 ? 4 : 2 }));
const date = (ts) => new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ");
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const amt = (s) => { const [i, f = ""] = s.split("."); return Number(i).toLocaleString() + (f ? "." + f.slice(0, 6) : ""); };

const COUNTERPARTY_CATEGORIES = ["cex", "offramp-provider", "defi", "bridge", "vendor", "customer", "payroll", "other"];
const FLAG_LABEL = {
  "uncategorized": "Uncategorized",
  "cross-entity-undocumented": "Cross-entity · untagged",
  "cross-entity-documented": "Cross-entity · tagged",
  "unpriced": "No USD price",
};
const FLAG_CLASS = { "cross-entity-undocumented": "bad", "uncategorized": "warn", "unpriced": "warn" };
const ISSUE_TEXT = {
  "entity-mismatch": "Off-ramp account belongs to a different entity than the sending wallet",
  "undocumented-cross-entity": "Funds crossed between entities through an untagged transfer",
  "unknown-origin": "Part of the amount has no tracked source (history gap or unsynced wallet)",
  "unlinked-offramp": "Off-ramp account is not assigned to an entity",
};

let state = null;
let tab = localGet("tab") || "ledger";
const filters = { entity: "", wallet: "", chain: "", from: "", to: "", flag: "", q: "" };

function localGet(k) { try { return localStorage.getItem("ledger." + k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem("ledger." + k, v); } catch { /* private mode */ } }

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", "x-ledger": "1", ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function entityColor(id) {
  const idx = state.entities.findIndex((e) => e.id === id);
  return idx < 0 ? "var(--neutral-node)" : `var(--e${(idx % 8) + 1})`;
}
function entityName(id) { return state.entities.find((e) => e.id === id)?.name ?? ""; }
function walletTag(entityId, label) { return `<span title="${esc(entityName(entityId))}"><span class="dot" style="background:${entityColor(entityId)}"></span>${esc(label)}</span>`; }
function entityTag(id) { return id == null ? '<span class="muted">—</span>' : `<span class="dot" style="background:${entityColor(id)}"></span>${esc(entityName(id))}`; }
function chainName(id) { return state.chains.find((c) => c.id === id)?.name ?? id; }
function txLink(chainId, hash) {
  const c = state.chains.find((x) => x.id === chainId);
  return c ? `<a class="mono" href="${c.explorer}/tx/${esc(hash)}" target="_blank" rel="noopener">${short(hash)}</a>` : short(hash);
}
function qs(obj) { return new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== "" && v != null)).toString(); }

async function loadState() { state = await api("/api/state"); renderSync(); }

// ---------- sync ----------
let syncTimer = null;
function renderSync() {
  const s = state.sync;
  const btn = $("#sync-btn");
  btn.disabled = s.running;
  btn.textContent = s.running ? "Syncing…" : "Sync all";
  const last = s.log.at(-1) ?? "";
  $("#sync-status").textContent = s.running ? last.slice(9) : s.error ? `Sync failed: ${s.error}` : s.finishedAt ? `Synced ${new Date(s.finishedAt).toLocaleTimeString()} · ${state.provider}` : state.provider;
  if (s.running && !syncTimer) syncTimer = setInterval(pollSync, 1500);
}
async function pollSync() {
  state.sync = await api("/api/sync");
  renderSync();
  if (tab === "setup") renderSyncLog();
  if (!state.sync.running) { clearInterval(syncTimer); syncTimer = null; await loadState(); render(); }
}
async function startSync(only) {
  try { await api("/api/sync", { method: "POST", body: only ? { only } : {} }); } catch (e) { alert(e.message); }
  state.sync = await api("/api/sync");
  renderSync();
}
$("#sync-btn").onclick = () => startSync();

// ---------- tabs ----------
document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; localSet("tab", tab); render(); }));

function render() {
  view.onclick = view.onchange = null;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  if (!state.entities.length || !state.wallets.length) { if (tab !== "labels") tab = "setup"; }
  ({ ledger: renderLedger, graph: renderGraph, offramps: renderOfframps, labels: renderLabels, setup: renderSetup })[tab]();
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
}

function filterBar(opts = {}) {
  const sel = (name, items, all) => `<select name="${name}"><option value="">${all}</option>${items.map(([v, l]) => `<option value="${esc(v)}" ${String(filters[name]) === String(v) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  const wallets = state.wallets.filter((w) => !filters.entity || w.entityId === Number(filters.entity));
  return `<form class="filters" id="filters">
    ${sel("entity", state.entities.map((e) => [e.id, e.name]), "All entities")}
    ${opts.wallet === false ? "" : sel("wallet", wallets.map((w) => [w.address, w.label]), "All wallets")}
    ${sel("chain", state.chains.map((c) => [c.id, c.name]), "All chains")}
    <input type="date" name="from" value="${esc(filters.from)}" aria-label="From date">
    <input type="date" name="to" value="${esc(filters.to)}" aria-label="To date">
    ${opts.flag === false ? "" : sel("flag", Object.entries(FLAG_LABEL), "Any flag")}
    ${opts.q === false ? "" : `<input type="search" name="q" placeholder="Search label, address, tx, memo" value="${esc(filters.q)}">`}
    ${opts.extra ?? ""}
  </form>`;
}
function bindFilters(onChange) {
  const f = $("#filters");
  f.onsubmit = (e) => e.preventDefault();
  f.oninput = (e) => {
    if (!(e.target.name in filters)) return;
    filters[e.target.name] = e.target.value;
    if (e.target.name === "entity") filters.wallet = "";
    clearTimeout(f._t);
    f._t = setTimeout(onChange, e.target.type === "search" ? 250 : 0);
  };
}

// ---------- ledger ----------
const PAGE = 300;
async function renderLedger() {
  view.innerHTML = `${filterBar({ extra: `<button type="button" id="export">Export CSV</button>` })}<div id="ledger"></div>`;
  bindFilters(renderLedger);
  $("#export").onclick = () => { location.href = "/api/ledger.csv?" + qs(filters); };
  const { rows, totals } = await api("/api/ledger?" + qs(filters));
  const el = $("#ledger");
  if (!rows.length) { el.innerHTML = `<div class="card empty">No transfers match. ${state.sync.finishedAt ? "" : "Run a sync from Setup."}</div>`; return; }
  const flagStats = Object.entries(totals.flags).map(([k, n]) =>
    `<button class="chip ${FLAG_CLASS[k] ?? ""}" data-flag="${k}">${esc(FLAG_LABEL[k] ?? k)}: ${n}</button>`).join("");
  el.innerHTML = `
    <div class="stats">
      <div class="stat"><div class="v">${usd(totals.inUsd)}</div><div class="k">Inflows</div></div>
      <div class="stat"><div class="v">${usd(totals.outUsd)}</div><div class="k">Outflows</div></div>
      <div class="stat"><div class="v">${usd(totals.feeUsd)}</div><div class="k">Gas</div></div>
      <div class="stat"><div class="v">${totals.count.toLocaleString()}</div><div class="k">Entries</div></div>
    </div>
    <div class="row" style="margin-bottom:10px">${flagStats}</div>
    <div class="table-wrap"><table>
      <thead><tr><th>Date (UTC)</th><th>Wallet</th><th>Dir</th><th>Counterparty</th><th class="num">Amount</th><th class="num">USD</th><th>Category</th><th>Memo</th><th>Flags</th><th>Tx</th></tr></thead>
      <tbody id="ledger-body"></tbody>
    </table></div>
    <div class="row" style="justify-content:center;margin-top:10px"><button id="more" hidden>Show more</button></div>`;
  el.querySelectorAll("[data-flag]").forEach((b) => (b.onclick = () => { filters.flag = filters.flag === b.dataset.flag ? "" : b.dataset.flag; renderLedger(); }));
  let shown = 0;
  const more = () => {
    $("#ledger-body").insertAdjacentHTML("beforeend", rows.slice(shown, shown + PAGE).map(ledgerRow).join(""));
    shown += PAGE;
    $("#more").hidden = shown >= rows.length;
    $("#more").textContent = `Show more (${rows.length - shown} left)`;
  };
  $("#more").onclick = more;
  more();
  $("#ledger-body").onchange = async (e) => {
    const tr = e.target.closest("tr");
    try {
      await api(`/api/annotations/${encodeURIComponent(tr.dataset.id)}`, { method: "PUT", body: { category: tr.querySelector("select").value || null, memo: tr.querySelector(".memo").value || null } });
      if (e.target.tagName === "SELECT") renderLedger();
    } catch (err) { alert(err.message); }
  };
  $("#ledger-body").onclick = (e) => { const b = e.target.closest("[data-label]"); if (b) openLabelDialog(b.dataset.label); };
}

function ledgerRow(r) {
  const cp = r.counterparty;
  const cpCell = !cp ? '<span class="muted">network fee</span>'
    : cp.own ? `${entityTag(cp.entityId)} · ${esc(cp.label)}`
    : cp.labeled ? `${esc(cp.label)}${cp.entityId != null ? ` <span class="muted">(${esc(entityName(cp.entityId))})</span>` : ""}${cp.offramp ? ' <span class="chip">off-ramp</span>' : ""} <button class="link" data-label="${cp.address}" title="Edit label">✎</button>`
    : `<span class="mono" title="${cp.address}">${short(cp.address)}</span> <button class="link" data-label="${cp.address}">label</button>`;
  const cats = state.categories.map((c) => `<option ${c === r.category ? "selected" : ""}>${c}</option>`).join("");
  const sign = r.direction === "in" ? "+" : "−";
  return `<tr data-id="${esc(r.transferId)}">
    <td class="mono nowrap">${date(r.ts)}</td>
    <td class="nowrap" title="${esc(entityName(r.entityId))}"><span class="dot" style="background:${entityColor(r.entityId)}"></span>${esc(r.walletLabel)} <span class="muted">· ${esc(chainName(r.chainId))}</span></td>
    <td class="dir-${r.direction}">${r.direction}</td>
    <td>${cpCell}</td>
    <td class="num">${sign}${amt(r.amount)} ${esc(r.symbol)}</td>
    <td class="num">${usd(r.usd)}</td>
    <td class="nowrap"><select aria-label="Category" title="${r.categorySource === "auto" ? "Auto-assigned — pick one to confirm" : ""}"><option value="">—</option>${cats}</select>${r.categorySource === "auto" ? ' <span class="muted">auto</span>' : ""}</td>
    <td><input class="memo" value="${esc(r.memo)}" placeholder="memo" aria-label="Memo"></td>
    <td>${r.flags.map((f) => `<span class="chip ${FLAG_CLASS[f] ?? ""}">${FLAG_CLASS[f] === "bad" ? "⚠ " : ""}${esc(FLAG_LABEL[f] ?? f)}</span>`).join("")}</td>
    <td>${txLink(r.chainId, r.txHash)}</td>
  </tr>`;
}

// ---------- flow map ----------
let graphMinUsd = Number(localGet("minUsd") ?? 50);
async function renderGraph() {
  view.innerHTML = `
    ${filterBar({ wallet: false, flag: false, q: false, extra: `<label class="muted">Fold unlabeled under $<input type="number" id="min-usd" min="0" step="10" value="${graphMinUsd}" style="width:80px"></label>` })}
    <div class="graph-layout">
      <div>
        <svg id="graph-svg" role="img" aria-label="Flow map of wallets and counterparties"></svg>
        <div class="legend" id="legend"></div>
      </div>
      <div class="card" id="node-panel"><p class="muted">Click a bubble to see its flows. Drag to rearrange, scroll to zoom.</p></div>
    </div>`;
  bindFilters(renderGraph);
  $("#min-usd").onchange = (e) => { graphMinUsd = Number(e.target.value) || 0; localSet("minUsd", graphMinUsd); renderGraph(); };
  const g = await api("/api/graph?" + qs({ ...filters, wallet: "", flag: "", q: "", minUsd: graphMinUsd }));
  $("#legend").innerHTML = state.entities.map((e) => `<span><span class="dot" style="background:${entityColor(e.id)}"></span>${esc(e.name)} wallet</span>`).join("") +
    `<span><span class="dot" style="background:var(--neutral-node)"></span>External</span>
     <span><span class="dot" style="background:none;box-shadow:inset 0 0 0 2px var(--ink)"></span>Off-ramp</span>
     <span><span class="line bad"></span>Cross-entity · untagged</span>
     <span><span class="line doc"></span>Cross-entity · tagged</span>`;
  if (!g.nodes.length) { $("#graph-svg").outerHTML = '<div class="card empty">No flows yet.</div>'; return; }
  drawGraph(g);
}

function drawGraph({ nodes, edges }) {
  const svg = d3.select("#graph-svg");
  const { width, height } = svg.node().getBoundingClientRect();
  svg.attr("viewBox", [0, 0, width, height]);
  const vol = (n) => n.usdIn + n.usdOut;
  const r = d3.scaleSqrt().domain([0, d3.max(nodes, vol) || 1]).range([6, 42]);
  const w = d3.scaleSqrt().domain([0, d3.max(edges, (e) => e.usd) || 1]).range([1, 10]);
  const edgeColor = (e) => (e.flag === "cross-entity-undocumented" ? "var(--critical)" : e.flag ? "var(--ink-2)" : "var(--axis)");

  svg.append("defs").selectAll("marker").data(["n", "bad", "doc"]).join("marker")
    .attr("id", (d) => `arrow-${d}`).attr("viewBox", "0 -4 8 8").attr("refX", 8).attr("markerUnits", "userSpaceOnUse").attr("markerWidth", 10).attr("markerHeight", 10).attr("orient", "auto")
    .append("path").attr("d", "M0,-4L8,0L0,4").attr("fill", (d) => (d === "bad" ? "var(--critical)" : d === "doc" ? "var(--ink-2)" : "var(--axis)"));

  const root = svg.append("g");
  svg.call(d3.zoom().scaleExtent([0.2, 4]).on("zoom", (ev) => root.attr("transform", ev.transform)));

  const link = root.append("g").attr("fill", "none").selectAll("path").data(edges).join("path")
    .attr("stroke", edgeColor).attr("stroke-width", (e) => w(e.usd)).attr("stroke-opacity", 0.8)
    .attr("stroke-dasharray", (e) => (e.flag ? "6 4" : null))
    .attr("marker-end", (e) => `url(#arrow-${e.flag === "cross-entity-undocumented" ? "bad" : e.flag ? "doc" : "n"})`)
    .on("mousemove", (ev, e) => showTip(ev, `<b>${esc(label(e.source))} → ${esc(label(e.target))}</b><br>${usd(e.usd)} · ${e.count} transfer${e.count > 1 ? "s" : ""}<br>${esc(e.symbols.join(", "))}${e.flag ? `<br><b>${esc(FLAG_LABEL[e.flag])}</b>` : ""}`))
    .on("mouseleave", hideTip);

  const node = root.append("g").selectAll("g").data(nodes).join("g").style("cursor", "pointer")
    .call(d3.drag()
      .on("start", (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on("end", (ev, d) => { if (!ev.active) sim.alphaTarget(0); }));
  node.append("circle")
    .attr("r", (d) => r(vol(d)))
    .attr("fill", (d) => (d.kind === "wallet" ? entityColor(d.entityId) : "var(--neutral-node)"))
    .attr("fill-opacity", (d) => (d.kind === "wallet" ? 0.9 : 0.6))
    .attr("stroke", (d) => (d.offramp ? "var(--ink)" : d.entityId != null && d.kind !== "wallet" ? entityColor(d.entityId) : "var(--surface)"))
    .attr("stroke-width", (d) => (d.offramp || (d.entityId != null && d.kind !== "wallet") ? 3 : 2));
  node.append("text").attr("text-anchor", "middle").attr("dy", (d) => r(vol(d)) + 13).text((d) => d.label);
  node.on("mousemove", (ev, d) => showTip(ev, `<b>${esc(d.label)}</b>${d.offramp ? " · off-ramp" : ""}<br>In ${usd(d.usdIn)} · Out ${usd(d.usdOut)}<br>${d.count} transfers`))
    .on("mouseleave", hideTip)
    .on("click", (ev, d) => showNode(d, edges));

  const byId = new Map(nodes.map((n) => [n.id, n]));
  function label(x) { return (typeof x === "object" ? x : byId.get(x))?.label ?? x; }
  const sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(edges).id((d) => d.id).distance((e) => 110 + r(vol(e.source)) + r(vol(e.target))).strength(0.3))
    .force("charge", d3.forceManyBody().strength(-600))
    .force("collide", d3.forceCollide().radius((d) => r(vol(d)) + 14))
    .force("x", d3.forceX(width / 2).strength((d) => (d.kind === "wallet" ? 0.12 : 0.03)))
    .force("y", d3.forceY(height / 2).strength((d) => (d.kind === "wallet" ? 0.12 : 0.03)))
    .on("tick", () => {
      link.attr("d", (e) => {
        const dx = e.target.x - e.source.x, dy = e.target.y - e.source.y, len = Math.hypot(dx, dy) || 1;
        const tr = r(vol(e.target)) + 3, sr = r(vol(e.source));
        // gentle curve so A→B and B→A don't overlap
        const mx = (e.source.x + e.target.x) / 2 - dy * 0.12, my = (e.source.y + e.target.y) / 2 + dx * 0.12;
        return `M${e.source.x + (dx / len) * sr},${e.source.y + (dy / len) * sr}Q${mx},${my} ${e.target.x - (dx / len) * tr},${e.target.y - (dy / len) * tr}`;
      });
      node.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });
}

function showTip(ev, html) {
  tooltip.innerHTML = html; tooltip.hidden = false;
  const x = Math.min(ev.clientX + 14, innerWidth - tooltip.offsetWidth - 8);
  tooltip.style.left = x + "px"; tooltip.style.top = ev.clientY + 14 + "px";
}
function hideTip() { tooltip.hidden = true; }

function showNode(d, edges) {
  const rel = edges.filter((e) => e.source.id === d.id || e.target.id === d.id).sort((a, b) => b.usd - a.usd);
  const p = $("#node-panel");
  p.innerHTML = `<h2>${esc(d.label)}</h2>
    <p>${d.kind === "wallet" ? entityTag(d.entityId) + " wallet" : d.entityId != null ? "Controlled by " + entityTag(d.entityId) : d.kind}${d.offramp ? ' · <span class="chip">off-ramp</span>' : ""}</p>
    <p>In <b>${usd(d.usdIn)}</b> · Out <b>${usd(d.usdOut)}</b></p>
    <h3>Flows</h3>
    ${rel.map((e) => `<div class="row" style="justify-content:space-between"><span>${e.source.id === d.id ? "→ " + esc(e.target.label) : "← " + esc(e.source.label)}</span><span class="num">${usd(e.usd)}</span></div>${e.flag ? `<div class="chip ${FLAG_CLASS[e.flag] ?? ""}">${esc(FLAG_LABEL[e.flag])}</div>` : ""}`).join("")}
    <h3 style="margin-top:12px">Addresses</h3>
    ${d.addresses.slice(0, 50).map((a) => `<div class="row"><span class="mono">${short(a)}</span>${d.kind !== "wallet" ? `<button class="link" data-label="${a}">label</button>` : ""}</div>`).join("")}
    ${d.addresses.length > 50 ? `<p class="muted">+${d.addresses.length - 50} more</p>` : ""}`;
  p.onclick = (e) => { const b = e.target.closest("[data-label]"); if (b) openLabelDialog(b.dataset.label); };
}

// ---------- off-ramps ----------
async function renderOfframps() {
  view.innerHTML = '<div class="empty">Tracing…</div>';
  const { trails } = await api("/api/offramps");
  const clean = trails.filter((t) => t.status === "clean");
  const totalUsd = trails.reduce((s, t) => s + (t.row.usd ?? 0), 0);
  view.innerHTML = `
    <div class="stats">
      <div class="stat"><div class="v">${trails.length}</div><div class="k">Off-ramps</div></div>
      <div class="stat"><div class="v">${usd(totalUsd)}</div><div class="k">Total off-ramped</div></div>
      <div class="stat"><div class="v" style="color:var(--good-text)">✓ ${clean.length}</div><div class="k">Clean trail</div></div>
      <div class="stat"><div class="v" style="color:${trails.length - clean.length ? "var(--critical)" : "inherit"}">⚠ ${trails.length - clean.length}</div><div class="k">Need attention</div></div>
      <div class="row" style="margin-left:auto"><button id="export">Export audit trail CSV</button></div>
    </div>
    <p class="hint" style="margin-bottom:12px">Each off-ramp is traced back FIFO through your own wallets (and swaps) to the external inflows that funded it. Mark an address as off-ramp in Labels to include it.</p>
    ${trails.length ? trails.map(trailCard).join("") : '<div class="card empty">No off-ramps yet — label your exchange deposit addresses as off-ramps.</div>'}`;
  $("#export").onclick = () => { location.href = "/api/offramps.csv"; };
}

function trailCard(t) {
  const r = t.row;
  const status = t.status === "clean"
    ? '<span class="chip ok">✓ Clean</span>'
    : t.issues.map((i) => `<span class="chip bad" title="${esc(ISSUE_TEXT[i])}">⚠ ${esc(ISSUE_TEXT[i] ?? i)}</span>`).join("");
  const notes = t.notes.map(() => '<span class="chip">Includes a tagged cross-entity transfer</span>').join("");
  const sources = t.sources.map((s) => {
    const o = s.origin;
    const origin = o.kind === "unknown"
      ? '<span class="chip bad">⚠ Unknown origin</span>'
      : `${esc(o.fromParty?.label ?? short(o.from))}<div class="muted">${date(o.ts)} → ${esc(o.walletLabel)} ${o.originTxHash ? txLink(r.chainId, o.originTxHash) : ""}</div>`;
    const path = [walletTag(o.entityId, o.walletLabel), ...s.path.map((h) => {
      const cross = h.entityFrom !== h.entityTo;
      const cls = cross && !h.documented ? "hop-bad" : "";
      return h.kind === "swap"
        ? `<span class="arrow">⇄</span><span title="Swap">swap</span>`
        : `<span class="arrow ${cls}">${cross ? (h.documented ? "→ (tagged)" : "→ ⚠ untagged") : "→"}</span> ${walletTag(h.entityTo, h.toLabel)}`;
    }), `<span class="arrow">→</span> <b>${esc(t.offramp.label)}</b>`].join(" ");
    return `<tr><td class="num">${amt(s.amount)} ${esc(r.symbol)}</td><td class="num">${usd(s.usd)}</td><td>${origin}</td><td><div class="path">${path}</div></td></tr>`;
  }).join("");
  return `<details class="trail">
    <summary>
      <span class="mono">${date(r.ts)}</span>
      <span>${entityTag(r.entityId)} · ${esc(r.walletLabel)} → <b>${esc(t.offramp.label)}</b> ${t.offramp.entityId != null ? `<span class="muted">(${esc(entityName(t.offramp.entityId))})</span>` : ""}</span>
      <span class="num"><b>${amt(r.amount)} ${esc(r.symbol)}</b> · ${usd(r.usd)}</span>
      <span>${status}${notes}</span>
      <span style="margin-left:auto">${txLink(r.chainId, r.txHash)}</span>
    </summary>
    <div class="body"><div class="table-wrap"><table>
      <thead><tr><th class="num">Amount</th><th class="num">USD</th><th>Source</th><th>Path</th></tr></thead>
      <tbody>${sources}</tbody>
    </table></div></div>
  </details>`;
}

// ---------- labels ----------
async function renderLabels() {
  const { tokens } = await api("/api/tokens");
  const cps = state.counterparties;
  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:10px"><h2 style="margin:0">Counterparties</h2><button class="primary" id="add-cp">Add label</button></div>
      ${cps.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Label</th><th>Group</th><th>Category</th><th>Off-ramp</th><th>Controlled by</th><th>Address</th><th>Notes</th><th></th></tr></thead>
        <tbody>${cps.map((c) => `<tr>
          <td>${esc(c.label)}</td><td>${esc(c.group ?? "")}</td><td>${esc(c.category)}</td><td>${c.isOfframp ? "✓" : ""}</td>
          <td>${entityTag(c.entityId)}</td><td class="mono">${c.address}</td><td>${esc(c.notes ?? "")}</td>
          <td class="row"><button class="link" data-label="${c.address}">Edit</button><button class="link danger" data-del="${c.address}">Delete</button></td></tr>`).join("")}</tbody>
      </table></div>` : '<p class="muted">No labels yet. Label your exchange deposit addresses (mark them off-ramp and assign the entity whose account it is), vendors, and customers.</p>'}
    </div>
    <div class="card">
      <h2>Tokens</h2>
      <p class="hint" style="margin-bottom:8px">Hidden tokens are excluded from the ledger, map, and trails. Spam-looking names are hidden automatically — check "No USD price" rows in the ledger for fake look-alike tokens.</p>
      ${tokens.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Symbol</th><th>Name</th><th>Chain</th><th>Contract</th><th>Hidden</th></tr></thead>
        <tbody>${tokens.map((t) => `<tr><td>${esc(t.symbol)}</td><td>${esc(t.name ?? "")}</td><td>${esc(chainName(t.chainId))}</td><td class="mono">${esc(t.contract)}</td>
          <td><input type="checkbox" data-token="${t.chainId}/${esc(t.contract)}" ${t.hidden ? "checked" : ""} aria-label="Hide ${esc(t.symbol)}"></td></tr>`).join("")}</tbody>
      </table></div>` : '<p class="muted">Tokens appear after the first sync.</p>'}
    </div>`;
  $("#add-cp").onclick = () => openLabelDialog("");
  view.onclick = async (e) => {
    const edit = e.target.closest("[data-label]");
    if (edit) return openLabelDialog(edit.dataset.label);
    const del = e.target.closest("[data-del]");
    if (del && confirm("Delete this label?")) {
      await api(`/api/counterparties/${del.dataset.del}`, { method: "DELETE" });
      await loadState(); renderLabels();
    }
  };
  view.onchange = async (e) => {
    if (!e.target.dataset.token) return;
    await api(`/api/tokens/${e.target.dataset.token}`, { method: "PUT", body: { hidden: e.target.checked } });
  };
}

function openLabelDialog(address) {
  const dlg = $("#label-dialog"), f = $("#label-form");
  const c = state.counterparties.find((x) => x.address === address?.toLowerCase());
  f.category.innerHTML = COUNTERPARTY_CATEGORIES.map((x) => `<option>${x}</option>`).join("");
  f.entityId.innerHTML = `<option value="">Not mine (third party)</option>` + state.entities.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("");
  f.address.value = address || "";
  f.address.readOnly = !!address;
  f.label.value = c?.label ?? "";
  f.group.value = c?.group ?? "";
  f.category.value = c?.category ?? "cex";
  f.isOfframp.checked = c?.isOfframp ?? false;
  f.entityId.value = c?.entityId ?? "";
  f.notes.value = c?.notes ?? "";
  dlg.onclose = async () => {
    if (dlg.returnValue !== "save") return;
    try {
      await api(`/api/counterparties/${f.address.value.trim()}`, { method: "PUT", body: {
        label: f.label.value, group: f.group.value || null, category: f.category.value, isOfframp: f.isOfframp.checked,
        entityId: f.entityId.value ? Number(f.entityId.value) : null, notes: f.notes.value || null,
      } });
      await loadState(); render();
    } catch (err) { alert(err.message); }
  };
  dlg.showModal();
}

// ---------- setup ----------
function renderSetup() {
  const chainBoxes = state.chains.map((c) => `<label class="row" style="gap:4px"><input type="checkbox" name="chain" value="${c.id}" ${[1, 8453].includes(c.id) ? "checked" : ""}>${esc(c.name)}</label>`).join("");
  view.innerHTML = `
    <div class="grid2">
      <div class="card">
        <h2>1 · Entities</h2>
        <p class="hint" style="margin-bottom:10px">The separate books you keep — e.g. your corporation and yourself. Every wallet belongs to exactly one.</p>
        ${state.entities.map((e) => `<div class="row" style="justify-content:space-between;padding:4px 0">
          <span>${entityTag(e.id)} <span class="muted">${e.kind}</span></span>
          <span class="row"><button class="link" data-rename="${e.id}">Rename</button><button class="link danger" data-del-entity="${e.id}">Delete</button></span></div>`).join("")}
        <form class="inline" id="entity-form" style="margin-top:10px">
          <input name="name" placeholder="Acme Corp" required maxlength="80">
          <select name="kind"><option value="corporate">corporate</option><option value="personal">personal</option></select>
          <button class="primary">Add entity</button>
        </form>
      </div>
      <div class="card">
        <h2>Sync</h2>
        <p class="hint" style="margin-bottom:8px">Pulls native, internal and token transfers from ${esc(state.provider)}, then hourly USD prices from DefiLlama. Incremental — only new blocks after the first run.</p>
        <div class="log" id="sync-log"></div>
      </div>
    </div>
    <div class="card">
      <h2>2 · Wallets</h2>
      ${state.wallets.length ? `<div class="table-wrap" style="margin-bottom:12px"><table>
        <thead><tr><th>Label</th><th>Entity</th><th>Address</th><th>Chains</th><th>Last sync</th><th></th></tr></thead>
        <tbody>${state.wallets.map((w) => `<tr><td>${esc(w.label)}</td><td>${entityTag(w.entityId)}</td><td class="mono">${w.address}</td>
          <td>${w.chains.map(chainName).join(", ")}</td><td>${w.lastSync ? new Date(w.lastSync * 1000).toLocaleString() : '<span class="muted">never</span>'}</td>
          <td class="row"><button class="link" data-sync="${w.address}">Sync</button><button class="link" data-edit-wallet="${w.address}">Edit</button><button class="link danger" data-del-wallet="${w.address}">Remove</button></td></tr>`).join("")}</tbody>
      </table></div>` : ""}
      ${state.entities.length ? `<form class="inline" id="wallet-form">
        <input name="address" placeholder="0x…" required pattern="0x[0-9a-fA-F]{40}" size="44" spellcheck="false">
        <input name="label" placeholder="Corp treasury" required maxlength="80">
        <select name="entityId">${state.entities.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("")}</select>
        ${chainBoxes}
        <button class="primary">Save wallet</button>
      </form>` : '<p class="muted">Add an entity first.</p>'}
    </div>`;
  renderSyncLog();

  $("#entity-form").onsubmit = async (e) => {
    e.preventDefault();
    try { await api("/api/entities", { method: "POST", body: { name: e.target.name.value, kind: e.target.kind.value } }); await loadState(); render(); }
    catch (err) { alert(err.message); }
  };
  const wf = $("#wallet-form");
  if (wf) wf.onsubmit = async (e) => {
    e.preventDefault();
    const chains = [...wf.querySelectorAll('[name="chain"]:checked')].map((x) => Number(x.value));
    try {
      await api(`/api/wallets/${wf.address.value.trim()}`, { method: "PUT", body: { label: wf.label.value, entityId: Number(wf.entityId.value), chains } });
      await loadState(); render();
    } catch (err) { alert(err.message); }
  };
  view.onclick = async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    const d = t.dataset;
    try {
      if (d.sync) await startSync(d.sync);
      else if (d.editWallet) {
        const w = state.wallets.find((x) => x.address === d.editWallet);
        wf.address.value = w.address; wf.label.value = w.label; wf.entityId.value = w.entityId;
        wf.querySelectorAll('[name="chain"]').forEach((x) => (x.checked = w.chains.includes(Number(x.value))));
        wf.label.focus();
      } else if (d.delWallet && confirm("Stop tracking this wallet? Its transfers stay in the database but drop out of the ledger.")) {
        await api(`/api/wallets/${d.delWallet}`, { method: "DELETE" }); await loadState(); render();
      } else if (d.rename) {
        const ent = state.entities.find((x) => x.id === Number(d.rename));
        const name = prompt("Entity name", ent.name);
        if (name) { await api(`/api/entities/${ent.id}`, { method: "PUT", body: { name, kind: ent.kind } }); await loadState(); render(); }
      } else if (d.delEntity && confirm("Delete this entity?")) {
        await api(`/api/entities/${d.delEntity}`, { method: "DELETE" }); await loadState(); render();
      }
    } catch (err) { alert(err.message); }
  };
}
function renderSyncLog() {
  const el = $("#sync-log");
  if (el) { el.textContent = state.sync.log.join("\n") || "No sync run yet in this session."; el.scrollTop = el.scrollHeight; }
}

await loadState();
render();
