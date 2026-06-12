// Public arcade HIGH SCORES board for the booth TV (and anyone with the URL).
// No game/audio deps — polls /api/leaderboard and renders one ranked section per
// event day, newest first. Days accumulate (never wiped); the newest is LATEST.

const REFRESH_MS = 15000;
const RANK = { 1: "\u{1F451}", 2: "\u{1F948}", 3: "\u{1F949}" }; // 👑 🥈 🥉

const board = document.getElementById("board");
const updated = document.getElementById("updated");

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtDate(day) {
  // `day` is "YYYY-MM-DD" already in the event timezone — render as-is (UTC).
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
  });
}

function rowHtml(e) {
  const badge = RANK[e.rank] || e.rank;
  return `<div class="row${e.rank <= 3 ? " top3" : ""}" data-rank="${e.rank}">
    <div class="rank">${badge}</div>
    <div class="name">${escapeHtml(e.codename)}</div>
    <div class="score">${Number(e.score).toLocaleString()}</div>
  </div>`;
}

function dayHtml(d, isLatest) {
  const tag = isLatest ? '<span class="day-tag">LATEST</span>' : "";
  return `<section class="day${isLatest ? " latest" : ""}">
    <div class="day-head"><span class="day-date">${fmtDate(d.day)}</span>${tag}</div>
    ${d.entries.map(rowHtml).join("")}
  </section>`;
}

async function refresh() {
  try {
    const r = await fetch("/api/leaderboard", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { days } = await r.json();
    if (!days || days.length === 0) {
      board.innerHTML = '<p class="empty">NO SCORES YET — BE THE FIRST!</p>';
    } else {
      board.innerHTML = `<div class="days">${days.map((d, i) => dayHtml(d, i === 0)).join("")}</div>`;
    }
    updated.textContent = "UPDATED " + new Date().toLocaleTimeString();
  } catch {
    updated.textContent = "RECONNECTING…";
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
