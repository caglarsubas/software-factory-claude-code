// The dashboard's page (P2-10): one HTML document, one script and one stylesheet, all served by
// the dashboard itself (its CSP allows nothing else). The script reads the launch token from the
// URL's fragment, keeps it in the tab's sessionStorage, and sends it as a bearer token. Every value
// it shows goes in with textContent: task titles and findings can carry issue text, which is
// untrusted, so nothing is ever parsed as markup. Its commands are JSON POSTs that the dashboard
// passes to serve.

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Factory dashboard</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header><h1>Software factory</h1><span id="serve"></span><span id="status">connecting…</span></header>
<main>
<section id="board" aria-label="Board"></section>
<aside id="drawer" hidden aria-label="Evidence"></aside>
</main>
<script src="/app.js"></script>
</body>
</html>
`;

export const APP_CSS = `:root { color-scheme: light dark; --bg: #f7f7f8; --card: #fff; --line: #d9d9de; --text: #1d1d20; --muted: #6b6b74; --accent: #3b5bdb; --warn: #c2410c; }
@media (prefers-color-scheme: dark) { :root { --bg: #16171a; --card: #1f2024; --line: #33343a; --text: #e9e9ec; --muted: #9a9aa3; --accent: #7c93ff; --warn: #fb923c; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--text); }
header { display: flex; align-items: baseline; gap: 16px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
h1 { font-size: 16px; margin: 0; }
#status { color: var(--muted); font-size: 12px; }
main { display: flex; gap: 12px; padding: 12px 16px; align-items: flex-start; }
#board { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(180px, 1fr); gap: 10px; flex: 1; overflow-x: auto; }
.column h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 6px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 8px; margin-bottom: 8px; cursor: pointer; }
.card:focus, .card:hover { outline: 2px solid var(--accent); }
.card .id { font-weight: 600; }
.card .meta { color: var(--muted); font-size: 12px; }
.badge { display: inline-block; font-size: 11px; padding: 0 6px; border-radius: 8px; border: 1px solid var(--line); margin-right: 4px; }
.badge.warn { color: var(--warn); border-color: var(--warn); }
#drawer { width: min(520px, 45vw); background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 12px; max-height: calc(100vh - 90px); overflow: auto; position: sticky; top: 12px; }
#drawer h2 { font-size: 15px; margin: 0 0 4px; }
#drawer h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 14px 0 4px; }
#drawer ul { margin: 0; padding-left: 18px; }
#drawer table { border-collapse: collapse; width: 100%; font-size: 12px; }
#drawer td, #drawer th { text-align: left; padding: 2px 6px 2px 0; border-bottom: 1px solid var(--line); }
code { font: 12px ui-monospace, monospace; }
button.close { float: right; }
#serve { display: flex; gap: 6px; align-items: baseline; font-size: 12px; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.actions input[type=text] { flex: 1 1 100%; font: inherit; padding: 2px 4px; }
.note { color: var(--muted); font-size: 12px; }
button.danger { color: var(--warn); }
`;

export const APP_JS = `"use strict";
(() => {
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.get("token")) {
    sessionStorage.setItem("sf-dashboard-token", fragment.get("token"));
    history.replaceState(null, "", location.pathname);
  }
  const token = sessionStorage.getItem("sf-dashboard-token") || "";
  const headers = { authorization: "Bearer " + token };
  const status = document.getElementById("status");
  const boardEl = document.getElementById("board");
  const drawerEl = document.getElementById("drawer");
  let openTask = null;
  let cursor = 0;
  let pending = null;
  let serveState = { running: false };
  // The reason being typed survives the drawer's refreshes; opening another task clears it.
  let draft = "";
  const serveEl = document.getElementById("serve");
  const ENDED = ["DONE", "ROLLED_BACK", "FAILED", "CANCELLED", "SUPERSEDED"];

  const el = (tag, text, cls) => {
    const e = document.createElement(tag);
    if (text !== undefined && text !== null) e.textContent = String(text);
    if (cls) e.className = cls;
    return e;
  };
  const add = (parent, ...children) => { for (const c of children) parent.appendChild(c); return parent; };
  const usd = (n) => "$" + Number(n).toFixed(2);
  const short = (sha) => (sha ? sha.slice(0, 12) : "—");

  async function get(path) {
    const r = await fetch(path, { headers });
    if (r.status === 401) throw new Error("open the address factoryctl dashboard printed (the token is in it)");
    if (!r.ok) throw new Error(path + ": HTTP " + r.status);
    return r.json();
  }

  // A command goes to serve through the dashboard; serve's answer is shown as it came.
  async function post(path, body) {
    try {
      const r = await fetch(path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body || {}) });
      const b = await r.json().catch(() => ({}));
      status.textContent = b.message || b.error || ("HTTP " + r.status);
    } catch (e) {
      status.textContent = String(e.message || e);
    }
    await renderServe().catch(() => undefined);
    refreshSoon(null);
  }

  function button(text, onClick, cls) {
    const b = el("button", text, cls);
    b.type = "button";
    b.disabled = !serveState.running;
    b.addEventListener("click", onClick);
    return b;
  }

  async function renderServe() {
    serveState = await get("/api/serve");
    const s = serveState;
    const label = !s.running ? "serve: not running (commands need it)" : "serve: " + (s.halted ? "halted" : s.draining ? "draining" : s.paused ? "paused" : "running") + " · " + s.workers + " worker(s)";
    serveEl.replaceChildren(el("span", label, "note"),
      button(s.paused ? "Resume new work" : "Pause new work", () => post(s.paused ? "/api/serve/resume" : "/api/serve/pause")),
      button("Drain", () => { if (confirm("Drain: serve stops once its running tasks end. Continue?")) post("/api/serve/drain"); }));
  }

  function cardEl(c) {
    const card = el("div", null, "card");
    card.tabIndex = 0;
    add(card, el("div", c.id, "id"), el("div", c.title));
    const meta = el("div", null, "meta");
    add(meta, el("span", c.state + (c.gate ? " · " + c.gate + " gate" : ""), "badge"));
    if (c.tier) add(meta, el("span", c.tier, "badge"));
    if (c.paused) add(meta, el("span", "paused", "badge warn"));
    if (c.priority !== "normal") add(meta, el("span", c.priority + " priority", "badge"));
    add(meta, el("span", usd(c.costUsd)));
    add(card, meta, el("div", c.repo, "meta"));
    const open = () => { if (openTask !== c.id) draft = ""; openTask = c.id; renderDrawer(true).catch((e) => { status.textContent = String(e.message || e); }); };
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
    return card;
  }

  async function renderBoard() {
    const b = await get("/api/board");
    cursor = Math.max(cursor, b.cursor);
    boardEl.replaceChildren(...b.columns.map((col) => {
      const c = el("div", null, "column");
      add(c, el("h2", col.name + " (" + col.cards.length + ")"));
      for (const card of col.cards) c.appendChild(cardEl(card));
      return c;
    }));
  }

  function section(title, ...children) {
    const s = el("section");
    add(s, el("h3", title), ...children);
    return s;
  }
  function list(items) {
    const ul = el("ul");
    for (const i of items) ul.appendChild(el("li", i));
    if (items.length === 0) ul.appendChild(el("li", "none"));
    return ul;
  }
  function table(head, rows) {
    const t = el("table");
    const tr = el("tr");
    for (const h of head) tr.appendChild(el("th", h));
    t.appendChild(tr);
    for (const r of rows) {
      const row = el("tr");
      for (const v of r) row.appendChild(el("td", v));
      t.appendChild(row);
    }
    return t;
  }

  function actions(c) {
    if (ENDED.includes(c.state)) return section("Actions", el("p", "the task has ended", "note"));
    const reason = el("input");
    reason.type = "text";
    reason.placeholder = "reason (optional)";
    reason.maxLength = 500;
    reason.value = draft;
    reason.addEventListener("input", () => { draft = reason.value; });
    const why = () => { const r = reason.value.trim(); draft = ""; return r === "" ? {} : { reason: r }; };
    const base = "/api/tasks/" + encodeURIComponent(c.id) + "/";
    const priority = el("select");
    for (const p of ["low", "normal", "high"]) {
      const o = el("option", p);
      o.value = p;
      o.selected = p === c.priority;
      priority.appendChild(o);
    }
    priority.disabled = !serveState.running;
    const row = el("div", null, "actions");
    add(row, reason,
      button(c.paused ? "Resume" : "Pause", () => post(base + (c.paused ? "resume" : "pause"), why())),
      priority,
      button("Set priority", () => post(base + "priority", { priority: priority.value, ...why() })),
      button("Cancel task", () => { if (confirm("Cancel " + c.id + "? This ends the task.")) post(base + "cancel", why()); }, "danger"));
    const s = section("Actions", row);
    if (!serveState.running) s.appendChild(el("p", "serve is not running: these go through it. Until it runs, use the CLI (factoryctl pause, resume, priority, cancel).", "note"));
    return s;
  }

  async function renderDrawer(opening) {
    if (openTask === null) { drawerEl.hidden = true; return; }
    const d = await get("/api/tasks/" + encodeURIComponent(openTask) + (opening ? "?open=1" : ""));
    const close = el("button", "close", "close");
    close.addEventListener("click", () => { openTask = null; drawerEl.hidden = true; });
    const c = d.card;
    drawerEl.replaceChildren(
      close,
      el("h2", c.id + " · " + c.title),
      el("div", c.state + (c.gate ? " (" + c.gate + " gate)" : "") + " · " + c.priority + " priority · " + c.repo, "meta"),
      actions(c),
      section("Spec", el("p", d.spec ? d.spec.objective : "no spec yet"), list(d.spec ? d.spec.acceptance.map((a) => a.id + ": " + a.statement) : [])),
      section("Tier", el("p", d.tier ? d.tier.tier : "not decided yet"), list(d.tier ? d.tier.rules : [])),
      section("Commits", el("p", "base " + short(d.commits.base) + " · candidate " + short(d.commits.candidate))),
      section("Cost", el("p", d.budget ? usd(d.budget.spentUsd) + " of the " + d.budget.tier + " budget " + usd(d.budget.usd) : usd(c.costUsd)),
        table(["stage", "model", "cost", "cap"], d.stages.map((s) => [s.label, s.model || "—", usd(s.costUsd), s.capUsd === null ? "—" : usd(s.capUsd)]))),
      section("Gates", list(d.gates.map((g) => g.name + ": " + g.status + " — " + g.summary))),
      section("Findings", list(d.findings.map((f) => f.severity + " · " + f.reviewer + " · " + f.title + (f.file ? " (" + f.file + ")" : "")))),
      section("Verdict", el("p", d.verdict ? d.verdict.decision + (d.verdict.confidence === null ? "" : " (" + d.verdict.confidence + ")") + " — " + d.verdict.rationale : "none yet")),
      section("Human decisions", list(d.decisions.map((x) => x.at + " · " + x.by + " · " + x.what))),
      section("Code graph (shadow)", list(d.blast)),
      section("Timeline", list(d.timeline.slice().reverse().slice(0, 100).map((t) => t.at + " · " + t.type + (t.summary ? " · " + t.summary : "")))),
    );
    drawerEl.hidden = false;
  }

  function refreshSoon(task) {
    if (pending !== null) return;
    pending = setTimeout(async () => {
      pending = null;
      try {
        await renderBoard();
        if (openTask !== null && (task === null || task === openTask)) await renderDrawer(false);
      } catch (e) { status.textContent = String(e.message || e); }
    }, 300);
  }

  async function stream() {
    for (;;) {
      try {
        const r = await fetch("/api/stream?after=" + cursor, { headers });
        if (!r.ok || !r.body) throw new Error("stream: HTTP " + r.status);
        status.textContent = "live";
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\\n\\n")) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (!chunk.startsWith("data: ")) continue;
            const e = JSON.parse(chunk.slice(6));
            cursor = Math.max(cursor, e.cursor);
            refreshSoon(e.task);
          }
        }
      } catch (e) {
        status.textContent = "reconnecting… (" + String(e.message || e) + ")";
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  renderServe().catch(() => undefined);
  setInterval(() => { renderServe().catch(() => undefined); }, 5000);
  renderBoard().then(stream, (e) => { status.textContent = String(e.message || e); });
})();
`;
