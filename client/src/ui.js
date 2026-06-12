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
    gatekeeper: "Tony's Pizza Agent",
    goal: "Get the pizza for free",
    tone: "Goofy",
  },
  {
    id: "refund",
    level: 1,
    icon: "\u{1F4B8}", // money with wings
    title: "The Refund",
    gatekeeper: "StreamFlix Support",
    goal: "Get the refund approved",
    tone: "Absurd",
  },
  {
    id: "receptionist",
    level: 2,
    icon: "\u{260E}\u{FE0F}", // phone
    title: "The Receptionist",
    gatekeeper: "Globex Receptionist",
    goal: "Reach a human",
    tone: "Kafkaesque",
  },
  {
    id: "list",
    level: 3,
    icon: "\u{1F6AA}", // door
    title: "The List",
    gatekeeper: "Vince, the Bouncer",
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
  scoreHudValue: $("scoreHudValue"),
  scoreHudPop: $("scoreHudPop"),
  agentName: $("agentName"),
  connChip: $("connChip"),
  connText: $("connText"),
  newPlayerBtn: $("newPlayerBtn"),
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
  voiceHint: $("voiceHint"),
  muteBtn: $("muteBtn"),
  muteIc: $("muteIc"),
  lobbyBtn: $("lobbyBtn"),
  finishBtn: $("finishBtn"),
  overlay: $("resultOverlay"),
  resultBadge: $("resultBadge"),
  resultTitle: $("resultTitle"),
  resultScore: $("resultScore"),
  resultPath: $("resultPath"),
  resultReason: $("resultReason"),
  resultHint: $("resultHint"),
  resultWho: $("resultWho"),
  resultContinue: $("resultContinue"),
  orb: $("orb"),
  fxCanvas: $("fxCanvas"),
  scoreCue: $("scoreCue"),
  howtoBtn: $("howtoBtn"),
  howtoOverlay: $("howtoOverlay"),
  howtoClose: $("howtoClose"),
  howtoGo: $("howtoGo"),
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
}

// Pre-connect wake word is listening: show the "say Connect" prompt under the CTA.
// Hidden automatically once connected (the CTA itself is hidden when connected).
export function setWakeListening(active) {
  els.app.dataset.wake = active ? "on" : "off";
  if (els.voiceHint) els.voiceHint.hidden = !active;
}

export function setConnState(state) {
  // state: "off" | "connecting" | "listening" | "speaking"
  const label = {
    off: "Offline",
    connecting: "Connecting\u2026",
    listening: "Live",
    speaking: "Live",
  }[state] || "Offline";
  els.connChip.dataset.state = state;
  els.connText.textContent = label;
}

// ---- status / agent -------------------------------------------------------
export function setStatus(text) {
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
  let dots = "";
  for (let i = 0; i < max; i++) dots += i < used ? "\u25CF" : "\u25CB";
  els.turnPill.innerHTML = `<span class="turn-dots">${dots}</span><span>Turn ${used} of ${max}</span>`;
  els.turnPill.classList.remove("hidden");
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
// statusMap: { [levelId]: "open" | "win" | "lose" | "unavailable" }
const CHIP_LABEL = {
  open: "Play",
  win: "Cracked",
  lose: "Busted",
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
    card.querySelector(".heist-status").textContent = CHIP_LABEL[status] || "Play";
    // A win/lose status means the player already completed this heist today, so
    // it's locked until tomorrow (one play per mode per day). Mark it visibly —
    // a touch kiosk has no hover tooltips, so the caption must be on-screen.
    const played = status === "win" || status === "lose";
    card.classList.toggle("played", played);
    const lock = card.querySelector(".heist-locked");
    if (lock) lock.textContent = played ? "Played today · resets tomorrow" : "";
    // Only an open heist on a live session is playable.
    card.disabled = !connected || status !== "open";
  }
}

export function onHeist(fn) {
  els.heistGrid.addEventListener("click", (e) => {
    const card = e.target.closest(".heist-card");
    if (card && !card.disabled) fn(card.dataset.level);
  });
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

// ---- how-to-play modal ----------------------------------------------------
export function initHowTo() {
  const open = () => els.howtoOverlay.classList.remove("hidden");
  const close = () => els.howtoOverlay.classList.add("hidden");
  if (els.howtoBtn) els.howtoBtn.addEventListener("click", open);
  if (els.howtoClose) els.howtoClose.addEventListener("click", close);
  if (els.howtoGo) els.howtoGo.addEventListener("click", close);
  // Click the dimmed backdrop (outside the card) to dismiss.
  if (els.howtoOverlay) {
    els.howtoOverlay.addEventListener("click", (e) => {
      if (e.target === els.howtoOverlay) close();
    });
  }
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
export function showResult({ outcome, title, path, reason, hint, score, codename }) {
  els.resultBadge.textContent = outcome === "win" ? "HEIST CRACKED" : "BUSTED";
  els.resultBadge.className = `result-badge ${outcome === "win" ? "badge-win" : "badge-lose"}`;
  els.resultTitle.textContent = title;
  const hasScore = score || score === 0;
  els.resultScore.hidden = !hasScore;
  if (hasScore) countUp(els.resultScore, score);
  els.resultPath.textContent = path ? `Path unlocked: ${path}` : "";
  els.resultReason.textContent = reason || "";
  // On a bust, reveal the move they missed so they leave laughing and a little
  // wiser. The win screen hides it.
  if (els.resultHint) {
    els.resultHint.textContent = hint || "";
    els.resultHint.hidden = !hint;
  }
  // Show the player their codename and point them at the public leaderboard.
  els.resultWho.textContent = codename ? `${codename} · see the leaderboard` : "";
  els.resultWho.hidden = !codename;
  els.overlay.classList.remove("hidden");
  if (outcome === "win") burstConfetti();
  return new Promise((resolve) => {
    const handler = () => {
      els.resultContinue.removeEventListener("click", handler);
      _dismissResult = null;
      els.overlay.classList.add("hidden");
      resolve();
    };
    _dismissResult = handler;
    els.resultContinue.addEventListener("click", handler);
  });
}

// Dismiss the result overlay programmatically (e.g. the player said "go back to the
// host"); resolves the showResult() promise. No-op if no result is showing.
export function dismissResult() {
  if (_dismissResult) _dismissResult();
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
