// All DOM rendering for Voice Heist. The game engine (game.js) owns state and
// calls into these helpers; this module never touches the Deepgram session.
//
// Display-only metadata (icons/titles/tone for the heist cards + briefs). The
// authoritative game data lives in the Python brain.
// Ordered easiest -> hardest to match the brain's difficulty ladder (LEVEL_ORDER).
const LEVEL_META = [
  {
    id: "order",
    level: 0,
    icon: "\u{1F355}", // pizza
    title: "The Order",
    gatekeeper: "Drew at Tony's Pizza",
    goal: "Get the pizza for free",
    tone: "Goofy",
  },
  {
    id: "refund",
    level: 1,
    icon: "\u{1F4B8}", // money with wings
    title: "The Refund",
    gatekeeper: "Priya at StreamFlix",
    goal: "Get the refund approved",
    tone: "Absurd",
  },
  {
    id: "receptionist",
    level: 2,
    icon: "\u{260E}\u{FE0F}", // phone
    title: "The Receptionist",
    gatekeeper: "Renee at Globex",
    goal: "Reach a human",
    tone: "Kafkaesque",
  },
  {
    id: "list",
    level: 3,
    icon: "\u{1F6AA}", // door
    title: "The List",
    gatekeeper: "Bruce, the Bouncer",
    goal: "Get into the club",
    tone: "Deadpan",
  },
];

const $ = (id) => document.getElementById(id);

// Lucide-style inline icons (stroke uses currentColor so they match button text).
const ICON_MIC =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';
const ICON_MIC_OFF =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true"><line x1="2" y1="2" x2="22" y2="22"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><path d="M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-1"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';

const els = {
  app: $("app"),
  status: $("status"),
  turnPill: $("turnPill"),
  scoreHud: $("scoreHud"),
  scoreHudValue: $("scoreHudValue"),
  scoreHudPop: $("scoreHudPop"),
  agentName: $("agentName"),
  connChip: $("connChip"),
  connText: $("connText"),
  newPlayerBtn: $("newPlayerBtn"),
  signinBtn: $("signinBtn"),
  playerBadge: $("playerBadge"),
  briefTitle: $("briefTitle"),
  briefBody: $("briefBody"),
  briefGoals: $("briefGoals"),
  cueToast: $("cueToast"),
  cueText: $("cueText"),
  hintPop: $("hintPop"),
  hintText: $("hintText"),
  transcript: $("transcript"),
  heistGrid: $("heistGrid"),
  lobbyHint: $("lobbyHint"),
  connectBtn: $("connectBtn"),
  muteBtn: $("muteBtn"),
  muteIc: $("muteIc"),
  lobbyBtn: $("lobbyBtn"),
  finishBtn: $("finishBtn"),
  overlay: $("resultOverlay"),
  resultBadge: $("resultBadge"),
  resultTitle: $("resultTitle"),
  resultScore: $("resultScore"),
  resultBonus: $("resultBonus"),
  resultRank: $("resultRank"),
  resultPath: $("resultPath"),
  resultReason: $("resultReason"),
  resultHint: $("resultHint"),
  resultWho: $("resultWho"),
  resultContinue: $("resultContinue"),
  resultNext: $("resultNext"),
  resultRetry: $("resultRetry"),
  streakChip: $("streakChip"),
  sweepMeter: $("sweepMeter"),
  dayOverlay: $("dayOverlay"),
  dayTitle: $("dayTitle"),
  dayScore: $("dayScore"),
  dayCracked: $("dayCracked"),
  dayRank: $("dayRank"),
  dayRival: $("dayRival"),
  dayBest: $("dayBest"),
  dayStreak: $("dayStreak"),
  dayComeback: $("dayComeback"),
  dayClaimNudge: $("dayClaimNudge"),
  dayShareBtn: $("dayShareBtn"),
  dayRetry: $("dayRetry"),
  dayContinue: $("dayContinue"),
  claimForm: $("claimForm"),
  claimHandle: $("claimHandle"),
  claimEmail: $("claimEmail"),
  claimError: $("claimError"),
  todaysBest: $("todaysBest"),
  boardRail: $("boardRail"),
  boardRailList: $("boardRailList"),
  railReset: $("railReset"),
  heroPulse: $("heroPulse"),
  resultRival: $("resultRival"),
  shareBtn: $("shareBtn"),
  orb: $("orb"),
  fxCanvas: $("fxCanvas"),
  scoreCue: $("scoreCue"),
  howtoBtn: $("howtoBtn"),
  howtoOverlay: $("howtoOverlay"),
  howtoClose: $("howtoClose"),
  howtoGo: $("howtoGo"),
  loginOverlay: $("loginOverlay"),
  authClose: $("authClose"),
};

let connected = false;

// ---- phase + connection ---------------------------------------------------
export function setPhase(phase) {
  els.app.dataset.phase = phase; // "lobby" | "call"
}

export function setConnected(isConnected) {
  connected = isConnected;
  els.app.dataset.connected = String(isConnected);
  setConnState(isConnected ? "listening" : "off");
  applyHeistCards();
  updateNewPlayerBtn();
}

// "Start over" only earns topbar space once there's something to start over
// FROM — a live session, banked points, or a boarded identity. A first-time
// visitor seeing it just reads noise (and "Offline" reads like an outage).
let _bankedTotal = 0;
let _onBoard = false;
function updateNewPlayerBtn() {
  if (!els.newPlayerBtn) return;
  els.newPlayerBtn.hidden = !(connected || _bankedTotal > 0 || _onBoard);
}

export function setConnState(state) {
  // state: "off" | "connecting" | "listening" | "thinking" | "speaking"
  // The chip is the turn-taking legend: it must say WHOSE turn it is (the old
  // "Live" for both directions was unreadable from booth distance), and
  // "thinking" dresses the reply latency so silence never reads as broken.
  const first = (els.agentName.textContent || "").split(/[,\s]/)[0] || "Agent";
  const label = {
    off: "Offline",
    connecting: "Connecting\u2026",
    listening: "Your turn",
    thinking: "Hmm\u2026",
    speaking: `${first} speaking`,
  }[state] || "Offline";
  els.connChip.dataset.state = state;
  els.connChip.hidden = state === "off"; // in the lobby the chip is just noise
  els.connText.textContent = label;
  // Drives the "LIVE ON DEEPGRAM VOICE AGENT" caption under the orb \u2014 the brand
  // gets named at the exact moment the voice is performing.
  els.app.dataset.speaking = String(state === "speaking");
}

// ---- status / agent -------------------------------------------------------
// `sticky` pins an error explanation for a few seconds so background chatter
// (e.g. the brain-WS "Reconnecting…" loop) can't clobber it; `force` is for
// user-initiated actions, which always deserve fresh feedback.
let _statusStickyUntil = 0;
export function setStatus(text, { sticky = false, force = false } = {}) {
  const now = Date.now();
  if (sticky) _statusStickyUntil = now + 8000;
  else if (force) _statusStickyUntil = 0;
  else if (now < _statusStickyUntil) return;
  els.status.textContent = text;
}

export function setAgentName(name) {
  els.agentName.textContent = name;
}

export function setLobbyHint(text) {
  els.lobbyHint.textContent = text;
}

export function setTurn(current, max) {
  const used = Math.max(0, Math.min(current, max));
  const remaining = max - used;
  let dots = "";
  for (let i = 0; i < max; i++) dots += i < used ? "\u25CF" : "\u25CB";
  // Turns ARE the tension mechanic (there's no timer) \u2014 style them like one:
  // the label escalates on the final turn and the pill pops when a turn burns.
  const label = remaining === 1 ? "Last turn!" : `Turn ${used} of ${max}`;
  els.turnPill.innerHTML = `<span class="turn-dots">${dots}</span><span>${label}</span>`;
  els.turnPill.dataset.remaining = String(remaining);
  els.turnPill.classList.remove("hidden");
  if (used > 0) {
    els.turnPill.classList.remove("tick");
    void els.turnPill.offsetWidth; // restart the pop each time a turn is spent
    els.turnPill.classList.add("tick");
  }
}

export function hideTurn() {
  els.turnPill.classList.add("hidden");
}

// ---- score HUD ------------------------------------------------------------
// Persistent arcade score in the top bar — the player's running total, shown on
// every screen. A "+N" pops on the bar each time they earn points in a heist.
let _scorePopTimer = null;
export function setTotalScore(total, delta = 0, label = "") {
  els.scoreHudValue.textContent = Number(total).toLocaleString();
  // At zero the hud is an illegible glyph promising nothing — earn the pixels.
  if (els.scoreHud) els.scoreHud.hidden = !(Number(total) > 0);
  _bankedTotal = Number(total) || 0;
  updateNewPlayerBtn();
  if (delta > 0) {
    els.scoreHudPop.textContent = `+${delta}`;
    els.scoreHudPop.dataset.tier = label || "weak";
    void els.scoreHudPop.offsetWidth; // restart the pop animation
    els.scoreHudPop.classList.add("show");
    clearTimeout(_scorePopTimer);
    _scorePopTimer = setTimeout(() => els.scoreHudPop.classList.remove("show"), 1100);
  }
  // Hitting the 500 "almost correct" tier earns a big arcade cue.
  if (label === "warm" && delta > 0) showScoreCue("ALMOST!");
}

// ---- day streak chip (topbar) ----------------------------------------------
// Consecutive event days with a play — registered players only (anonymous pids
// churn daily). A 1-day "streak" is noise, so the flame only lights at 2+.
export function setStreak(n) {
  if (!els.streakChip) return;
  const days = Number(n) || 0;
  els.streakChip.textContent = days >= 2 ? `\u{1F525} ${days}-day streak` : "";
  els.streakChip.hidden = days < 2;
}

// ---- sweep meter (lobby session goal) ---------------------------------------
// "x/4 cracked today" — the visible arc toward the clean-sweep bonus. Hidden on
// single-heist event days (no sweep to chase).
export function setSweepMeter(cracked, total) {
  if (!els.sweepMeter) return;
  if (!total || total < 2) {
    els.sweepMeter.hidden = true;
    return;
  }
  const swept = cracked >= total;
  els.sweepMeter.textContent = swept
    ? "\u{1F3C6} CLEAN SWEEP — every heist cracked today"
    : `${cracked}/${total} cracked today` +
      (cracked === total - 1 ? " — one more for the +1,000 sweep bonus!" : "");
  els.sweepMeter.dataset.swept = String(swept);
  els.sweepMeter.hidden = false;
}

// Big transient cue ("ALMOST!") flashed center-screen when a tier is reached.
let _scoreCueTimer = null;
export function showScoreCue(text) {
  if (!els.scoreCue) return;
  els.scoreCue.textContent = text;
  void els.scoreCue.offsetWidth; // restart the animation each time
  els.scoreCue.classList.add("show");
  clearTimeout(_scoreCueTimer);
  _scoreCueTimer = setTimeout(() => els.scoreCue.classList.remove("show"), 1200);
}

// ---- heist cards (the lobby) ----------------------------------------------
// statusMap: { [levelId]: "open" | "win" | "lose" | "retry" | "unavailable" }
// "retry" = busted today, but the player's earned second chance can re-open it.
const CHIP_LABEL = {
  open: "Play",
  win: "Cracked",
  lose: "Busted",
  retry: "↻ Retry",
  unavailable: "Unavailable",
};
let heistStatus = {};

export function renderHeists(statusMap = {}) {
  els.heistGrid.innerHTML = "";
  for (const meta of LEVEL_META) {
    // A heist disabled in the admin portal is hidden from the lobby entirely.
    if (statusMap[meta.id] === "unavailable") continue;
    const card = document.createElement("button");
    card.className = "heist-card";
    card.dataset.level = meta.id;
    card.type = "button";
    card.innerHTML = `
      <span class="heist-icon">${meta.icon}</span>
      <span class="heist-info">
        <span class="heist-title"><span class="heist-level">LVL ${meta.level}</span>${meta.title}<span class="heist-tone">${meta.tone}</span></span>
        <span class="heist-gk">${meta.gatekeeper}</span>
        <span class="heist-goal">${meta.goal}</span>
        <span class="heist-locked"></span>
      </span>
      <span class="heist-status"></span>`;
    els.heistGrid.appendChild(card);
  }
  setHeistStatus(statusMap);
}

export function setHeistStatus(statusMap = {}) {
  heistStatus = statusMap;
  applyHeistCards();
}

function applyHeistCards() {
  for (const card of els.heistGrid.children) {
    const status = heistStatus[card.dataset.level] || "open";
    card.dataset.status = status;
    // First-timers need a "start here": the unplayed warm-up level gets a
    // pulsing badge so the easiest heist — the one built to be won — draws the
    // first tap instead of looking identical to Level 3.
    const starter = card.dataset.level === "order" && status === "open";
    card.classList.toggle("starter", starter);
    card.querySelector(".heist-status").textContent = starter
      ? "▶ Start here"
      : CHIP_LABEL[status] || "Play";
    // A win/lose status means the player already completed this heist today, so
    // it's locked until tomorrow (one play per mode per day). Mark it visibly —
    // a touch kiosk has no hover tooltips, so the caption must be on-screen.
    // "retry" is the exception: busted, but an earned second chance re-opens it.
    const played = status === "win" || status === "lose";
    card.classList.toggle("played", played);
    card.classList.toggle("retry", status === "retry");
    const lock = card.querySelector(".heist-locked");
    if (lock) {
      lock.textContent = played ? "Played today · resets tomorrow"
        : status === "retry" ? "Second chance unlocked — one retry today" : "";
    }
    // Only an open (or retry-eligible) heist on a live session is playable.
    card.disabled = !connected || (status !== "open" && status !== "retry");
  }
}

export function onHeist(fn) {
  els.heistGrid.addEventListener("click", (e) => {
    const card = e.target.closest(".heist-card");
    if (card && !card.disabled) fn(card.dataset.level);
  });
}

// ---- high-scores board (rail column + lobby taunt line) ---------------------
// The rail is the lobby's third column, two acts: the ALL-TIME podium (the top
// three single-day totals ever — legends, with medals) and TODAY'S RACE (the
// live daily board, plain numbers, own row highlighted or pinned). The full
// day-by-day history lives at /leaderboard. The chip above the heist cards
// names today's score to beat at the moment of choosing what to play.
// `codename` is passed only for players actually ON the board.
let _days = [];
let _today = null;
let _allTime = [];
let _ownCodename = null;
let _boardLoaded = false;
let _recent = []; // today's latest cracks — the board's pulse line
let _resetAt = 0; // wall-clock ms when the daily board resets

// Rank movement since the player's LAST VISIT (own-device game: the same
// browser comes back). The baseline is frozen at first render this session;
// every render persists the current ranks for the next visit.
const _RANKS_KEY = "vh_ranks";
let _rankBaseline = null;

function _initRankBaseline() {
  if (_rankBaseline !== null) return;
  try {
    const s = JSON.parse(localStorage.getItem(_RANKS_KEY) || "null");
    _rankBaseline = s && s.day === _today ? s : { day: _today, ranks: {} };
  } catch {
    _rankBaseline = { day: _today, ranks: {} };
  }
}

function _snapshotRanks() {
  const ranks = {};
  for (const e of todayEntries()) ranks[e.codename] = e.rank;
  try {
    localStorage.setItem(_RANKS_KEY, JSON.stringify({ day: _today, ranks }));
  } catch {
    /* storage unavailable — arrows just won't persist */
  }
}

export function setBoard(days = [], today = null, allTime = [], codename = null,
                         recent = [], resetInSec = 0) {
  _days = days;
  _today = today;
  _allTime = allTime;
  _ownCodename = codename;
  _recent = recent || [];
  if (resetInSec > 0) _resetAt = Date.now() + resetInSec * 1000;
  _boardLoaded = true;
  _initRankBaseline();
  renderTodaysBest();
  renderBoardRail();
  _snapshotRanks();
  renderReset();
  // Social proof beside the CTA: a competition with people in it beats a rulebook.
  if (els.heroPulse) {
    const n = todayEntries().length;
    els.heroPulse.textContent =
      n > 0 ? `${n} heister${n === 1 ? "" : "s"} on the board today — room at the top.` : "";
    els.heroPulse.hidden = n === 0;
  }
}

// The fetch failed: swap the "Checking the board…" placeholders for the plain
// empty state (never overwrite a board that already rendered real data).
export function resolveBoardPlaceholder() {
  if (!_boardLoaded) setBoard([], null, [], null);
}

function shiftDay(day, delta) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

function fmtShortDate(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: "short", day: "numeric", timeZone: "UTC",
  });
}

function todayEntries() {
  return _days.find((d) => d.day === _today)?.entries || [];
}

// The most recent earlier day's champion — the taunt when today is empty.
function prevChampion() {
  const prev = _days.find((d) => d.day !== _today && d.entries?.length);
  if (!prev) return null;
  const isYesterday = !!_today && shiftDay(_today, -1) === prev.day;
  return { ...prev.entries[0], isYesterday };
}

function renderTodaysBest() {
  if (!els.todaysBest) return;
  const cur = todayEntries();
  const top = cur[0];
  const prev = prevChampion();
  // Me-centric once the player is on the board: their rank and the one gap
  // that matters (the player right above) beat any leader taunt.
  const ownIdx = _ownCodename ? cur.findIndex((e) => e.codename === _ownCodename) : -1;
  const own = ownIdx >= 0 ? cur[ownIdx] : null;
  // Don't taunt the leader with their own score — flip to a defend framing.
  const isOwn = top && _ownCodename && top.codename === _ownCodename;
  els.todaysBest.innerHTML = own && !isOwn
    ? `You're <strong>#${own.rank}</strong> today · ` +
      `<strong>${Number(cur[ownIdx - 1].score - own.score).toLocaleString()}</strong> behind ` +
      `<strong>${escapeText(cur[ownIdx - 1].codename)}</strong> — one heist could pass them.`
    : top
      ? `Today's best: <strong>${escapeText(top.codename)}</strong> · ` +
        `${escapeText(initials(top.codename))} scored <strong>${Number(top.score).toLocaleString()}</strong> — ` +
        `${isOwn ? "that's you. Defend the top spot." : "think you can beat it?"}`
      : prev
        ? `No scores yet today — ${prev.isYesterday ? "yesterday's champion" : "the reigning champion"} ` +
          `<strong>${escapeText(prev.codename)}</strong> set the bar at ` +
          `<strong>${Number(prev.score).toLocaleString()}</strong>.`
        : `No scores on the board yet today — set the bar.`;
  els.todaysBest.hidden = false;
}

// ---- board flair: badges, rank movement, reset countdown --------------------
// Earned badges next to codenames — every icon on the board advertises the
// mechanic that earns it.
function badgeHtml(list) {
  if (!list || !list.length) return "";
  return list.map((b) => {
    if (b.startsWith("streak:")) {
      const n = b.slice(7);
      return `<span class="bd-badge" title="${n}-day streak">\u{1F525}${n}</span>`;
    }
    if (b === "sweep") return '<span class="bd-badge" title="Clean sweep — cracked every heist">\u{1F3C6}</span>';
    if (b === "fast") return '<span class="bd-badge" title="Fastest crack of the day">⚡</span>';
    return "";
  }).join("");
}

// ▲2 / ▼1 since the player's last visit (baseline frozen at first render).
function deltaHtml(codename, rank) {
  if (!_rankBaseline || _rankBaseline.day !== _today) return "";
  const prev = _rankBaseline.ranks[codename];
  if (!prev || prev === rank) return "";
  return prev > rank
    ? `<span class="bd-delta up" title="Up ${prev - rank} since your last visit">▲${prev - rank}</span>`
    : `<span class="bd-delta down" title="Down ${rank - prev} since your last visit">▼${rank - prev}</span>`;
}

// "resets in 3h 12m" — the daily board is ephemeral; say so, with a clock.
export function renderReset() {
  if (!els.railReset) return;
  if (!_resetAt) {
    els.railReset.hidden = true;
    return;
  }
  const ms = Math.max(0, _resetAt - Date.now());
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  els.railReset.textContent =
    ms <= 60000 ? "resets any moment" : h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
  els.railReset.hidden = false;
}
setInterval(renderReset, 30_000);

// Medal treatment for the all-time podium; today's race uses plain numbers so
// the two boards read as different competitions at a glance.
const RANK_BADGE = { 1: "\u{1F451}", 2: "\u{1F948}", 3: "\u{1F949}" }; // 👑 🥈 🥉
const RANK_CLASS = { 1: " gold", 2: " silver", 3: " bronze" };

function boardRow(e, mine, extraClass = "", medals = true) {
  const cls = medals ? RANK_CLASS[e.rank] || "" : "";
  const badge = medals ? RANK_BADGE[e.rank] || e.rank : e.rank;
  const sub = e.day ? `<span class="bd-sub">${fmtShortDate(e.day)}</span>` : "";
  return `<div class="bd-row${cls}${mine ? " mine" : ""}${extraClass}">
    <span class="bd-rank">${badge}</span>
    <span class="bd-name">${escapeText(e.codename)}${mine ? " · you" : ""}${sub}</span>
    <span class="bd-score">${Number(e.score).toLocaleString()}</span>
  </div>`;
}

function railSection(title, rows, isCurrent) {
  return `<section class="rail-week${isCurrent ? " current" : ""}">
    <div class="rail-week-head">${title}</div>${rows}</section>`;
}

// Two-letter medallion initials from a codename ("Neon Sparrow 28" → "NS").
function initials(codename) {
  return codename.split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();
}

// Classic podium silhouette: silver left, gold center (elevated), bronze right.
const POD_ORDER = [2, 1, 3];
const POD_CLASS = { 1: "first", 2: "second", 3: "third" };

function podiumStep(e) {
  // An unclaimed step is an invitation, not an absence.
  if (!e) {
    return `<div class="pod-step ghost">
      <div class="pod-medal">?</div>
      <div class="pod-name">unclaimed</div>
      <div class="pod-score">&mdash;</div>
      <div class="pod-date">&nbsp;</div>
      <div class="pod-block"></div>
    </div>`;
  }
  const mine = _ownCodename && e.codename === _ownCodename;
  return `<div class="pod-step ${POD_CLASS[e.rank] || ""}${mine ? " mine" : ""}">
    ${e.rank === 1 ? '<div class="pod-crown">\u{1F451}</div>' : ""}
    <div class="pod-medal">${initials(e.codename)}</div>
    <div class="pod-name">${escapeText(e.codename)}</div>
    <div class="pod-score">${Number(e.score).toLocaleString()}</div>
    <div class="pod-date">${e.day ? fmtShortDate(e.day) : "&nbsp;"}</div>
    <div class="pod-block">${e.rank}</div>
  </div>`;
}

function renderBoardRail() {
  if (!els.boardRailList) return;
  // Act one: the pantheon as a real podium — a visual object, not three rows.
  const byRank = {};
  for (const e of _allTime) byRank[e.rank] = e;
  const podium = `<div class="podium">${POD_ORDER.map((r) => podiumStep(byRank[r])).join("")}</div>`;
  const podiumSection = railSection("All-time best", podium, true);
  // Act two: today's race — rows with score bars, so standings read as a race.
  // Top FIVE, not three: ranks 4-5 are the rungs a new player can actually
  // reach today, and visible reachable rungs are what make a board motivating.
  // A player ranked 6th+ gets a me-centric cut instead: the podium trio, a
  // divider, then their NEIGHBORHOOD (row above, them, row below) with the gap
  // to pass — the only fight that matters is the one rung up.
  const cur = todayEntries();
  const top = cur[0]?.score || 1;
  const ownIdx = _ownCodename ? cur.findIndex((e) => e.codename === _ownCodename) : -1;
  const raceRow = (e) => {
    const mine = _ownCodename && e.codename === _ownCodename;
    const pct = Math.max(6, Math.round((e.score / top) * 100));
    const above = cur[e.rank - 2]; // entries are rank-ordered; rank is 1-based
    const gap = mine && above
      ? `<span class="bd-gap">▲ ${Number(above.score - e.score).toLocaleString()} to pass</span>`
      : "";
    return `<div class="bd-row race-row${mine ? " mine" : ""}">
      <span class="bd-rank">${e.rank}</span>
      <span class="bd-name">${escapeText(e.codename)}${badgeHtml(e.badges)}${mine ? " · you" : ""}${deltaHtml(e.codename, e.rank)}</span>
      <span class="bd-score">${Number(e.score).toLocaleString()}</span>
      <span class="race-bar"><i style="width:${pct}%"></i></span>
      ${gap}
    </div>`;
  };
  let rows;
  if (ownIdx >= 5) {
    const hood = [cur[ownIdx - 1], cur[ownIdx], cur[ownIdx + 1]].filter(Boolean);
    rows = cur.slice(0, 3).map(raceRow).join("") +
      '<div class="bd-divider" aria-hidden="true">· · ·</div>' +
      hood.map(raceRow).join("");
  } else {
    rows = cur.slice(0, 5).map(raceRow).join("");
  }
  if (!rows) {
    rows = '<div class="bd-row bd-hint">No scores yet today — one heist puts you on top.</div>';
  }
  // The lobby polls the board, so the race really is live — say so.
  const todaySection = railSection(
    'Today\'s race <span class="rail-live" aria-hidden="true">● live</span>', rows, false);
  // The player's own stake, anchored to the panel's bottom edge.
  const foot = `<div class="rail-foot">${
    ownIdx >= 0
      ? "That's you up there — the board resets daily, defend it."
      : _ownCodename
        ? "No boarded score yet today — crack a heist."
        : "Your name goes here — play & win your place."
  }</div>`;
  // The pulse line: other humans are cracking heists right now.
  const ticker = _recent.length
    ? '<div class="rail-ticker" id="railTicker" aria-live="off"></div>'
    : "";
  els.boardRailList.innerHTML = podiumSection + todaySection + ticker + foot;
  startTicker();
}

// Rotate through today's latest cracks — proof the race is live even when
// every other player is on a different continent.
let _tickerTimer = null;
let _tickerIdx = 0;

function tickerText(item) {
  const ago = item.agoMin == null ? ""
    : item.agoMin < 1 ? " · just now"
      : item.agoMin < 60 ? ` · ${item.agoMin}m ago`
        : ` · ${Math.floor(item.agoMin / 60)}h ago`;
  return `${item.codename} cracked ${item.title} +${Number(item.score).toLocaleString()}${ago}`;
}

function startTicker() {
  clearInterval(_tickerTimer);
  const el = document.getElementById("railTicker");
  if (!el || !_recent.length) return;
  const reduced =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  _tickerIdx = 0;
  const show = () => {
    el.textContent = tickerText(_recent[_tickerIdx % _recent.length]);
    el.classList.remove("tick");
    void el.offsetWidth; // restart the fade-in each rotation
    el.classList.add("tick");
    _tickerIdx += 1;
  };
  show();
  if (!reduced && _recent.length > 1) _tickerTimer = setInterval(show, 5000);
}

function escapeText(s) {
  const div = document.createElement("div");
  div.textContent = String(s ?? "");
  return div.innerHTML;
}

// ---- in-call brief --------------------------------------------------------
export function renderLevelBrief(level) {
  els.briefTitle.textContent = level.title;
  els.briefBody.textContent = level.ruleHint;
  els.briefGoals.innerHTML = "";
  const li = document.createElement("li");
  li.textContent = `Goal: ${level.goal}`;
  els.briefGoals.appendChild(li);
}

// ---- cue toast ------------------------------------------------------------
// A themed quote that pops up when a heist starts, nudging the player toward
// the winning approach without spelling it out. Auto-dismisses; tap to close.
let _cueTimer = null;
export function showCue(quote) {
  if (!els.cueToast || !quote) return;
  clearTimeout(_cueTimer);
  els.cueText.textContent = quote;
  els.cueToast.hidden = false;
  // Force reflow so the entrance transition runs each time.
  void els.cueToast.offsetWidth;
  els.cueToast.classList.add("show");
  _cueTimer = setTimeout(hideCue, 6000);
}

export function hideCue() {
  if (!els.cueToast) return;
  clearTimeout(_cueTimer);
  els.cueToast.classList.remove("show");
  // Wait out the fade before hiding from the layout/AT.
  _cueTimer = setTimeout(() => { els.cueToast.hidden = true; }, 400);
}

// ---- coaching hint pop (shown after an off-track turn) --------------------
let _hintTimer = null;
export function showHint(text) {
  if (!els.hintPop || !text) return;
  clearTimeout(_hintTimer);
  els.hintText.textContent = text;
  els.hintPop.hidden = false;
  void els.hintPop.offsetWidth; // restart the pop-in each time
  els.hintPop.classList.add("show");
  _hintTimer = setTimeout(hideHint, 5500);
}

export function hideHint() {
  if (!els.hintPop) return;
  clearTimeout(_hintTimer);
  els.hintPop.classList.remove("show");
  _hintTimer = setTimeout(() => { els.hintPop.hidden = true; }, 320);
}

// ---- transcript -----------------------------------------------------------
export function clearTranscript() {
  els.transcript.innerHTML = "";
}

export function addTranscript(role, content) {
  if (!content) return;
  const row = document.createElement("div");
  row.className = `turn turn-${role === "user" ? "user" : "agent"}`;
  const who = document.createElement("span");
  who.className = "turn-who";
  who.textContent = role === "user" ? "You" : els.agentName.textContent;
  const text = document.createElement("span");
  text.className = "turn-text";
  text.textContent = content;
  row.append(who, text);
  els.transcript.appendChild(row);
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

export function addSystemNote(text) {
  const row = document.createElement("div");
  row.className = "turn turn-system";
  row.textContent = text;
  els.transcript.appendChild(row);
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

// ---- controls -------------------------------------------------------------
const labelOf = (btn) => btn.querySelector(".btn-label");

export function setControls({ connect, mute, lobby, muted, finish }) {
  if (connect) {
    labelOf(els.connectBtn).textContent = connect.label;
    els.connectBtn.disabled = !!connect.disabled;
  }
  if (mute !== undefined) els.muteBtn.disabled = !mute;
  if (lobby !== undefined) els.lobbyBtn.disabled = !lobby;
  if (finish !== undefined) els.finishBtn.disabled = !finish;
  if (muted !== undefined) {
    labelOf(els.muteBtn).textContent = muted ? "Unmute mic" : "Mute mic";
    els.muteIc.innerHTML = muted ? ICON_MIC_OFF : ICON_MIC;
  }
}

export function onConnect(fn) {
  els.connectBtn.addEventListener("click", fn);
}
export function onMute(fn) {
  els.muteBtn.addEventListener("click", fn);
}
export function onLobby(fn) {
  els.lobbyBtn.addEventListener("click", fn);
}
export function onFinish(fn) {
  els.finishBtn.addEventListener("click", fn);
}
export function onNewPlayer(fn) {
  if (els.newPlayerBtn) els.newPlayerBtn.addEventListener("click", fn);
}
export function onSignIn(fn) {
  if (els.signinBtn) els.signinBtn.addEventListener("click", fn);
}

// Topbar leaderboard identity: anonymous sessions get the "Sign in" button;
// players on the board see their codename badge instead.
export function setPlayerBadge(player) {
  if (!els.playerBadge || !els.signinBtn) return;
  const onBoard = player?.tier && !["anon", "test"].includes(player.tier);
  if (onBoard) {
    els.playerBadge.textContent = `★ ${player.codename || player.handle || "On the board"}`;
    els.playerBadge.hidden = false;
    els.signinBtn.hidden = true;
  } else {
    els.playerBadge.hidden = true;
    els.signinBtn.hidden = !player; // only offer sign-in once a session exists
  }
  _onBoard = !!onBoard;
  updateNewPlayerBtn();
}

// ---- how-to-play modal ----------------------------------------------------
export function initHowTo() {
  const open = () => {
    els.howtoOverlay.classList.remove("hidden");
    if (els.howtoGo) els.howtoGo.focus();
  };
  const close = () => {
    els.howtoOverlay.classList.add("hidden");
    if (els.howtoBtn) els.howtoBtn.focus();
  };
  if (els.howtoBtn) els.howtoBtn.addEventListener("click", open);
  if (els.howtoClose) els.howtoClose.addEventListener("click", close);
  if (els.howtoGo) {
    els.howtoGo.addEventListener("click", () => {
      close();
      // "Let's go" means GO: the reader just absorbed the rules — peak
      // motivation. Connect them instead of dropping them back at the lobby.
      if (!connected && els.connectBtn && !els.connectBtn.disabled) els.connectBtn.click();
    });
  }
  // Click the dimmed backdrop (outside the card) to dismiss.
  if (els.howtoOverlay) {
    els.howtoOverlay.addEventListener("click", (e) => {
      if (e.target === els.howtoOverlay) close();
    });
  }
  // Esc closes whichever overlay is up (sign-in close goes through its own
  // button so auth.js can resolve its promise).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (els.howtoOverlay && !els.howtoOverlay.classList.contains("hidden")) close();
    else if (els.loginOverlay && !els.loginOverlay.classList.contains("hidden") && els.authClose) {
      els.authClose.click();
    }
  });
  // Tap the quote cue to dismiss it early.
  if (els.cueToast) els.cueToast.addEventListener("click", hideCue);
}

// ---- result overlay -------------------------------------------------------
// Count a number up to `target` for an arcade score-tally feel.
let _countRaf = null;
function countUp(el, target) {
  cancelAnimationFrame(_countRaf);
  const dur = 800;
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = `${Math.round(target * eased)} pts`;
    if (t < 1) _countRaf = requestAnimationFrame(step);
    else el.textContent = `${target} pts`;
  }
  _countRaf = requestAnimationFrame(step);
}

// One-shot confetti burst in brand colors on the FX canvas (win celebration).
let _fxRaf = null;
function burstConfetti() {
  const cv = els.fxCanvas;
  if (!cv) return;
  const ctx = cv.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = window.innerWidth * dpr;
  cv.height = window.innerHeight * dpr;
  const W = cv.width;
  const H = cv.height;
  const colors = ["#13ef93", "#ee028c", "#14a9fb", "#ffd45e", "#a1f9d4"];
  const parts = Array.from({ length: 150 }, () => ({
    x: W / 2,
    y: H * 0.42,
    vx: (Math.random() - 0.5) * 22 * dpr,
    vy: (Math.random() * -14 - 6) * dpr,
    g: 0.42 * dpr,
    size: (4 + Math.random() * 5) * dpr,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.4,
    color: colors[(Math.random() * colors.length) | 0],
    life: 1,
  }));
  cancelAnimationFrame(_fxRaf);
  let frames = 0;
  function tick() {
    frames += 1;
    ctx.clearRect(0, 0, W, H);
    let alive = false;
    for (const p of parts) {
      p.vy += p.g;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      p.life -= 0.012;
      if (p.life > 0 && p.y < H + 40) {
        alive = true;
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }
    }
    if (alive && frames < 240) _fxRaf = requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, W, H);
  }
  tick();
}

let _dismissResult = null; // set while a result overlay is open; lets voice ("go back") dismiss it
let _claimSubmit = null; // set while an anonymous player can claim their score
let _claimBusy = false; // in-flight guard: double-taps must not race duplicate claims
let _shareText = ""; // prefilled share copy for the current result card

// Wire a share button once. navigator.share on devices that have it (mobile);
// otherwise copy the text + link and say so on the button. The idle label is
// captured once at wiring time — capturing per-click permanently sticks the
// button on "Copied!" after a double-click. Both the result card and the
// day-summary card share the same _shareText slot (only one card is up at once).
function wireShare(btn) {
  if (!btn) return;
  const idleLabel = btn.textContent;
  let restoreTimer = 0;
  btn.addEventListener("click", async () => {
    if (!_shareText) return;
    const url = location.origin;
    if (navigator.share) {
      navigator.share({ title: "Voice Heist", text: _shareText, url }).catch(() => {
        /* user closed the share sheet — nothing to do */
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(`${_shareText} ${url}`);
      clearTimeout(restoreTimer);
      btn.textContent = "Copied!";
      restoreTimer = setTimeout(() => {
        btn.textContent = idleLabel;
      }, 1600);
    } catch {
      /* clipboard unavailable — leave the button as-is */
    }
  });
}
wireShare(els.shareBtn);
wireShare(els.dayShareBtn);

// The codename line links straight to the public board (codename is escaped).
function whoWithBoardLink(prefix) {
  return `${escapeText(prefix)} · <a href="/leaderboard" target="_blank" rel="noopener">see the leaderboard</a>`;
}

// Wire the claim form once; the active handler is swapped per result card.
if (els.claimForm) {
  els.claimForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!_claimSubmit || _claimBusy) return;
    _claimBusy = true;
    const btn = els.claimForm.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      await _claimSubmit();
    } finally {
      _claimBusy = false;
      if (btn) btn.disabled = false;
    }
  });
}

export function showResult({
  outcome, title, path, reason, hint, score, codename,
  rank, newHigh, onBoard, canClaim, rival, nextOpenId, onClaim,
  base, turnBonus, turnsLeft, streakBonus, streak, sweep, sweepBonus,
  retrySpent, retryOffer,
}) {
  els.resultBadge.textContent = sweep ? "★ CLEAN SWEEP ★"
    : outcome === "win" ? "HEIST CRACKED" : "BUSTED";
  els.resultBadge.className = `result-badge ${outcome === "win" ? "badge-win" : "badge-lose"}`;
  els.overlay.dataset.outcome = outcome; // drives the bust flash / win styling
  els.resultTitle.textContent = title;
  const hasScore = score || score === 0;
  els.resultScore.hidden = !hasScore;
  if (hasScore) countUp(els.resultScore, score);
  // Itemize how the total was built — the count-up above is the all-in number.
  if (els.resultBonus) {
    const parts = [];
    if (turnBonus > 0) {
      parts.push(`+${Number(turnBonus).toLocaleString()} turn bonus ` +
        `(${turnsLeft} turn${turnsLeft === 1 ? "" : "s"} to spare)`);
    }
    if (streakBonus > 0) {
      parts.push(`+${Number(streakBonus).toLocaleString()} streak bonus (\u{1F525} day ${streak})`);
    }
    if (sweep) parts.push(`+${Number(sweepBonus).toLocaleString()} clean sweep`);
    if (parts.length && base) parts.unshift(`${Number(base).toLocaleString()} win`);
    if (retrySpent) parts.push("Second chance spent — your first run's points stand.");
    els.resultBonus.textContent = parts.join(" · ");
    els.resultBonus.hidden = parts.length === 0;
  }
  // Competitive standing at the peak-attention moment: the rank today, the
  // arcade NEW HIGH SCORE hit, or (for anonymous players) the rank this score
  // WOULD hold — the setup for the claim form below.
  if (els.resultRank) {
    let rankText = "";
    if (newHigh) rankText = "★ NEW HIGH SCORE — #1 today ★";
    else if (rank && onBoard) rankText = `#${rank} on today's board`;
    else if (rank && canClaim) rankText = `That score would be #${rank} today — save it below`;
    els.resultRank.textContent = rankText;
    els.resultRank.hidden = !rankText;
    els.resultRank.classList.toggle("newhigh", !!newHigh);
  }
  // The one to chase: a rank is information, a rival is a reason to play the
  // next heist. Names the gap and what closing it is worth.
  if (els.resultRival) {
    let rivalText = "";
    if (rival && rank && rank > 1) {
      const next = nextOpenId ? LEVEL_META.find((m) => m.id === nextOpenId) : null;
      const chase = next ? ` — ${next.title} is worth up to 1,000` : "";
      rivalText = rival.gap > 0
        ? `${Number(rival.gap).toLocaleString()} behind ${rival.codename}${chase}`
        : `Tied with ${rival.codename}, who got there first${chase}`;
    }
    els.resultRival.textContent = rivalText;
    els.resultRival.hidden = !rivalText;
  }
  // Share is the web's spectator mode: the result travels to the next player.
  if (els.shareBtn) {
    const heist = String(title || "").replace(/:.*$/, "");
    _shareText = outcome === "win"
      ? `I just talked an AI into breaking its own rule — "${heist}" cracked for ${score} pts on Voice Heist. Think you can beat me?`
      : `An AI gatekeeper just busted me on Voice Heist (${score} pts). Think you can do better?`;
    els.shareBtn.hidden = false;
  }
  els.resultPath.textContent = path ? `Path unlocked: ${path}` : "";
  els.resultReason.textContent = reason || "";
  // On a bust, reveal the move they missed so they leave laughing and a little
  // wiser. The win screen hides it.
  if (els.resultHint) {
    els.resultHint.textContent = hint || "";
    els.resultHint.hidden = !hint;
  }
  // Players ON the board see their codename; anonymous players get the claim
  // form instead (their codename means nothing until the score is boarded).
  els.resultWho.innerHTML = onBoard && codename ? whoWithBoardLink(codename) : "";
  els.resultWho.hidden = !(onBoard && codename);
  if (els.claimForm) {
    const claimable = !!(canClaim && onClaim);
    els.claimForm.hidden = !claimable;
    els.claimError.textContent = "";
    _claimSubmit = claimable
      ? async () => {
          const handle = els.claimHandle.value.trim();
          const email = els.claimEmail.value.trim();
          if (!handle) {
            els.claimError.textContent = "Pick a handle first.";
            return;
          }
          els.claimError.textContent = "";
          const res = await onClaim(handle, email);
          if (res?.ok) {
            els.claimForm.hidden = true;
            els.claimHandle.value = "";
            els.claimEmail.value = "";
            els.resultWho.innerHTML = whoWithBoardLink(`You're on the board as ${res.codename}`);
            els.resultWho.hidden = false;
            if (els.resultRank && rank) {
              els.resultRank.textContent = rank === 1
                ? "★ NEW HIGH SCORE — #1 today ★"
                : `#${rank} on today's board`;
              els.resultRank.hidden = false;
              els.resultRank.classList.toggle("newhigh", rank === 1);
            }
          } else if (res?.status === 409) {
            // Already claimed (e.g. via the topbar sign-in) — not an error.
            els.claimForm.hidden = true;
            els.resultWho.innerHTML = whoWithBoardLink("You're already on the board");
            els.resultWho.hidden = false;
          } else if (res?.status === 429) {
            els.claimError.textContent = "Too many tries — wait a moment.";
          } else if (res?.status === 400) {
            els.claimError.textContent = "That email doesn't look right — fix it, or leave it blank.";
          } else {
            els.claimError.textContent = "Couldn't save it — try again.";
          }
        }
      : null;
  }
  // One-tap momentum: "Next: <heist>" jumps straight to the easiest open heist,
  // and an earned second chance gets its own Retry button. Either resolves the
  // overlay with {next}, which rides the result_ack to the brain (the single
  // authority on eligibility). With a Next button up, "Back to the Host"
  // demotes to a ghost so the card has one obvious primary action.
  const nextMeta = nextOpenId ? LEVEL_META.find((m) => m.id === nextOpenId) : null;
  if (els.resultNext) {
    els.resultNext.textContent = nextMeta ? `Next: ${nextMeta.title} ▶` : "";
    els.resultNext.hidden = !nextMeta;
  }
  if (els.resultRetry) {
    els.resultRetry.textContent = retryOffer ? `↻ Retry ${retryOffer.title}` : "";
    els.resultRetry.hidden = !retryOffer;
  }
  els.resultContinue.classList.toggle("dg-btn--primary", !nextMeta);
  els.resultContinue.classList.toggle("dg-btn--ghost", !!nextMeta);
  els.overlay.classList.remove("hidden");
  if (outcome === "win") {
    burstConfetti();
    // A NEW HIGH SCORE earns a second burst as the count-up lands; a CLEAN
    // SWEEP earns a staggered volley.
    if (newHigh) setTimeout(burstConfetti, 900);
    if (sweep) {
      setTimeout(burstConfetti, 500);
      setTimeout(burstConfetti, 1300);
    }
  }
  return new Promise((resolve) => {
    const finish = (value) => {
      els.resultContinue.removeEventListener("click", onContinue);
      if (els.resultNext) els.resultNext.removeEventListener("click", onNext);
      if (els.resultRetry) els.resultRetry.removeEventListener("click", onRetry);
      _dismissResult = null;
      _claimSubmit = null;
      _shareText = "";
      if (els.shareBtn) els.shareBtn.hidden = true;
      els.overlay.classList.add("hidden");
      resolve(value);
    };
    const onContinue = () => finish(undefined);
    const onNext = () => finish(nextMeta ? { next: nextMeta.id } : undefined);
    const onRetry = () => finish(retryOffer ? { next: retryOffer.game } : undefined);
    _dismissResult = onContinue;
    els.resultContinue.addEventListener("click", onContinue);
    if (els.resultNext) els.resultNext.addEventListener("click", onNext);
    if (els.resultRetry) els.resultRetry.addEventListener("click", onRetry);
  });
}

// Dismiss the result overlay programmatically (e.g. the player said "go back to the
// host"); resolves the showResult() promise. No-op if no result is showing.
export function dismissResult() {
  if (_dismissResult) _dismissResult();
}

// ---- day-complete summary card ---------------------------------------------
// Shown by game.js after the FINAL heist's result card is dismissed (before the
// result_ack), so the last card the player sees is today's haul + the reason to
// come back tomorrow. Resolves like showResult: undefined, or {next} when the
// player takes the earned-retry button.
let _dismissDay = null;

export function showDaySummary({
  dayTotal, rank, rival, cracked, of, bestDay, newBestDay, streak,
  retryOffer, onBoard, codename, canClaim, today,
}) {
  if (!els.dayOverlay) return Promise.resolve(undefined);
  els.dayTitle.textContent = onBoard && codename
    ? `That's the day, ${codename}!` : "That's the day!";
  countUp(els.dayScore, Number(dayTotal) || 0);
  els.dayCracked.textContent =
    `${cracked}/${of} heists cracked${cracked === of ? " — clean sweep!" : ""}`;
  if (els.dayRank) {
    let rankText = "";
    if (rank && onBoard) rankText = rank === 1 ? "★ #1 on today's board ★" : `#${rank} on today's board`;
    else if (rank && canClaim) rankText = `That haul would be #${rank} today`;
    els.dayRank.textContent = rankText;
    els.dayRank.hidden = !rankText;
    els.dayRank.classList.toggle("newhigh", onBoard && rank === 1);
  }
  if (els.dayRival) {
    let rivalText = "";
    if (rival && rank && rank > 1) {
      rivalText = rival.gap > 0
        ? `${Number(rival.gap).toLocaleString()} behind ${rival.codename}` +
          (retryOffer ? " — your second chance could close it" : " — tomorrow's your rematch")
        : `Tied with ${rival.codename}, who got there first`;
    }
    els.dayRival.textContent = rivalText;
    els.dayRival.hidden = !rivalText;
  }
  if (els.dayBest) {
    let bestText = "";
    if (newBestDay) bestText = "★ New personal best day ★";
    else if (bestDay && today && bestDay.day !== today) {
      bestText = `Personal best: ${Number(bestDay.total).toLocaleString()} pts — beat it tomorrow.`;
    }
    els.dayBest.textContent = bestText;
    els.dayBest.hidden = !bestText;
  }
  if (els.dayStreak) {
    let streakText = "";
    if (streak >= 2) streakText = `\u{1F525} ${streak}-day streak — play tomorrow to make it ${streak + 1}`;
    else if (streak === 1 && onBoard) streakText = "\u{1F525} Play tomorrow to start a streak";
    els.dayStreak.textContent = streakText;
    els.dayStreak.hidden = !streakText;
  }
  if (els.dayClaimNudge) {
    els.dayClaimNudge.textContent = canClaim
      ? "Sign in from the top bar to keep this haul under one codename — the week's top heister takes the Mastermind's Cut." : "";
    els.dayClaimNudge.hidden = !canClaim;
  }
  if (els.dayRetry) {
    els.dayRetry.textContent = retryOffer
      ? `↻ Use your second chance: ${retryOffer.title}` : "";
    els.dayRetry.hidden = !retryOffer;
  }
  _shareText = `I hauled ${Number(dayTotal).toLocaleString()} pts off ${of} AI gatekeepers ` +
    `on Voice Heist today${rank && onBoard ? ` — #${rank} on the board` : ""}. Think you can beat me?`;
  els.dayOverlay.classList.remove("hidden");
  if (cracked === of) burstConfetti();
  return new Promise((resolve) => {
    const finish = (value) => {
      els.dayContinue.removeEventListener("click", onContinue);
      if (els.dayRetry) els.dayRetry.removeEventListener("click", onRetry);
      _dismissDay = null;
      _shareText = "";
      els.dayOverlay.classList.add("hidden");
      resolve(value);
    };
    const onContinue = () => finish(undefined);
    const onRetry = () => finish(retryOffer ? { next: retryOffer.game } : undefined);
    _dismissDay = onContinue;
    els.dayContinue.addEventListener("click", onContinue);
    if (els.dayRetry) els.dayRetry.addEventListener("click", onRetry);
  });
}

// Dismiss the day summary programmatically (voice "go back", idle stop,
// teardown); resolves the showDaySummary() promise. No-op if it isn't showing.
export function dismissDaySummary() {
  if (_dismissDay) _dismissDay();
}

// ---- orb visualizer -------------------------------------------------------
// A faithful vanilla port of Deepgram's "signature hoop" Orb (@deepgram/ui),
// driven by state + input/output volume. Four rotating bezier hoops; idle is a
// tight breathing ring, listening expands with mic volume, talking reacts to the
// agent's voice. Tuned to the brand green/blue.
//
// startOrb(getMode, getInput, getOutput):
//   getMode()   -> "idle" | "listening" | "talking"
//   getInput()  -> user mic volume 0..1
//   getOutput() -> agent output volume 0..1
const PI = (e) => Math.PI * e;
const _pt = (p, r, a) => ({ x: p.x + r * Math.cos(a), y: p.y + r * Math.sin(a) });
const _lerp = (a, b, t) => t * (b - a) + a;
const _clamp01 = (e) => Math.min(1, Math.max(0, e));
const _ease = (e) => (e < 0.5 ? 2 * e * e : 1 - (-2 * e + 2) ** 2 / 2);
const _avg = (arr, t) => {
  const n = arr.slice(t, t + 10);
  return n.reduce((a, b) => a + b, 0) / (n.length || 1);
};

function _orbRings(colors) {
  const c = {
    primary: (colors?.[0] ?? "#13ef93") + "cc",
    secondary: (colors?.[1] ?? "#ee028c") + "cc",
    lightPurple: "#ae63f9cc",
    lightBlue: "#14a9fbcc",
    green: "#a1f9d4cc",
    transparent: "transparent",
  };
  return [
    { segments: [{ pct: 0.42, color: c.transparent }, { pct: 0.61, color: c.secondary }], startAngle: 3.52, speedMultiplier: 1.21, centerOffset: { x: 0.01, y: -0.01 }, radiusOffset: 0.02, width: 3.38 },
    { segments: [{ pct: 0.28, color: c.primary }, { pct: 0.62, color: c.secondary }, { pct: 0.8, color: c.transparent }], startAngle: 1.59, speedMultiplier: 0.64, centerOffset: { x: -0.03, y: -0.01 }, radiusOffset: 0.05, width: 2.39 },
    { segments: [{ pct: 0.1, color: c.transparent }, { pct: 0.31, color: c.green }, { pct: 0.45, color: c.lightBlue }, { pct: 0.66, color: c.lightPurple }], startAngle: 2.86, speedMultiplier: 0.94, centerOffset: { x: 0.02, y: 0.02 }, radiusOffset: -0.06, width: 2.64 },
    { segments: [{ pct: 0.1, color: c.lightPurple }, { pct: 0.5, color: c.transparent }, { pct: 0.9, color: c.green }], startAngle: 5.67, speedMultiplier: 1.3, centerOffset: { x: -0.01, y: 0.01 }, radiusOffset: 0.04, width: 2.95 },
  ];
}

const _speed = (s) => (s === "talking" ? 1 : s === "listening" ? 0.7 : 0.2);
const _deflation = (s) => (s === "talking" ? 0.55 : s === "listening" ? 0 : 1);
const _rocking = (s) => (s === "talking" ? 0 : s === "listening" ? PI(1 / 15) : PI(0.5));

function _gradient(ctx, off, angle, segments) {
  const ox = ctx.canvas.width / 2;
  const oy = ctx.canvas.height / 2;
  const g = ctx.createLinearGradient(
    ox * (1 - Math.cos(angle) + off.x), oy * (1 - Math.sin(angle) + off.y),
    ox * (1 + Math.cos(angle) + off.x), oy * (1 + Math.sin(angle) + off.y)
  );
  segments.forEach(({ pct, color }) => g.addColorStop(pct, color));
  return g;
}

function _drawHoop(ctx, off, radius, deflation, startAngle, stroke) {
  const center = { x: (ctx.canvas.width / 2) * (1 + off.x), y: (ctx.canvas.height / 2) * (1 + off.y) };
  const ctrl = radius * (4 / 3) * Math.tan(PI(1 / 8));
  ctx.strokeStyle = stroke;
  ctx.beginPath();
  const d = startAngle + PI(0.5);
  const u = startAngle + PI(1.5);
  ctx.arc(center.x, center.y, radius, d, u, false);
  const f = _pt(center, radius, u);
  const p = PI(1.5) - startAngle;
  const g = Math.cos(p) * radius;
  const m = _pt(_pt(center, radius, startAngle), g * deflation * 2, PI(0.5));
  const h = _pt(center, radius, d);
  const c1 = _pt(f, ctrl, u + PI(0.5));
  const c2 = _pt(m, ctrl, startAngle + PI(1.5));
  ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, m.x, m.y);
  const c3 = _pt(m, ctrl, startAngle + PI(0.5));
  const c4 = _pt(h, ctrl, d + PI(1.5));
  ctx.bezierCurveTo(c3.x, c3.y, c4.x, c4.y, h.x, h.y);
  ctx.stroke();
}

function _drawOrb(ctx, st, delta, rings) {
  st.time += delta * _lerp(1, st.speed, st.deflation);
  const since = performance.now() - st.transitionStart;
  if (st.deflation !== st.targetDeflation) {
    const e = _ease(_clamp01(since / (st.targetDeflation > st.startDeflation ? 1000 : 300)));
    st.deflation = e >= 1 ? st.targetDeflation : _lerp(st.startDeflation, st.targetDeflation, e);
  }
  if (st.rockingAngle !== st.targetRocking) {
    const e = _ease(_clamp01(since / 1000));
    st.rockingAngle = e >= 1 ? st.targetRocking : _lerp(st.startRocking, st.targetRocking, e);
  }
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const a = Math.min(ctx.canvas.width, ctx.canvas.height) / 2;
  const scale = a / 100; // keep line/shadow proportions consistent at any backing res
  const breathe = 1 + 0.02 * Math.sin((st.time * PI(1)) / 3 / 1000) * _lerp(1, 0, st.deflation);
  const s = _ease(st.deflation);
  const reactAgent = st.targetDeflation > 0.3 && st.targetDeflation < 1;
  rings.forEach((ring, r) => {
    ctx.lineWidth = ring.width * scale;
    ctx.shadowColor = ring.segments[0].color;
    ctx.shadowBlur = 1.1 * ring.width * scale;
    let rad = 0.8 * a * breathe;
    if (st.targetDeflation === 0 && st.deflation < 0.05) {
      const e = Math.min(0.7, _avg(st.userNoise, 3 * r));
      rad = Math.min(rad * (1 + e * 0.15 * 2), 0.92 * a);
    }
    const grad = _gradient(ctx, ring.centerOffset, ring.startAngle + (st.time * PI(1)) / 1000 / 6 * ring.speedMultiplier, ring.segments);
    let d = s;
    if (reactAgent) d = s * (1 - 0.4 * _avg(st.agentNoise, 3 * r));
    _drawHoop(ctx, ring.centerOffset, rad + ring.radiusOffset * rad, d, PI(1.5) + Math.sin((st.time * PI(2)) / 3 / 1000) * st.rockingAngle, grad);
  });
}

export function startOrb(getMode, getInput, getOutput) {
  const ctx = els.orb.getContext("2d");
  const rings = _orbRings(["#13ef95", "#149afb"]);
  const reducedMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let mode = getMode();
  const st = {
    time: 0,
    speed: _speed(mode),
    deflation: _deflation(mode),
    rockingAngle: _rocking(mode),
    agentNoise: Array(22).fill(0),
    userNoise: Array(22).fill(0),
    targetDeflation: _deflation(mode),
    targetRocking: _rocking(mode),
    transitionStart: 0,
    startDeflation: _deflation(mode),
    startRocking: _rocking(mode),
  };
  // Reduced motion: draw one static frame instead of the animation loop — the
  // orb stays as the visual anchor without the constant movement.
  if (reducedMotion) {
    _drawOrb(ctx, st, 16, rings);
    return;
  }
  let last = performance.now();
  function frame(now) {
    const delta = now - last;
    last = now;
    const m = getMode();
    if (m !== mode) {
      mode = m;
      st.speed = _speed(m);
      st.transitionStart = performance.now();
      st.startDeflation = st.deflation;
      st.startRocking = st.rockingAngle;
      st.targetDeflation = _deflation(m);
      st.targetRocking = _rocking(m);
    }
    st.agentNoise.shift();
    st.agentNoise.push(getOutput ? getOutput() : 0);
    st.userNoise.shift();
    st.userNoise.push(getInput ? getInput() : 0);
    _drawOrb(ctx, st, delta, rings);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
