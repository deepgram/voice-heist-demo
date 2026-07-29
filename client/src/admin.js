// Admin portal — event controls for the Deepgram team.
// The page is inert without a valid vh_admin cookie; all data/actions are
// guarded server-side by require_admin. This just drives the UI.

const $ = (id) => document.getElementById(id);
const show = (id) => { $(id).hidden = false; };
const hide = (id) => { $(id).hidden = true; };

// Display names for the heist ids the API returns.
const HEIST_NAMES = {
  list: "The List",
  order: "The Order",
  receptionist: "The Receptionist",
  refund: "The Refund",
};

let toastTimer = null;
function toast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (isError ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 2600);
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    credentials: "include",
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    ...opts,
  });
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}));
    throw new Error(detail.detail || `${r.status}`);
  }
  return r.json();
}

function renderAvailability(all, available) {
  const box = $("heistChecks");
  box.innerHTML = "";
  for (const id of all) {
    const label = document.createElement("label");
    label.className = "check";
    label.innerHTML = `
      <input type="checkbox" value="${id}" ${available.includes(id) ? "checked" : ""} />
      <span class="name">${HEIST_NAMES[id] || id}</span>
      <span class="id">${id}</span>`;
    box.appendChild(label);
  }
}

function renderTurns(all, turns) {
  const box = $("turnsRows");
  box.innerHTML = "";
  for (const id of all) {
    const row = document.createElement("div");
    row.className = "turns-row";
    row.innerHTML = `
      <span class="name">${HEIST_NAMES[id] || id}</span>
      <span class="id">${id}</span>
      <input type="number" min="1" max="20" step="1" value="${Number(turns[id]) || 5}" data-turns="${id}" />`;
    box.appendChild(row);
  }
}

async function loadPortal() {
  const s = await api("/api/admin/settings");
  renderAvailability(s.allScenarios, s.available);
  renderTurns(s.allScenarios, s.turns || {});
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function loadWinners() {
  const { winners } = await api("/api/admin/winners");
  const box = $("winnersList");
  if (!winners.length) {
    box.innerHTML = '<span class="muted">No scored plays yet.</span>';
    return;
  }
  box.innerHTML = winners.map((w) => `
    <div class="winner-row">
      <span class="winner-day">Week of ${esc(w.week)}</span>
      <span class="winner-name">${esc(w.codename)}${w.name ? " · " + esc(w.name) : ""}${w.email ? `<button type="button" class="win-mail" data-win-mail data-email="${esc(w.email)}" data-who="${esc(w.name || w.codename)}" data-day="${esc(w.week)}" data-total="${w.score}" title="Winner email for ${esc(w.email)}">✉ Winner email</button>` : ""}</span>
      <span class="winner-email">${w.email ? esc(w.email) : "—"}</span>
      <span class="winner-score">${Number(w.score).toLocaleString()} pts</span>
    </div>`).join("");
  // The prize outreach lives HERE — the weekly winners carry the week totals the
  // email quotes (the daily scores view is for cleanup, not outreach).
  box.querySelectorAll("[data-win-mail]").forEach((b) => b.addEventListener("click", onWinnerEmail));
}

// ---- players & scores (detailed, grouped by day, with delete) -------------

// Build a "you topped the board" email (subject + body) for a player — used for
// the weekly prize outreach. Shown in a popup the admin copies from — we
// deliberately do NOT open a mail client. Running your own season? Put your
// prize's details in the body before sending.
function winnerEmailText(who, day, total) {
  const subject = "🏆 The drop is arranged — you topped the Voice Heist board";
  const body = [
    `Hi ${who},`,
    "",
    `Congratulations — you took the Mastermind's Cut for the week of ${day} on the Voice Heist leaderboard! You talked your way past our voice agents and racked up ${Number(total).toLocaleString()} points.`,
    "",
    "Reply to this email with a shipping address and we'll arrange the drop — this week's prize, delivered to your door. (Replying also confirms this email is really yours; we only ship to confirmed winners.)",
    "",
    "Thanks for playing,",
    "The Voice Heist team",
  ].join("\n");
  return { subject, body };
}

// Winner-email popup: fill the readonly fields and show it.
function openWinModal({ to, subject, body }) {
  $("winTo").textContent = to;
  $("winSubject").value = subject;
  $("winBody").value = body;
  show("winModal");
}
function closeWinModal() { hide("winModal"); }

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement("textarea"); // fallback for odd contexts
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (__) { /* ignore */ }
    ta.remove();
  }
  const prev = btn.textContent;
  btn.textContent = "Copied!";
  setTimeout(() => (btn.textContent = prev), 1400);
}

function onWinnerEmail(e) {
  const { email, who, day, total } = e.currentTarget.dataset;
  const { subject, body } = winnerEmailText(who, day, total);
  openWinModal({ to: email, subject, body });
}

// Wired once (the modal is static markup); the per-row triggers are wired in loadScores.
function wireWinModal() {
  $("winClose").addEventListener("click", closeWinModal);
  $("winModal").addEventListener("click", (e) => { if (e.target.id === "winModal") closeWinModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("winModal").hidden) closeWinModal(); });
  $("winModal").querySelectorAll("[data-copy]").forEach((b) =>
    b.addEventListener("click", () => copyText($(b.dataset.copy).value, b)));
}

async function loadScores() {
  const { days } = await api("/api/admin/scores");
  const box = $("scoresList");
  if (!days.length) {
    box.innerHTML = '<span class="muted">No plays recorded yet.</span>';
    return;
  }
  box.innerHTML = days.map((d) => {
    const playsN = d.players.reduce((n, p) => n + p.plays.length, 0);
    const rows = d.players.map((p, i) => {
      const chips = p.plays.map((pl) => {
        const mark = pl.outcome === "win" ? "✓" : "✗";
        const pts = pl.score != null ? " " + Number(pl.score).toLocaleString() : "";
        // Prize audit: hover a chip to read the player's own lines for that run.
        const audit = pl.transcript ? ` title="${esc(pl.transcript)}"` : "";
        return `<span class="score-chip ${pl.outcome === "win" ? "win" : "lose"}"${audit}>${esc(HEIST_NAMES[pl.scenario] || pl.scenario)} ${mark}${pts}</span>`;
      }).join("");
      return `
        <div class="score-row" data-pid="${esc(p.pid)}" data-day="${esc(d.day)}">
          <span class="score-rank">${i + 1}</span>
          <span class="score-who">
            <span class="nm">${esc(p.codename)}${p.name ? " · " + esc(p.name) : ""}</span>${p.tier && p.tier !== "oauth" ? `<span class="tier">${esc(p.tier)}</span>` : ""}
            <span class="em">${p.email ? esc(p.email) : "—"}</span>
          </span>
          <span class="score-total">${Number(p.total).toLocaleString()} pts</span>
          <button class="score-del" data-del-row title="Delete this player's plays for ${esc(d.day)}">✕</button>
          <span class="score-plays">${chips}</span>
        </div>`;
    }).join("");
    return `
      <div class="score-day" data-day="${esc(d.day)}">
        <div class="score-day-head">
          <span class="day">${esc(d.day)}</span>
          <span class="meta">${d.players.length} player${d.players.length === 1 ? "" : "s"} · ${playsN} play${playsN === 1 ? "" : "s"}</span>
          <button class="btn btn--danger" data-del-day>Delete day</button>
        </div>
        ${rows}
      </div>`;
  }).join("");

  box.querySelectorAll("[data-del-day]").forEach((b) => b.addEventListener("click", onDeleteDay));
  box.querySelectorAll("[data-del-row]").forEach((b) => b.addEventListener("click", onDeleteRow));
}

async function onDeleteDay(e) {
  const day = e.target.closest(".score-day").dataset.day;
  if (!confirm(`Delete ALL plays for ${day}? Every player's scores for that day go, and this can't be undone.`)) return;
  try {
    const r = await api("/api/admin/scores/delete-day", { method: "POST", body: JSON.stringify({ day }) });
    toast(`Deleted ${r.deleted} play${r.deleted === 1 ? "" : "s"} for ${day}.`);
    await refreshScores();
  } catch (err) { toast("Couldn't delete day: " + err.message, true); }
}

async function onDeleteRow(e) {
  const row = e.target.closest(".score-row");
  const { pid, day } = row.dataset;
  const who = (row.querySelector(".nm")?.textContent || "this player").trim();
  if (!confirm(`Delete ${who}'s plays for ${day}? This can't be undone.`)) return;
  try {
    const r = await api("/api/admin/scores/delete-row", { method: "POST", body: JSON.stringify({ pid, day }) });
    toast(`Deleted ${r.deleted} play${r.deleted === 1 ? "" : "s"}.`);
    await refreshScores();
  } catch (err) { toast("Couldn't delete: " + err.message, true); }
}

// Deleting plays changes scores, winners and table counts — refresh all three.
async function refreshScores() {
  await loadScores().catch((e) => toast("Couldn't reload scores: " + e.message, true));
  await loadWinners().catch(() => {});
  await loadTables().catch(() => {});
}

function wirePortal() {
  $("saveAvail").addEventListener("click", async () => {
    const available = [...document.querySelectorAll("#heistChecks input:checked")].map((i) => i.value);
    try {
      const r = await api("/api/admin/availability", { method: "POST", body: JSON.stringify({ available }) });
      renderAvailability([...$("heistChecks").querySelectorAll("input")].map((i) => i.value), r.available);
      toast("Availability saved.");
    } catch (e) { toast("Couldn't save: " + e.message, true); }
  });

  $("saveTurns").addEventListener("click", async () => {
    const turns = {};
    for (const inp of document.querySelectorAll("#turnsRows input[data-turns]")) {
      turns[inp.dataset.turns] = parseInt(inp.value, 10) || 5;
    }
    try {
      const r = await api("/api/admin/turns", { method: "POST", body: JSON.stringify({ turns }) });
      renderTurns(Object.keys(r.turns), r.turns);
      toast("Turns saved.");
    } catch (e) { toast("Couldn't save turns: " + e.message, true); }
  });

  $("createUserBtn").addEventListener("click", async () => {
    const first = $("cuFirst").value.trim();
    const last = $("cuLast").value.trim();
    const email = $("cuEmail").value.trim();
    if (!email) return toast("Email is required.", true);
    if (!first && !last) return toast("Enter a first or last name.", true);
    try {
      const r = await api("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ first_name: first, last_name: last, email }),
      });
      const res = $("cuResult");
      res.hidden = false;
      res.innerHTML = `Created <b>${r.player.name || email}</b> — player code <b style="color:var(--primary)">${r.player.code}</b>`;
      $("cuFirst").value = $("cuLast").value = $("cuEmail").value = "";
      toast("User created.");
      loadTables(); // refresh row counts
    } catch (e) { toast("Couldn't create user: " + e.message, true); }
  });

  $("logout").addEventListener("click", (e) => {
    e.preventDefault();
    // Full-page navigation (not fetch): the backend clears our cookie and
    // redirects to the provider's logout so the Auth0 session ends too.
    location.href = "/api/admin/logout";
  });

  $("prevPage").addEventListener("click", () =>
    openTable(dataState.table, Math.max(0, dataState.offset - dataState.limit)));
  $("nextPage").addEventListener("click", () =>
    openTable(dataState.table, dataState.offset + dataState.limit));
}

// ---- data browser ---------------------------------------------------------
let dataState = { table: null, offset: 0, limit: 100, total: 0 };

async function loadTables() {
  try {
    const { tables } = await api("/api/admin/tables");
    const box = $("tableList");
    box.innerHTML = "";
    for (const t of tables) {
      const b = document.createElement("button");
      b.className = "table-chip";
      b.dataset.table = t.name;
      b.innerHTML = `${t.name} <span class="ct">${t.count}</span>`;
      b.addEventListener("click", () => openTable(t.name, 0));
      box.appendChild(b);
    }
  } catch (e) { toast("Couldn't load tables: " + e.message, true); }
}

async function openTable(name, offset) {
  try {
    const d = await api(`/api/admin/tables/${encodeURIComponent(name)}?limit=100&offset=${offset}`);
    dataState = { table: name, offset: d.offset, limit: d.limit, total: d.total };
    document.querySelectorAll(".table-chip").forEach((c) =>
      c.classList.toggle("active", c.dataset.table === name));
    renderTable(d);
    show("tableView");
  } catch (e) { toast(`Couldn't load ${name}: ${e.message}`, true); }
}

function renderTable(d) {
  const t = $("dataTable");
  t.innerHTML = "";
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  for (const c of d.columns) {
    const th = document.createElement("th");
    th.textContent = c;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  t.appendChild(thead);

  const tb = document.createElement("tbody");
  for (const row of d.rows) {
    const tr = document.createElement("tr");
    for (const v of row) {
      const td = document.createElement("td");
      const s = v === null ? "∅" : String(v);
      td.textContent = s.length > 200 ? s.slice(0, 200) + "…" : s;
      td.title = s; // full value on hover
      if (v === null) td.style.color = "var(--muted)";
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  }
  t.appendChild(tb);

  const from = d.total ? d.offset + 1 : 0;
  const to = d.offset + d.rows.length;
  $("tableMeta").textContent = `${dataState.table} — rows ${from}–${to} of ${d.total}`;
  $("prevPage").disabled = d.offset <= 0;
  $("nextPage").disabled = to >= d.total;
}

async function init() {
  const me = await api("/api/admin/me").catch(() => ({ email: null, oidc: false }));
  $("loading").hidden = true;

  if (me.email) {
    $("adminEmail").textContent = me.email;
    show("portal");
    wirePortal();
    wireWinModal();
    await loadPortal().catch((e) => toast("Couldn't load settings: " + e.message, true));
    await loadWinners().catch((e) => toast("Couldn't load winners: " + e.message, true));
    await loadScores().catch((e) => toast("Couldn't load scores: " + e.message, true));
    await loadTables().catch((e) => toast("Couldn't load tables: " + e.message, true));
    return;
  }

  // Signed out.
  if (new URLSearchParams(location.search).has("denied")) show("denied");
  if (!me.oidc) { show("noauth"); $("signinBtn").setAttribute("disabled", ""); }
  show("signin");
}

init();
