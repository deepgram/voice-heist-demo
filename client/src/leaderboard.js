// Public arcade HIGH SCORES board (anyone with the URL). No game/audio deps —
// polls /api/leaderboard and renders a gamer-first layout: TODAY'S RACE as the
// hero (live score bars, badges, YOU highlight, movement flashes), the all-time
// podium + latest-cracks pulse in the side rail, and previous days demoted to a
// compact history strip.

// Self-hosted fonts (no CDN: the page must look right on conference Wi-Fi).
import "@fontsource/inter/500.css";
import "@fontsource/inter/700.css";
import "@fontsource/inter/800.css";
import "@fontsource/orbitron/600.css";
import "@fontsource/orbitron/700.css";
import "@fontsource/orbitron/800.css";
import "@fontsource/orbitron/900.css";

const REFRESH_MS = 15000;
const RANK = { 1: "\u{1F451}", 2: "\u{1F948}", 3: "\u{1F949}" }; // 👑 🥈 🥉
const TODAY_MAX_ROWS = 10;

const els = {
  updated: document.getElementById("updated"),
  reset: document.getElementById("reset"),
  todayRows: document.getElementById("todayRows"),
  podium: document.getElementById("podium"),
  pulse: document.getElementById("pulse"),
  historyWrap: document.getElementById("historyWrap"),
  history: document.getElementById("history"),
};

// Own-device world: the game page stores the player's public codename in
// same-origin localStorage so this standalone page can point at "YOU".
let myCodename = null;
try {
  myCodename = localStorage.getItem("vh_codename");
} catch { /* storage unavailable */ }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Earned flair (🏆 sweep · ⚡ fastest crack · 🔥N streak).
function badgeHtml(list) {
  if (!list || !list.length) return "";
  return list.map((b) => {
    if (b.startsWith("streak:")) return `<span class="bdg" title="${b.slice(7)}-day streak">\u{1F525}${b.slice(7)}</span>`;
    if (b === "sweep") return '<span class="bdg" title="Clean sweep">\u{1F3C6}</span>';
    if (b === "fast") return '<span class="bdg" title="Fastest crack of the day">⚡</span>';
    return "";
  }).join("");
}

function fmtDate(day) {
  // `day` is "YYYY-MM-DD" already in the event timezone — render as-is (UTC).
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
  });
}

function agoText(min) {
  if (min == null) return "";
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

// Two-letter medallion initials from a codename ("Neon Sparrow 28" → "NS").
function initials(codename) {
  return codename.split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();
}

// ---- reset countdown --------------------------------------------------------
// "RESETS IN 3H 12M" — anchored from the server's resetInSec, ticked locally.
let resetAt = 0;
function renderReset() {
  if (!els.reset || !resetAt) return;
  const ms = Math.max(0, resetAt - Date.now());
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  els.reset.textContent =
    ms <= 60000 ? "RESETS ANY MOMENT" : h > 0 ? `RESETS IN ${h}H ${m}M` : `RESETS IN ${m}M`;
}
setInterval(renderReset, 30000);

// ---- today's race (hero) ------------------------------------------------------
// Positions from the previous poll, so a row that climbed flashes green — the
// race visibly moves while you watch.
let prevOrder = null;

function todayRowHtml(e, top, flash) {
  const mine = myCodename && e.codename === myCodename;
  const pct = Math.max(6, Math.round((e.score / top) * 100));
  // The codename truncates alone (.nm) so badges and the YOU marker never get
  // swallowed by the ellipsis on narrow screens.
  return `<div class="trow${e.rank === 1 ? " first" : ""}${mine ? " mine" : ""}${flash ? " up-flash" : ""}" data-rank="${e.rank}">
    <div class="trank">${RANK[e.rank] || e.rank}</div>
    <div class="tmain">
      <div class="tname"><span class="nm">${escapeHtml(e.codename)}</span>${badgeHtml(e.badges)}${mine ? '<span class="you">· YOU</span>' : ""}</div>
      <div class="tbar"><i style="--w:${pct}%"></i></div>
    </div>
    <div class="tscore">${Number(e.score).toLocaleString()}</div>
  </div>`;
}

function renderToday(entries, prevChampion) {
  if (!entries.length) {
    els.todayRows.innerHTML = `<div class="today-empty">NO SCORES YET TODAY — BE THE FIRST!${
      prevChampion
        ? `<br>${escapeHtml(prevChampion.codename)} set yesterday's bar at ${Number(prevChampion.score).toLocaleString()}.`
        : ""
    }<br><a class="play-link today-cta" href="/game" style="display:inline-block;margin-top:14px">&#9654; PLAY NOW</a></div>`;
    prevOrder = [];
    return;
  }
  const top = entries[0].score || 1;
  const wasAt = new Map((prevOrder || []).map((c, i) => [c, i]));
  const flash = (e, i) => {
    const was = wasAt.get(e.codename);
    return prevOrder !== null && was !== undefined && was > i;
  };
  let html = entries.slice(0, TODAY_MAX_ROWS)
    .map((e, i) => todayRowHtml(e, top, flash(e, i)))
    .join("");
  // A viewer ranked below the cut still finds themselves: pinned neighborhood.
  const ownIdx = myCodename ? entries.findIndex((e) => e.codename === myCodename) : -1;
  if (ownIdx >= TODAY_MAX_ROWS) {
    html += '<div class="tdivider" aria-hidden="true">· · ·</div>' +
      [entries[ownIdx - 1], entries[ownIdx], entries[ownIdx + 1]]
        .filter(Boolean)
        .map((e, i) => todayRowHtml(e, top, false))
        .join("");
  }
  els.todayRows.innerHTML = html;
  prevOrder = entries.map((e) => e.codename);
}

// ---- all-time podium ----------------------------------------------------------
const POD_ORDER = [2, 1, 3]; // classic silhouette: silver left, gold center, bronze right

function podiumStep(e, rank) {
  if (!e) {
    return `<div class="pstep ghost g${rank}">
      <div class="pcrown"></div>
      <div class="pmedal">?</div>
      <div class="pname">unclaimed</div>
      <div class="pscore">&mdash;</div>
      <div class="pdate">&nbsp;</div>
      <div class="pblock">${rank}</div>
    </div>`;
  }
  return `<div class="pstep g${rank}">
    <div class="pcrown">${rank === 1 ? "\u{1F451}" : ""}</div>
    <div class="pmedal">${escapeHtml(initials(e.codename))}</div>
    <div class="pname">${escapeHtml(e.codename)}</div>
    <div class="pscore">${Number(e.score).toLocaleString()}</div>
    <div class="pdate">${e.day ? fmtDate(e.day) : "&nbsp;"}</div>
    <div class="pblock">${rank}</div>
  </div>`;
}

function renderPodium(allTime) {
  const byRank = {};
  for (const e of allTime || []) byRank[e.rank] = e;
  els.podium.innerHTML = POD_ORDER.map((r) => podiumStep(byRank[r], r)).join("");
}

// ---- latest cracks (pulse) ----------------------------------------------------
function renderPulse(recent) {
  if (!recent || !recent.length) {
    els.pulse.innerHTML = '<p class="pulse-empty">Quiet right now — the first crack takes the spotlight.</p>';
    return;
  }
  els.pulse.innerHTML = recent.slice(0, 6).map((r) => `<div class="prow">
    <span class="pwho">${escapeHtml(r.codename)}</span>
    <span class="pverb">cracked</span>
    <span class="pheist">${escapeHtml(r.title)}</span>
    <span class="pplus">+${Number(r.score).toLocaleString()}</span>
    <span class="pago">${agoText(r.agoMin)}</span>
  </div>`).join("");
}

// ---- previous days (compact history) -------------------------------------------
function renderHistory(days, today) {
  const past = (days || []).filter((d) => d.day !== today && d.entries?.length);
  els.historyWrap.hidden = past.length === 0;
  if (!past.length) return;
  els.history.innerHTML = past.map((d) => {
    const rows = d.entries.slice(0, 3).map((e) => {
      const mine = myCodename && e.codename === myCodename;
      return `<div class="hrow${mine ? " mine" : ""}">
        <span class="hrank">${RANK[e.rank] || e.rank}</span>
        <span class="hname">${escapeHtml(e.codename)}${mine ? '<span class="you">· YOU</span>' : ""}</span>
        <span class="hscore">${Number(e.score).toLocaleString()}</span>
      </div>`;
    }).join("");
    const more = d.entries.length > 3
      ? `<div class="hmore">+${d.entries.length - 3} MORE HEISTER${d.entries.length - 3 === 1 ? "" : "S"}</div>`
      : "";
    return `<div class="hday"><div class="hdate">${fmtDate(d.day)}</div>${rows}${more}</div>`;
  }).join("");
}

// ---- refresh loop ---------------------------------------------------------------
async function refresh() {
  try {
    const r = await fetch("/api/leaderboard", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { days, today, allTime, recent, resetInSec } = await r.json();
    const todayEntries = (days || []).find((d) => d.day === today)?.entries || [];
    const prevDay = (days || []).find((d) => d.day !== today && d.entries?.length);
    renderToday(todayEntries, prevDay?.entries?.[0] || null);
    renderPodium(allTime);
    renderPulse(recent);
    renderHistory(days, today);
    if (resetInSec > 0) {
      resetAt = Date.now() + resetInSec * 1000;
      renderReset();
    }
    els.updated.textContent = "UPDATED " + new Date().toLocaleTimeString();
  } catch {
    els.updated.textContent = "RECONNECTING…";
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
