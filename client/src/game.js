import { AgentSession, AgentMicrophone, AgentPlayer } from "@deepgram/agents";
import * as ui from "./ui.js";
import * as sfx from "./sfx.js";

const TOKEN_ENDPOINT = "/api/deepgram-token";
const BRAIN_WS = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/brain`;
const LEVEL_IDS = ["order", "refund", "receptionist", "list"];
// Idle watchdog: with no player action for this long while connected, drop the
// live audio session and park at the offline lobby. On the open web this is a
// cost guard (an abandoned tab must not stream a hot mic to Deepgram forever) —
// identity and standings are always kept; reconnecting resumes where they left off.
const IDLE_DISCONNECT_MS = 90_000;
// Ignore voice dismissal for the first beats of the result card, so the
// celebration (count-up + confetti) survives its own applause.
const RESULT_VOICE_GRACE_MS = 3000;
// Brain control-channel reconnect: a server hiccup should be a two-second blip,
// not a silently dead kiosk.
const BRAIN_MAX_RETRIES = 5;

// The browser is a thin client: it holds the low-latency Deepgram audio session,
// but the Python "brain" (over a separate control WebSocket) owns all game logic.
// We relay Deepgram function calls + turn events to the brain and execute the
// directives it sends back (handoff, result, lobby, function responses).
export class Game {
  constructor() {
    this.session = null;
    this.mic = null;
    this.player = null;
    this.brain = null;
    this.config = null; // { agent, audio } from the brain's init message
    this.connected = false;
    this.muted = false;
    this.inLevel = false;
    this.inIntro = false; // pre-heist briefing step (the Briefer is speaking)
    this.pendingResult = null; // result directive awaiting the agent's closing line
    this.pendingStart = null; // deferred heist handoff, applied after "Good luck!"
    this.closingTimer = null;
    this.revealWaiting = false; // result-reveal poller is running (single-flights it)
    this.closingAudioDone = false; // server finished SENDING the closing line's audio
    this.reconnecting = false; // a fresh-session handoff is in progress
    this.handoffWaiting = false; // a deferred handoff is waiting out "Good luck!"
    this.intentionalClose = false; // set during teardown so we don't warn
    this.onAuthLost = null; // set by main.js: called when the gate/player is pulled
    // Set by main.js: onFinishByVoice ends this session ("I'm done" / "start over").
    this.onFinishByVoice = null;
    // Which heists are enabled at this event, plus this session's results.
    this.available = [...LEVEL_IDS];
    this.results = {};
    this.retry = { available: false, targets: [] }; // earned second chance (brain-owned)
    this.streak = 0; // consecutive event days with a play (registered players)
    this.daySummaryPending = null; // daySummary payload queued behind the result card
    this.codename = null; // this player's public leaderboard codename
    this.playerTier = null; // "anon" | "quick" | "code" | … — whether the codename is boarded
    this.listening = false; // mic hot for the player's turn — gates in-call SFX
    this.bankedScore = 0; // total from completed heists today (persistent arcade score)
    this.heistScore = 0; // current heist's live score (shown on top of bankedScore)
    this.currentHint = null; // active heist's hint, popped after an off-track turn
    this.heistEnded = false; // closing-line phase: gate the mic so the verdict line isn't barged
    this.resultOpen = false; // result overlay up: mic open for "go back", but the gatekeeper is kept silent
    this.paused = false; // "stop" pause: mic muted AND the agent kept silent until Unmute
    this.resultShownAt = 0; // when the result card rendered (voice-dismiss grace period)
    this.pendingRetryConfig = null; // a failed handoff's agent config, retried by the Connect button
    this.brainRetries = 0; // brain WS auto-reconnect attempts since the last good connection
    this.lastActivityAt = performance.now(); // last player action, for the idle watchdog
    this._idleTimer = setInterval(() => this._idleTick(), 10_000);
    // Live board: refresh the rail while the player is choosing (same 15s
    // cadence as /leaderboard). Paused mid-heist — the rail is hidden in-call
    // and the fetch would be noise next to the live audio session.
    this._boardTimer = setInterval(() => {
      if (!this.inLevel && !this.inIntro && !this.resultOpen) this.updateTodaysBest();
    }, 15_000);
  }

  // Any player action (speech, tap) proves someone is still there.
  touchActivity() {
    this.lastActivityAt = performance.now();
  }

  _idleTick() {
    const idle = performance.now() - this.lastActivityAt;
    if (this.connected && idle > IDLE_DISCONNECT_MS) this.idleStop();
    // No second stage on the web: this is someone's own device, so an idle tab
    // must never wipe their identity — that was booth-kiosk behavior.
  }

  // Mint a Deepgram token, carrying the auth cookies. A 401 means the player
  // session was pulled — surface it so we can return to sign-in. The status
  // travels on the error so the connect paths can explain a 429 honestly
  // instead of blaming the player's mic.
  fetchToken() {
    return fetch(TOKEN_ENDPOINT, { credentials: "include" }).then(async (r) => {
      if (!r.ok) {
        if (r.status === 401 && this.onAuthLost) this.onAuthLost();
        const body = await r.text().catch(() => "");
        const err = new Error(body || `token request failed (${r.status})`);
        err.status = r.status;
        throw err;
      }
      return r.text();
    });
  }

  // Tear everything down between players (booth loop) or on revoked access:
  // close the Deepgram session, mic, and brain WS, and reset session state.
  teardown() {
    this.intentionalClose = true;
    ui.dismissResult(); // a result card left open by a walk-away must not greet the next player
    this.daySummaryPending = null;
    ui.dismissDaySummary();
    this.pendingRetryConfig = null;
    try { if (this.mic) this.mic.stop(); } catch (e) { /* ignore */ }
    try {
      if (this.session) {
        this.session.removeAllListeners();
        this.session.disconnect();
      }
    } catch (e) { /* ignore */ }
    try { if (this.brain) this.brain.close(); } catch (e) { /* ignore */ }
    this.session = null;
    this.mic = null;
    this.player = null;
    this.brain = null;
    this.config = null;
    this.connected = false;
    this.inLevel = false;
    this.inIntro = false;
    this.pendingResult = null;
    this.pendingStart = null;
    this.heistEnded = false;
    this.resultOpen = false;
    this.paused = false;
    this.revealWaiting = false;
    this.closingAudioDone = false;
    this.results = {};
    this.available = [...LEVEL_IDS];
    this.retry = { available: false, targets: [] };
    this.streak = 0;
    clearTimeout(this.closingTimer);
    ui.setConnected(false);
    ui.setPhase("lobby");
    ui.hideTurn();
    ui.hideHint();
    ui.setStreak(0);
    ui.setSweepMeter(0, 0);
    this.bankedScore = 0;
    this.heistScore = 0;
    ui.setTotalScore(0);
    this.intentionalClose = false;
  }

  // Per-card status from event availability + this session's results. A busted
  // heist the earned second chance can re-open shows as "retry" (playable).
  computeStatus() {
    const map = {};
    for (const id of LEVEL_IDS) {
      if (!this.available.includes(id)) map[id] = "unavailable";
      else if (this.results[id] === "win") map[id] = "win";
      else if (this.results[id] === "lose") {
        map[id] = this.retry?.available && this.retry.targets?.includes(id) ? "retry" : "lose";
      } else map[id] = "open";
    }
    return map;
  }

  // The lobby's session-goal meter: "x/4 cracked today" → CLEAN SWEEP.
  updateProgress() {
    const cracked = this.available.filter((id) => this.results[id] === "win").length;
    ui.setSweepMeter(cracked, this.available.length);
  }

  // ---- visualizer (drives the Deepgram-style orb) --------------------------
  orbMode() {
    if (!this.connected) return "idle";
    const remaining = this.player ? this.player.getRemainingPlaybackTime() : 0;
    if (remaining > 0.05) return "talking";
    return "listening";
  }
  orbInput() {
    return this.mic && !this.muted ? clamp(this.mic.getInputVolume()) : 0;
  }
  orbOutput() {
    return this.player ? clamp(this.player.getOutputVolume()) : 0;
  }

  // ---- brain (control channel) ---------------------------------------------
  connectBrain() {
    const ws = new WebSocket(BRAIN_WS);
    this.brain = ws;
    ws.addEventListener("open", () => {
      if (this.brain === ws) this.brainRetries = 0;
    });
    ws.addEventListener("message", (ev) => {
      let directive;
      try {
        directive = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.applyDirective(directive);
    });
    ws.addEventListener("close", (ev) => {
      // Torn down or replaced (teardown nulls/reassigns this.brain BEFORE the
      // close event fires) — nothing to recover.
      if (this.brain !== ws || this.intentionalClose) return;
      if (ev.code === 4401) {
        // The brain refused the upgrade: the player session is invalid.
        if (this.onAuthLost) this.onAuthLost();
        return;
      }
      if (ev.code === 4429) {
        // House full: the server is at its session cap. Stay in fiction and
        // keep trying on a slow cadence — a busy signal, not an error.
        ui.setStatus("Every line into the vault is hot right now — the crew is at capacity. Hold tight, retrying…", { sticky: true });
        setTimeout(() => {
          if (this.brain === ws && !this.intentionalClose) this.connectBrain();
        }, 30000);
        return;
      }
      // Auto-reconnect with backoff. The server's fresh session replays `init`
      // on connect, which restores the lobby (a heist in flight is lost — its
      // verdict state lived in the old session).
      if (this.brainRetries < BRAIN_MAX_RETRIES) {
        const delay = Math.min(8000, 1000 * 2 ** this.brainRetries);
        this.brainRetries += 1;
        ui.setStatus("Reconnecting to the game…");
        setTimeout(() => {
          if (this.brain === ws && !this.intentionalClose) this.connectBrain();
        }, delay);
      } else {
        ui.setStatus('Connection lost. Tap "Start over" to reset.');
        ui.addSystemNote("Lost connection to the game brain.");
      }
    });
    ws.addEventListener("error", () => {
      if (this.brain === ws) ui.setStatus("Can’t reach the game right now — hang tight, reconnecting…");
    });
  }

  sendBrain(obj) {
    if (this.brain && this.brain.readyState === WebSocket.OPEN) {
      this.brain.send(JSON.stringify(obj));
    }
  }

  async applyDirective(d) {
    switch (d.type) {
      case "init":
        this.config = { agent: d.agent, audio: d.audio };
        this.available = d.ui?.available || [...LEVEL_IDS];
        this.results = d.ui?.results || {};
        this.retry = d.ui?.retry || { available: false, targets: [] };
        this.streak = d.ui?.streak || 0;
        this.codename = d.ui?.player?.codename || null;
        this.playerTier = d.ui?.player?.tier || null;
        this.bankedScore = d.ui?.playerScore || 0;
        this.heistScore = 0;
        this.touchActivity();
        // Let the standalone /leaderboard page highlight "you": same-origin
        // localStorage is the only identity bridge it has (it fetches no auth).
        try {
          const boarded = this.playerTier && !["anon", "test"].includes(this.playerTier);
          if (boarded && this.codename) localStorage.setItem("vh_codename", this.codename);
          else localStorage.removeItem("vh_codename");
        } catch { /* storage unavailable — the board just won't self-highlight */ }
        ui.setTotalScore(this.bankedScore);
        ui.setStreak(this.streak);
        ui.renderHeists(this.computeStatus());
        this.updateProgress();
        ui.setAgentName(d.ui?.agentName || "Alexis, the Host");
        ui.setPhase("lobby");
        this.updateTodaysBest();
        if (this.connected) {
          // The brain reconnected mid-audio-session (fresh GameSession server-side).
          // Bring the audio side back to the Host so both sides agree; whatever
          // heist was in flight is gone with the old session. A result card left
          // up from the old session must go too — resultOpen would otherwise
          // silence every agent and eat every turn on the fresh session (the
          // result_ack it resolves is guarded stale in revealResult).
          this.inLevel = false;
          this.inIntro = false;
          this.pendingResult = null;
          this.pendingStart = null;
          this.heistEnded = false;
          this.paused = false;
          this.resultOpen = false;
          this.daySummaryPending = null;
          ui.dismissResult();
          ui.dismissDaySummary();
          ui.hideTurn();
          ui.hideCue();
          ui.hideHint();
          ui.setStatus("Reconnected. Patching you back to the Host…");
          await this.reconnectAgent(d.agent);
          if (this.connected) ui.setStatus("Back with the Host. Pick your next heist.");
          break;
        }
        ui.setConnected(false);
        ui.setControls({ connect: { label: "Connect", disabled: false }, finish: true });
        ui.setPlayerBadge(d.ui?.player || null);
        {
          // Personalize only for a real identity — anonymous sessions carry the
          // placeholder handle "Guest", and "Welcome, Guest" reads like a bug.
          const who = d.ui?.player?.handle;
          ui.setStatus(who && who !== "Guest"
            ? `Welcome, ${who}. Click connect to begin.`
            : "Click connect to begin.");
        }
        break;

      case "fn_response":
        if (this.session) {
          this.session.sendFunctionCallResponse(d.id, d.name, JSON.stringify(d.content ?? {}));
        }
        break;

      case "handoff":
        if (d.defer) {
          // Begin the heist only after the current line ("Good luck!") finishes.
          this.pendingStart = d;
        } else {
          await this.applyHandoff(d);
        }
        break;

      case "turn":
        ui.setTurn(d.current, d.max);
        break;

      case "score":
        this.heistScore = d.total;
        ui.setTotalScore(this.bankedScore + this.heistScore, d.delta, d.label);
        // After an off-track ("weak") turn, pop a coaching hint; clear it on track.
        if (d.label === "weak") ui.showHint(this.currentHint);
        else ui.hideHint();
        // Blip only when not actively listening, so it can't bleed into the mic.
        if (!this.listening && d.delta > 0) sfx.blip(d.label);
        break;

      case "result":
        if (d.results) this.results = d.results;
        if (d.retry) this.retry = d.retry;
        ui.setHeistStatus(this.computeStatus());
        this.updateProgress();
        // Heist decided — stop feeding the mic to the gatekeeper so it can't keep
        // conversing past the result (its own closing line still plays — that's output).
        this.heistEnded = true;
        if (d.immediate) {
          this.revealResult(d);
        } else {
          this.pendingResult = d;
          this.closingAudioDone = false;
          this.scheduleResultReveal();
        }
        break;

      case "lobby":
        this.inLevel = false;
        this.inIntro = false;
        this.pendingResult = null;
        this.pendingStart = null;
        this.heistEnded = false; // back with the Host — re-open the mic
        this.resultOpen = false;
        this.paused = false;
        this.heistScore = 0;
        ui.setTotalScore(this.bankedScore);
        if (d.results) this.results = d.results;
        if (d.retry) this.retry = d.retry;
        ui.setHeistStatus(this.computeStatus());
        this.updateProgress();
        ui.hideTurn();
        ui.hideCue();
        ui.hideHint();
        ui.setPhase("lobby");
        ui.setAgentName(d.ui.agentName);
        ui.setControls({ lobby: false });
        this.updateTodaysBest();
        if (!this.connected) {
          // Offline (idle stop / dropped call): just keep the fresh Host config
          // for the next connect — never spin up audio with nobody there.
          if (this.config) this.config.agent = d.agent;
          ui.setControls({ connect: { label: "Connect", disabled: false }, mute: false });
          break;
        }
        // Same rule as applyHandoff: the Host takes the stage on a fresh session
        // with her voice assigned at session start; the return line plays as the
        // new session's greeting. Mask the teardown-reconnect gap as a phone
        // transfer — part of the heist fiction instead of dead air.
        ui.setStatus("Patching you back to the Host…");
        sfx.ring();
        await this.reconnectAgent(d.agent);
        if (this.connected) ui.setStatus("Back with the Host. Pick your next heist.");
        break;
    }
  }

  // Wait for the current line to finish PLAYING (not just being sent) before
  // running cb. getRemainingPlaybackTime() drains to ~0 once the player empties;
  // agent-audio-done only means the server stopped SENDING, so the buffer is often
  // still playing. Capped so a stuck stream can't hang the game.
  afterPlayback(cb, maxWaitMs = 6000) {
    const begin = performance.now();
    const tick = () => {
      const remaining = this.player ? this.player.getRemainingPlaybackTime() : 0;
      if (remaining <= 0.05 || performance.now() - begin > maxWaitMs) {
        setTimeout(cb, 150); // small grace, then run
      } else {
        setTimeout(tick, 100);
      }
    };
    tick();
  }

  // ---- handoff (Briefer intro / gatekeeper) --------------------------------
  async applyHandoff(d) {
    const intro = d.stage === "intro";
    this.inLevel = !intro;
    this.inIntro = intro;
    this.pendingResult = null;
    this.paused = false; // a fresh heist/brief is never pre-paused
    ui.setPhase("call");
    ui.clearTranscript();
    ui.setAgentName(d.ui.agentName);
    ui.renderLevelBrief(d.ui);
    // The gentle themed cue (e.g. "Trust, but verify."), popped
    // lower-right after an off-track turn — softer than the explicit hint.
    this.currentHint = d.ui.cue || null;
    ui.hideHint();
    this.heistScore = 0;
    ui.setTotalScore(this.bankedScore);
    let readyLine;
    if (intro) {
      // Briefing step: no turns yet, just the heist brief and the Briefer. The
      // skip has always worked (saying "ready" fires begin_heist) — advertise it.
      ui.hideTurn();
      readyLine = `${d.ui.agentName} is briefing you on ${d.ui.title} — say “ready” anytime to skip ahead.`;
    } else {
      ui.showCue(d.ui.cue);
      // Name the one rule of the game at the moment it matters: say ANYTHING.
      readyLine = `${d.ui.agentName} is on the line. Say anything — you get ${d.ui.maxTurns} turns to convince them.`;
      ui.setTurn(0, d.ui.maxTurns);
    }
    ui.setControls({ lobby: true });
    // Mask the fresh-session gap as a phone transfer (diegetic, not dead air).
    ui.setStatus(`Patching you through to ${d.ui.agentName}…`);
    sfx.ring();
    // One agent = one session: every persona carries a full agent config
    // (prompt + voice + greeting) and takes the stage on a FRESH session, with
    // its voice assigned at session start via Settings. Flux TTS (v2) pins the
    // voice per session — a mid-session UpdateSpeak gets ACKED but the old
    // voice keeps playing (observed live) — so per-session assignment is the
    // only reliable mechanism. Tearing down the old socket also guarantees the
    // outgoing agent can't sneak in another line.
    await this.reconnectAgent(d.agent);
    if (this.connected) ui.setStatus(readyLine);
  }

  // ---- Deepgram session ----------------------------------------------------
  async connect() {
    if (!this.config) {
      ui.setStatus("Still loading game config from the brain...");
      return;
    }
    this.touchActivity();
    // A failed mid-heist handoff parked its agent config here: Retry re-runs
    // THAT handoff on the live mic instead of starting over with the Host.
    if (this.pendingRetryConfig && this.mic) {
      const cfg = this.pendingRetryConfig;
      this.pendingRetryConfig = null;
      ui.setControls({ connect: { label: "Connecting...", disabled: true } });
      ui.setStatus("Patching you back through…", { force: true });
      sfx.ring();
      await this.reconnectAgent(cfg);
      if (this.connected) {
        ui.setConnected(true);
        ui.setControls({
          connect: { label: "Connected", disabled: true },
          mute: true,
          muted: this.muted,
        });
        ui.setStatus("Back on the line.");
      }
      return;
    }
    this.pendingRetryConfig = null; // a fresh connect never inherits a stashed handoff
    ui.setControls({ connect: { label: "Connecting...", disabled: true } });
    // force: a user-initiated action always deserves fresh feedback, even if a
    // sticky error message is still on screen from the previous attempt.
    ui.setStatus("Connecting to the Host...", { force: true });

    this.player = new AgentPlayer({ sampleRate: this.config.audio.output.sampleRate });
    this.session = new AgentSession({
      auth: { tokenFactory: () => this.fetchToken() },
      agent: this.config.agent,
      audio: this.config.audio,
    });
    this.heistEnded = false; // fresh session starts ungated
    this.resultOpen = false;
    // Gate on heistEnded so a busted/denied gatekeeper stops receiving the player.
    this.mic = new AgentMicrophone((data) => this.session && !this.heistEnded && this.session.sendAudio(data), {
      sampleRate: this.config.audio.input.sampleRate,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });

    this.wireSessionEvents();

    try {
      await this.session.connect();
      await this.mic.start();
      this.connected = true;
      sfx.coin();
      ui.setConnected(true);
      ui.setControls({ connect: { label: "Connected", disabled: true }, mute: true, muted: false });
      ui.setStatus("Tell the Host which heist to run \u2014 or tap a card.");
    } catch (err) {
      console.error(err);
      // Name the actual problem in human words \u2014 "Permission denied" reads
      // like a stack trace and helps nobody.
      const msg = String(err?.message || err);
      // Sticky: the brain-WS reconnect loop must not clobber this explanation
      // while the player is reading it.
      if (err?.status === 429) {
        // The per-IP token budget (shared NAT, or a farmer) \u2014 not the mic.
        ui.setStatus("Too many sessions from this network right now \u2014 wait a minute, then tap Retry.", { sticky: true });
      } else if (err?.name === "NotAllowedError" || /permission|not.?allowed|denied/i.test(msg)) {
        ui.setStatus("The microphone is blocked. Click the mic icon in the address bar to allow it, then tap Retry.", { sticky: true });
      } else {
        ui.setStatus("Couldn\u2019t connect \u2014 check the internet and mic, then tap Retry.", { sticky: true });
      }
      ui.setControls({ connect: { label: "Retry connect", disabled: false } });
    }
  }

  wireSessionEvents() {
    const s = this.session;

    s.on("audio", (chunk) => this.player.queue(chunk));
    s.on("user-started-speaking", () => {
      this.listening = true;
      this.touchActivity();
      this.player.interrupt();
      ui.setConnState("listening");
    });
    s.on("agent-started-speaking", () => {
      this.listening = false;
      ui.setConnState("speaking");
      // Keep the agent silent while the result overlay is up (heist over; mic open
      // only for "go back"), or after a "stop" pause — cut it the instant it speaks.
      if ((this.resultOpen || this.paused) && this.player) this.player.interrupt();
    });

    s.on("conversation-text", (msg) => {
      if (!msg?.content) return;
      ui.addTranscript(msg.role, msg.content);
      if (msg.role !== "user") return;
      this.touchActivity();
      // On the result overlay, a spoken "back to the host / next heist" dismisses
      // it to the lobby (same as the button). Not a heist turn. A short grace
      // period keeps celebration chatter ("we're DONE, that was awesome!") from
      // yanking the card away mid-confetti.
      if (this.resultOpen) {
        if (performance.now() - this.resultShownAt >= RESULT_VOICE_GRACE_MS &&
            isReturnCommand(msg.content)) {
          // "Go back" means go back: skip a queued day summary too.
          this.daySummaryPending = null;
          ui.dismissResult();
          ui.dismissDaySummary();
        }
        return;
      }
      // Voice navigation (everything except mute): "back to the host" mid-heist,
      // "next player" at the Host. Handled here so it doesn't count as a turn.
      if (this.handleVoiceCommand(msg.content)) return;
      // The player's line landed and the agent is composing a reply — show it,
      // so the wait never reads as "it didn't hear me" (repeat-yourself spiral).
      if (this.connected && !this.paused && !this.heistEnded) {
        ui.setConnState("thinking");
      }
      // Report the player's turns (with text) so the brain can enforce the
      // turn cap, score the turn, and ignore stray speech fragments.
      if (this.inLevel && !this.pendingResult) {
        this.sendBrain({ type: "user_turn", text: msg.content });
      }
    });

    s.on("function-call-request", (msg) => {
      for (const fn of msg.functions || []) {
        this.sendBrain({
          type: "fn_call",
          id: fn.id,
          name: fn.name,
          args: safeParse(fn.arguments ?? fn.input),
        });
      }
    });

    s.on("agent-audio-done", () => {
      this.listening = true;
      if (this.connected) ui.setConnState("listening");
      if (this.pendingStart && !this.handoffWaiting) {
        // The Briefer said "Good luck!" — wait for that audio to finish PLAYING
        // before tearing down for the gatekeeper, or it gets cut. The handoff
        // stays in this.pendingStart until it actually fires, so anything that
        // nulls the field in the meantime (a lobby directive, a disconnect,
        // teardown) genuinely cancels it — the gatekeeper can't start against
        // a brain that already went back to the lobby.
        this.handoffWaiting = true;
        this.afterPlayback(() => {
          this.handoffWaiting = false;
          const start = this.pendingStart;
          this.pendingStart = null;
          if (start && this.connected) this.applyHandoff(start);
        });
        return;
      }
      if (this.pendingResult) {
        // The closing line finished SENDING. Mark it so the poller can reveal once
        // the buffer also finishes PLAYING (never before). Idempotent.
        this.closingAudioDone = true;
        this.scheduleResultReveal();
        return;
      }
      // Let the brain decide if the turn cap was blown (forced loss).
      if (this.inLevel) this.sendBrain({ type: "agent_done" });
    });

    s.on("settings-applied", () => {
      // Fires on every settings push — including a reconnect *into* a heist. Only
      // announce "ready" at the Host; in a briefing/heist the status already names
      // the active gatekeeper (set in applyHandoff), so don't clobber it.
      if (this.inLevel || this.inIntro) return;
      ui.setStatus("Connected. The Host is ready.");
    });
    s.on("disconnected", (reason) => {
      if (this.reconnecting) return; // intentional fresh-session handoff
      this.connected = false;
      ui.setConnected(false);
      if (this.inLevel || this.inIntro) {
        // The call dropped mid-heist: that run is lost. Point the brain back at
        // the lobby NOW so a reconnect meets the Host on both sides — otherwise
        // the Host's voice answers while the brain still scores a ghost heist.
        this.inLevel = false;
        this.inIntro = false;
        this.pendingResult = null;
        this.pendingStart = null;
        this.heistEnded = false;
        ui.hideTurn();
        ui.hideCue();
        ui.hideHint();
        ui.setPhase("lobby");
        this.sendBrain({ type: "request_lobby" });
        ui.setStatus("The call dropped mid-heist. Tap Reconnect and the Host will set you back up.");
      } else {
        ui.setStatus(`Disconnected: ${reason || "connection closed"}. Tap Reconnect.`);
      }
      ui.setControls({ connect: { label: "Reconnect", disabled: false }, mute: false, lobby: false });
    });
    // Deepgram agent-pipeline errors (e.g. a transient "failed to think" or an
    // input-timeout while a fresh handoff session warms up) are usually momentary
    // and self-heal, so don't spray scary "AGENT ERROR" lines into the player's
    // transcript — log them for debugging instead. A real connection loss still
    // surfaces via "disconnected".
    s.on("error", (m) => console.warn("[agent error]", m?.description || m));
    s.on("warning", (m) => console.warn("[agent warning]", m?.description || m));
    s.on("sdk-error", (e) => console.warn("[sdk error]", e?.message || e));
  }

  // Tear down the current session and start a fresh one with `agentConfig` as the
  // initial agent. The new agent's greeting (its opening line) plays reliably on
  // connect, and disconnecting the old session stops any in-flight audio at once.
  async reconnectAgent(agentConfig) {
    this.reconnecting = true;
    if (this.player) this.player.interrupt();
    const old = this.session;
    // Point the mic at the new session BEFORE tearing down the old one, so the
    // mic callback never sees a null session and stops streaming. A gap here is
    // what makes Deepgram's fresh socket time out "waiting for binary messages
    // containing user speech" during the handoff.
    const next = new AgentSession({
      auth: { tokenFactory: () => this.fetchToken() },
      agent: agentConfig,
      audio: this.config.audio,
    });
    this.session = next;
    try {
      if (old) {
        old.removeAllListeners();
        old.disconnect();
      }
    } catch (e) {
      /* ignore */
    }
    this.wireSessionEvents();
    try {
      await next.connect();
      this.connected = true;
      this.pendingRetryConfig = null;
    } catch (err) {
      console.error(err);
      // Stale attempt: teardown/idleStop replaced or nulled the session while
      // this connect was in flight (e.g. the player session expired mid-handoff).
      // Touch nothing — a dead player's handoff must never leak Retry state or
      // status copy into the next player's session.
      if (this.session !== next) return;
      // Be honest about the state (we are NOT connected) and leave a one-tap
      // way back in: the Connect button becomes Retry and re-runs THIS handoff.
      this.pendingRetryConfig = agentConfig;
      this.connected = false;
      ui.setConnected(false);
      ui.setControls({ connect: { label: "Retry", disabled: false }, mute: false, lobby: false });
      ui.setStatus(err?.status === 429
        ? "Too many sessions from this network right now — wait a minute, then tap Retry."
        : "Lost the line — tap Retry to get back in.");
    } finally {
      this.reconnecting = false;
    }
  }


  // ---- results -------------------------------------------------------------
  // Reveal the win/lose card only once the gatekeeper's closing line has finished
  // PLAYING — never while it's still talking. So: never reveal while audio is in the
  // buffer; wait until the server has finished SENDING the line (closingAudioDone,
  // set on agent-audio-done) AND the buffer has drained, then a short beat. There is
  // deliberately NO timer that can fire mid-speech. Backstops only for stuck states:
  // a long silence if agent-audio-done never fires, 5s if the line never starts, and
  // a 25s absolute cap so the card can't hang forever. Started when the result lands
  // and re-pinged on agent-audio-done; the revealWaiting guard single-flights it.
  scheduleResultReveal() {
    if (this.revealWaiting || !this.pendingResult) return;
    this.revealWaiting = true;
    const begin = performance.now();
    let heardAudio = false; // the closing line has begun playing
    let quietSince = null;  // when the buffer last went quiet
    const tick = () => {
      if (!this.pendingResult) { this.revealWaiting = false; return; } // torn down / shown
      const remaining = this.player ? this.player.getRemainingPlaybackTime() : 0;
      const now = performance.now();
      if (remaining > 0.05) {
        heardAudio = true;      // still talking — never reveal now
        quietSince = null;
      } else if (heardAudio) {
        if (quietSince === null) quietSince = now;
        const quiet = now - quietSince;
        // Normal: server is done sending AND the buffer is empty → the line is over.
        if (this.closingAudioDone && quiet >= 400) return this._doReveal();
        // Backstop: clearly over (long silence) even if agent-audio-done never fired.
        if (quiet >= 3000) return this._doReveal();
      } else if (now - begin >= 5000) {
        return this._doReveal(); // the closing line never started — don't hang the card
      }
      if (now - begin >= 25000) return this._doReveal(); // absolute safety net
      this.closingTimer = setTimeout(tick, 80);
    };
    tick();
  }

  _doReveal() {
    this.revealWaiting = false;
    if (this.pendingResult) this.revealResult(this.pendingResult);
  }

  async revealResult(d) {
    clearTimeout(this.closingTimer);
    this.revealWaiting = false;
    this.closingAudioDone = false;
    this.pendingResult = null;
    // The closing line has played by now. Open the result overlay: re-open the mic so
    // the player can say "go back to the host", but keep the gatekeeper silent from here
    // (agent-started-speaking interrupts it while resultOpen). Only hard-cut in-flight
    // audio on an IMMEDIATE result (out of turns) — a verdict's closing line must finish.
    this.heistEnded = false;
    this.resultOpen = true;
    if (d.immediate && this.player) this.player.interrupt();
    // Bank this heist's score into the persistent arcade total. Prefer the
    // server's authoritative day total: a retry win REPLACES the busted play's
    // score, so blind accumulation would double-count (and a failed retry
    // banks nothing at all).
    if (typeof d.dayTotal === "number") this.bankedScore = d.dayTotal;
    else this.bankedScore += d.score || 0;
    this.heistScore = 0;
    ui.setTotalScore(this.bankedScore);
    if (typeof d.streak === "number") {
      this.streak = d.streak;
      ui.setStreak(this.streak);
    }
    ui.hideTurn();
    ui.hideCue();
    ui.hideHint();
    if (d.outcome === "win") (d.sweep ? sfx.sweep() : sfx.win());
    else sfx.bust();
    this.resultShownAt = performance.now();
    this.touchActivity(); // reading the card is presence — don't idle out under it
    // If the brain WS is swapped while the card is up (auto-reconnect), the fresh
    // session never issued this result — its init restores the lobby itself, so
    // acking it would trigger a spurious second Host handoff. Ack only same-socket.
    const brainAtReveal = this.brain;
    // On the last heist of the day, the brain attaches a day summary — queue it
    // to show AFTER this card is dismissed (idle stop / teardown cancel it).
    this.daySummaryPending = d.daySummary || null;
    const choice = await ui.showResult({
      outcome: d.outcome,
      title: d.title,
      path: d.path,
      reason: d.reason,
      hint: d.hint,
      score: d.score,
      base: d.base,
      turnBonus: d.turnBonus,
      turnsLeft: d.turnsLeft,
      streakBonus: d.streakBonus,
      streak: d.streak,
      sweep: d.sweep,
      sweepBonus: d.sweepBonus,
      retrySpent: d.retrySpent,
      retryOffer: d.retryOffer,
      codename: this.codename,
      rank: d.rank,
      newHigh: d.newHigh,
      onBoard: d.onBoard,
      canClaim: d.canClaim,
      rival: d.rival,
      nextOpenId: this.nextOpenId(),
      onClaim: (handle, email) => this.claimScore(handle, email),
    });
    let next = choice?.next || null;
    if (!next && this.daySummaryPending && this.connected) {
      // Fresh voice-dismiss grace so celebration chatter can't yank the summary.
      this.resultShownAt = performance.now();
      this.touchActivity();
      const boarded = this.playerTier && !["anon", "test"].includes(this.playerTier);
      const summaryChoice = await ui.showDaySummary({
        ...this.daySummaryPending,
        onBoard: boarded,
        codename: this.codename,
        canClaim: this.playerTier === "anon",
      });
      next = summaryChoice?.next || null;
    }
    this.daySummaryPending = null;
    // Tell the brain we're done; it sends us back to the lobby host — or, when
    // the player tapped Next/Retry, straight into that heist's briefing.
    if (this.brain === brainAtReveal) {
      this.sendBrain({ type: "result_ack", next: next || undefined });
    }
  }

  // ---- leaderboard hooks -----------------------------------------------------
  // The easiest still-open heist — lets the rival tease name what to play next.
  nextOpenId() {
    const status = this.computeStatus();
    return LEVEL_IDS.find((id) => status[id] === "open") || null;
  }

  // The score to beat, shown in the lobby so the board can motivate BEFORE play.
  // Ships the daily board + the all-time podium to the UI: the chip names
  // today's leader, the rail renders the pantheon and today's race.
  async updateTodaysBest() {
    try {
      const r = await fetch("/api/leaderboard", { credentials: "include" });
      if (!r.ok) {
        ui.resolveBoardPlaceholder();
        return;
      }
      const data = await r.json();
      // Only a boarded identity can appear in the entries — anonymous players'
      // codenames aren't on the public board, so don't pretend to look for them.
      const boarded = this.playerTier && !["anon", "test"].includes(this.playerTier);
      ui.setBoard(data.days || [], data.today || null, data.allTime || [],
        boarded ? this.codename : null, data.recent || [], data.resetInSec || 0);
    } catch {
      // Non-essential decoration — never block the game on it, but do settle
      // the "Checking the board…" placeholder into the plain empty state.
      ui.resolveBoardPlaceholder();
    }
  }

  // Promote this anonymous session onto the leaderboard IN PLACE: the pid keeps
  // today's recorded plays, so the score the player is looking at surfaces on
  // the board the moment they pick a handle.
  async claimScore(handle, email) {
    this.touchActivity();
    try {
      const r = await fetch("/api/auth/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ handle, email: email || undefined }),
      });
      if (!r.ok) return { ok: false, status: r.status };
      const data = await r.json();
      if (data.player?.codename) this.codename = data.player.codename;
      this.playerTier = data.player?.tier || "quick"; // promoted — the codename is boarded now
      ui.setPlayerBadge(data.player || null); // topbar flips from "Sign in" to the codename
      try {
        if (this.codename) localStorage.setItem("vh_codename", this.codename);
      } catch { /* ignore */ }
      this.updateTodaysBest();
      return { ok: true, codename: this.codename };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  // ---- controls ------------------------------------------------------------
  toggleMute() {
    if (!this.mic) return;
    this.touchActivity();
    this.muted = !this.muted;
    if (this.muted) {
      this.mic.mute();
    } else {
      this.mic.unmute();
      this.paused = false; // resuming from a "stop" pause — let the agent speak again
    }
    ui.setControls({ muted: this.muted });
    ui.setStatus(this.muted ? "Mic muted." : "Listening...");
  }

  // "stop" mid-brief/heist: pause. Mute the mic AND silence the agent at once — cut
  // whatever it's saying now and keep it quiet (it would otherwise answer the "stop"
  // you just said). Tapping Unmute clears this and lets the agent speak again.
  pauseAndSilence() {
    this.paused = true;
    if (this.mic && !this.muted) this.toggleMute(); // mute the mic (sets button to Unmute)
    if (this.player) this.player.interrupt();        // cut the agent's current line now
    ui.setStatus("Paused. Tap Unmute to keep going.");
  }

  requestLobby() {
    if (this.connected && (this.inLevel || this.inIntro)) this.sendBrain({ type: "request_lobby" });
  }

  // Soft stop at the Host (landing page): drop the live Deepgram audio session and
  // mic but KEEP the brain session, player identity, and standings — so the page
  // returns to the offline lobby with the "Connect" button.
  // Reconnecting resumes right where they left off.
  // Only valid at the Host; mid-heist "stop" mutes instead (see handleVoiceCommand).
  stopToLobby() {
    if (!this.connected || this.inLevel || this.inIntro) return;
    if (this.player) this.player.interrupt(); // cut any in-flight Host audio at once
    try { if (this.mic) this.mic.stop(); } catch (e) { /* ignore */ }
    try {
      if (this.session) {
        this.session.removeAllListeners(); // so "disconnected" doesn't clobber status
        this.session.disconnect();
      }
    } catch (e) { /* ignore */ }
    this.session = null;
    this.mic = null;
    this.player = null;
    this.connected = false;
    this.muted = false;
    this.paused = false;
    ui.setConnected(false); // data-connected="false" → the Connect button reappears
    ui.setConnState("off");
    ui.setControls({
      connect: { label: "Connect", disabled: false },
      mute: false,
      muted: false,
      lobby: false,
    });
    ui.setStatus("Stopped. Click connect to talk again.");
  }

  // Idle watchdog stage 1: nobody has spoken or tapped for a while. Drop the live
  // audio session (works from ANY phase, unlike stopToLobby) and park at the
  // offline lobby with a friendly nudge. The brain session, identity, and
  // standings are kept — a returning player just reconnects; a true walk-away is
  // cleared by stage 2 (onIdleFinish).
  idleStop() {
    if (!this.connected) return;
    const wasMidHeist = this.inLevel || this.inIntro;
    this.daySummaryPending = null; // an idle walk-away doesn't get the summary
    if (this.resultOpen) {
      ui.dismissResult(); // resolves showResult → result_ack → lobby
      ui.dismissDaySummary();
    }
    if (this.player) this.player.interrupt();
    try { if (this.mic) this.mic.stop(); } catch (e) { /* ignore */ }
    try {
      if (this.session) {
        this.session.removeAllListeners();
        this.session.disconnect();
      }
    } catch (e) { /* ignore */ }
    this.session = null;
    this.mic = null;
    this.player = null;
    this.connected = false;
    this.muted = false;
    this.paused = false;
    this.inLevel = false;
    this.inIntro = false;
    this.pendingResult = null;
    this.pendingStart = null;
    this.heistEnded = false;
    this.pendingRetryConfig = null;
    this.heistScore = 0;
    ui.setTotalScore(this.bankedScore);
    ui.setConnected(false);
    ui.setConnState("off");
    ui.setPhase("lobby");
    ui.hideTurn();
    ui.hideCue();
    ui.hideHint();
    ui.setControls({
      connect: { label: "Connect", disabled: false },
      mute: false,
      muted: false,
      lobby: false,
    });
    ui.setStatus("Anyone there? Click connect to play.");
    // A heist abandoned mid-run is lost — point the brain back at the lobby so a
    // reconnect meets the Host on both sides. (The lobby directive updates the
    // stored agent config without spinning up audio while we're offline.)
    if (wasMidHeist) this.sendBrain({ type: "request_lobby" });
    this.touchActivity();
  }

  // Spoken navigation, so every control except "mute mic" works by voice. Called
  // for each finalized player utterance; returns true if it consumed the line as
  // a command (so it isn't also scored as a heist turn).
  //   - Mid-heist: "back to the host" / "lobby" leaves the current heist (same as
  //     the Back-to-Host button). Anchored on "host"/"lobby" — words a player
  //     never says to a gatekeeper — so it won't fire mid-persuasion.
  //   - At the Host (not mid-heist, no result up): "next player" / "finish up" /
  //     "I'm done" hands the kiosk to the next player (same as the Finish button).
  //     Gated to the Host only, so a game can't be ended by accident.
  //   - Anywhere: a standalone "stop" pauses by muting the mic; at the Host it
  //     instead drops the live session so the "Connect" button comes back. Matched
  //     only as a whole utterance, so "stop charging me" mid-heist won't trip it.
  // Unmute stays a manual button (a muted mic can't hear an "unmute" command).
  handleVoiceCommand(text) {
    const t = (text || "").toLowerCase();
    if (isStopCommand(t)) {
      // Mid-brief/heist: pause (mute the mic + silence the agent). At the Host:
      // drop back to the "Connect" button.
      if (this.inLevel || this.inIntro) this.pauseAndSilence();
      else this.stopToLobby();
      return true;
    }
    if ((this.inLevel || this.inIntro) && isBackToHost(t)) {
      this.requestLobby();
      return true;
    }
    if (!this.inLevel && !this.inIntro && !this.resultOpen && isFinishCommand(t)) {
      if (this.onFinishByVoice) this.onFinishByVoice();
      return true;
    }
    return false;
  }

  // Multimodal shortcut: tapping a heist card starts it, same as telling the Host.
  // Cut the Host's audio now; the brain replies with a fresh-session handoff so the
  // gatekeeper greets cleanly (see reconnectAgent). "retry" cards (an earned
  // second chance at a busted heist) are just as tappable — the brain re-validates.
  chooseHeist(game) {
    this.touchActivity();
    const status = this.computeStatus()[game];
    if (this.connected && !this.inLevel && !this.inIntro &&
        (status === "open" || status === "retry")) {
      sfx.select();
      if (this.player) this.player.interrupt();
      ui.setConnState("listening");
      this.sendBrain({ type: "choose_game", game });
    }
  }
}

function clamp(v) {
  return Math.max(0, Math.min(1, v || 0));
}

// On the result overlay, does the player's line mean "take me back to the host"?
// Intent-shaped phrases only. The old loose version (any utterance containing
// "done / next / continue / go on / …") was celebration vocabulary — "we're
// DONE, that was awesome!" or a bystander's "nice, next one!" killed the win
// card mid-confetti. Anchor words ("host", "lobby", "menu") and explicit
// phrases survive the applause; the button always works instantly.
function isReturnCommand(text) {
  return /\b(host|lobby|menu|go back|take me back|next heist|next one)\b/i.test(text || "");
}

// Mid-heist, does the player want to abandon and return to the Host? Anchored on
// "host"/"lobby"/"menu" — words you'd never say to a bouncer/pizza/refund agent —
// so persuasion lines ("just let me in", "leave it to me") don't trip it.
function isBackToHost(text) {
  return /\b(host|lobby|menu)\b/i.test(text || "");
}

// At the Host, does the player want to end this session and start fresh?
// Specific phrases only, so it can't fire from ordinary "which heist" chatter.
// Mirrors the "End session" button. (The booth-era "next player / new person"
// vocabulary is gone — and "start over" is deliberately NOT matched: after a
// bust it's a natural "let me retry" phrase, and ending the session by voice
// would irreversibly wipe an unclaimed score on a mishear.)
function isFinishCommand(text) {
  const t = text || "";
  return (
    /\b(i'?m|i am|we'?re|we are)\s+(all\s+)?done\b/i.test(t) ||
    /\bend\s+(my|the|this)\s+(session|game)\b/i.test(t)
  );
}

// A standalone "stop" command — pauses (mutes) anywhere, or drops back to the
// Connect button at the Host. Matched ONLY as a whole utterance (optionally
// polite), so "stop charging me" or "I won't stop" mid-heist is never misread.
function isStopCommand(text) {
  return /^\s*(please\s+)?(stop|stop it|stop now|stop talking|stop listening)(\s+please)?\s*[.!]*\s*$/i.test(text || "");
}

function safeParse(input) {
  if (!input) return {};
  try {
    return typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    return {};
  }
}
