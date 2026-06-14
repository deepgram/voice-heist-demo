// Admin board for Voice Heist (demo build: no sign-in).
// Reads/writes /api/admin/config — which heists are live and each heist's turn
// cap. Both are read live server-side, so saved changes take effect on the next
// session and the next heist start, with no restart. See brain/app.py.

const panel = document.getElementById("panel");
const statusEl = document.getElementById("status");
const saveBtn = document.getElementById("save");

let cfg = null; // last-loaded config { games, turnsMin, turnsMax }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

function gameHtml(g, min, max) {
  return `<div class="game${g.available ? "" : " off"}" data-id="${escapeHtml(g.id)}">
    <div>
      <div class="game-title">${escapeHtml(g.title)}</div>
      <div class="game-id">${escapeHtml(g.id)}</div>
    </div>
    <div class="ctl">
      <span class="ctl-label">Turns</span>
      <input type="number" class="turns" min="${min}" max="${max}" value="${g.turns}" />
    </div>
    <div class="ctl">
      <span class="ctl-label">Live</span>
      <label class="switch">
        <input type="checkbox" class="avail"${g.available ? " checked" : ""} />
        <span class="slider"></span>
      </label>
    </div>
  </div>`;
}

function render() {
  panel.innerHTML = cfg.games.map((g) => gameHtml(g, cfg.turnsMin, cfg.turnsMax)).join("");
  // Dim a card the moment its toggle flips, for instant feedback.
  panel.querySelectorAll(".game").forEach((row) => {
    const toggle = row.querySelector(".avail");
    toggle.addEventListener("change", () => row.classList.toggle("off", !toggle.checked));
  });
  saveBtn.disabled = false;
}

function collect() {
  return [...panel.querySelectorAll(".game")].map((row) => {
    const n = Math.round(Number(row.querySelector(".turns").value));
    const turns = Math.min(cfg.turnsMax, Math.max(cfg.turnsMin, Number.isFinite(n) ? n : cfg.turnsMin));
    return { id: row.dataset.id, available: row.querySelector(".avail").checked, turns };
  });
}

async function load() {
  try {
    const r = await fetch("/api/admin/config", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    cfg = await r.json();
    render();
    setStatus("LOADED");
  } catch {
    panel.innerHTML = '<p class="loading">COULD NOT LOAD CONFIG</p>';
    setStatus("ERROR", "err");
  }
}

async function save() {
  saveBtn.disabled = true;
  setStatus("SAVING…");
  try {
    const r = await fetch("/api/admin/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ games: collect() }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    cfg = await r.json(); // server echoes the clamped/validated result
    render();
    setStatus("SAVED ✓", "ok");
  } catch {
    setStatus("SAVE FAILED", "err");
    saveBtn.disabled = false;
  }
}

saveBtn.addEventListener("click", save);
load();
