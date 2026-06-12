import { AgentSession, AgentMicrophone, AgentPlayer } from "@deepgram/agents";
import * as ui from "./ui.js";
import * as sfx from "./sfx.js";

const TOKEN_ENDPOINT = "/api/deepgram-token";
const BRAIN_WS = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/brain`;
const LEVEL_IDS = ["order", "refund", "receptionist", "list"];

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
    this.intentionalClose = false; // set during teardown so we don't warn
    this.onAuthLost = null; // set by main.js: called when the gate/player is pulled
    // Wake-word lifecycle hooks (set by main.js). onLobbyReady fires when we're at
    // the Host and OFFLINE (so the page can listen for "connect"); onConnecting
    // fires the instant we start connecting (so the wake listener releases the mic
    // to Deepgram). onFinishByVoice ends this player's session ("next player").
    this.onLobbyReady = null;
    this.onConnecting = null;
    this.onFinishByVoice = null;
    // Which heists are enabled at this event, plus this session's results.
    this.available = [...LEVEL_IDS];
    this.results = {};
    this.codename = null; // this player's public leaderboard codename
    this.listening = false; // mic hot for the player's turn — gates in-call SFX
    this.bankedScore = 0; // total from completed heists today (persistent arcade score)
    this.heistScore = 0; // current heist's live score (shown on top of bankedScore)
    this.currentHint = null; // active heist's hint, popped after an off-track turn
    this.heistEnded = false; // closing-line phase: gate the mic so the verdict line isn't barged
    this.resultOpen = false; // result overlay up: mic open for "go back", but the gatekeeper is kept silent
    this.paused = false; // "stop" pause: mic muted AND the agent kept silent until Unmute
  }

  // Mint a Deepgram token, carrying the auth cookies. A 401 means the gate or
  // player session was pulled — surface it so we can return to sign-in.
  fetchToken() {
    return fetch(TOKEN_ENDPOINT, { credentials: "include" }).then((r) => {
      if (!r.ok) {
        if (r.status === 401 && this.onAuthLost) this.onAuthLost();
        throw new Error(`token request failed (${r.status})`);
      }
      return r.text();
    });
  }

  // Tear everything down between players (booth loop) or on revoked access:
  // close the Deepgram session, mic, and brain WS, and reset session state.
  teardown() {
    this.intentionalClose = true;
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
    clearTimeout(this.closingTimer);
    ui.setConnected(false);
    ui.setPhase("lobby");
    ui.hideTurn();
    ui.hideHint();
    this.bankedScore = 0;
    this.heistScore = 0;
    ui.setTotalScore(0);
    this.intentionalClose = false;
  }

  // Per-card status from event availability + this session's results.
  computeStatus() {
    const map = {};
    for (const id of LEVEL_IDS) {
      if (!this.available.includes(id)) map[id] = "unavailable";
      else if (this.results[id] === "win") map[id] = "win";
      else if (this.results[id] === "lose") map[id] = "lose";
      else map[id] = "open";
    }
    return map;
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
    this.brain = new WebSocket(BRAIN_WS);
    this.brain.addEventListener("message", (ev) => {
      let directive;
      try {
        directive = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.applyDirective(directive);
    });
    this.brain.addEventListener("close", (ev) => {
      if (this.intentionalClose) return; // teardown / return-to-login
      if (ev.code === 4401) {
        // The brain refused the upgrade: gate or player session is invalid.
        if (this.onAuthLost) this.onAuthLost();
        return;
      }
      ui.addSystemNote("Lost connection to the game brain.");
    });
    this.brain.addEventListener("error", () => {
      ui.setStatus("Game brain unavailable. Is the Python server running?");
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
        this.codename = d.ui?.player?.codename || null;
        this.bankedScore = d.ui?.playerScore || 0;
        this.heistScore = 0;
        ui.setTotalScore(this.bankedScore);
        ui.renderHeists(this.computeStatus());
        ui.setAgentName(d.ui?.agentName || "The Host");
        ui.setPhase("lobby");
        ui.setConnected(false);
        ui.setControls({ connect: { label: "Connect & Talk", disabled: false }, finish: true });
        {
          const who = d.ui?.player?.handle;
          ui.setStatus(who
            ? `Welcome, ${who}. Talk your way past the AI gatekeepers — connect to begin.`
            : "Talk your way past the AI gatekeepers. Connect to begin.");
        }
        // Config is ready and we're offline at the Host: arm the wake word so the
        // player can just say "connect" (no tap needed).
        if (this.onLobbyReady) this.onLobbyReady();
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
        ui.setHeistStatus(this.computeStatus());
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
        ui.setHeistStatus(this.computeStatus());
        ui.hideTurn();
        ui.hideCue();
        ui.hideHint();
        ui.setPhase("lobby");
        ui.setAgentName(d.ui.agentName);
        ui.setStatus("Back with the Host. Pick your next heist.");
        ui.setControls({ lobby: false });
        await this.swapPersona(d.prompt, d.voice, d.line, d.fnId, d.fnName);
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
    // The gentle themed cue (e.g. "Honesty is the best policy."), popped
    // lower-right after an off-track turn — softer than the explicit hint.
    this.currentHint = d.ui.cue || null;
    ui.hideHint();
    this.heistScore = 0;
    ui.setTotalScore(this.bankedScore);
    if (intro) {
      // Briefing step: no turns yet, just the heist brief and the Briefer.
      ui.hideTurn();
      ui.setStatus(`${d.ui.agentName} is briefing you on ${d.ui.title}.`);
    } else {
      ui.showCue(d.ui.cue);
      ui.setStatus(`${d.ui.agentName} is on the line. You get ${d.ui.maxTurns} turns.`);
      ui.setTurn(0, d.ui.maxTurns);
    }
    ui.setControls({ lobby: true });
    if (d.fnId) {
      // Voice path: swap persona in-session and deliver the opening line via the fn response.
      await this.swapPersona(d.prompt, d.voice, d.openingLine, d.fnId, d.fnName);
    } else {
      // Fresh session (card tap, or the deferred gatekeeper start) so the greeting plays.
      await this.reconnectAgent(d.agent);
    }
  }

  // ---- Deepgram session ----------------------------------------------------
  async connect() {
    if (!this.config) {
      ui.setStatus("Still loading game config from the brain...");
      return;
    }
    // Stop the wake-word listener BEFORE opening the Deepgram mic, so the two
    // never contend for the microphone.
    if (this.onConnecting) this.onConnecting();
    ui.setControls({ connect: { label: "Connecting...", disabled: true } });
    ui.setStatus("Connecting to the Host...");

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
      ui.setStatus(`Could not connect: ${err.message || err}`);
      ui.setControls({ connect: { label: "Retry connect", disabled: false } });
    }
  }

  wireSessionEvents() {
    const s = this.session;

    s.on("audio", (chunk) => this.player.queue(chunk));
    s.on("user-started-speaking", () => {
      this.listening = true;
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
      // On the result overlay, a spoken "go back to the host / done / next" dismisses
      // it to the lobby (same as the button). Not a heist turn.
      if (this.resultOpen) {
        if (isReturnCommand(msg.content)) ui.dismissResult();
        return;
      }
      // Voice navigation (everything except mute): "back to the host" mid-heist,
      // "next player" at the Host. Handled here so it doesn't count as a turn.
      if (this.handleVoiceCommand(msg.content)) return;
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
      if (this.pendingStart) {
        // The Briefer said "Good luck!" — wait for that audio to finish PLAYING
        // before tearing down for the gatekeeper, or it gets cut.
        const start = this.pendingStart;
        this.pendingStart = null;
        this.afterPlayback(() => this.applyHandoff(start));
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
      ui.setStatus(`Disconnected: ${reason || "connection closed"}`);
      ui.setControls({ connect: { label: "Reconnect", disabled: false }, mute: false, lobby: false });
    });
    // Deepgram agent-pipeline errors (e.g. a transient "failed to think" or an
    // input-timeout while a fresh handoff session warms up) are usually momentary
    // and self-heal, so don't spray scary "AGENT ERROR" lines into the player's
    // transcript — log them for debugging instead. A real connection loss still
    // surfaces via "disconnected".
    s.on("error", (m) => console.warn("[agent error]", m?.description || m));
    s.on("sdk-error", (e) => console.warn("[sdk error]", e?.message || e));
  }

  // Swap persona (prompt) + voice mid-session, then speak the opening/return line.
  // We wait for BOTH the voice and prompt updates to apply first, otherwise the
  // line can play in the outgoing agent's voice or persona.
  //
  // When there's a pending function call (fnId), we deliver the opening line *as*
  // the function response ("say exactly this") instead of injecting it separately.
  // That gives the new persona a single, exact opening line - if we both injected
  // AND let the resumed agent greet, we'd get duplicate greetings.
  async swapPersona(prompt, voice, line, fnId, fnName) {
    this.session.updateSpeak({ provider: { type: "deepgram", model: voice } });
    this.session.updatePrompt(prompt);
    await Promise.all([
      this.waitFor("speak-updated", 2500),
      this.waitFor("prompt-updated", 2500),
    ]);
    if (fnId) {
      this.session.sendFunctionCallResponse(
        fnId,
        fnName,
        JSON.stringify({ instruction: `Say exactly this to the player, word for word, and nothing else: "${line}"` })
      );
    } else if (line) {
      this.injectAgentLine(line);
    }
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
    } catch (err) {
      console.error(err);
      ui.setStatus(`Could not start the heist: ${err.message || err}`);
    } finally {
      this.reconnecting = false;
    }
  }

  // Inject an agent line, retrying if the server refuses it. A refusal happens
  // when an agent turn is still in progress - e.g. right after a barge-in, while
  // the interrupted Host's turn is still finishing on the server.
  injectAgentLine(line) {
    let attempts = 0;
    const maxAttempts = 8;
    const onRefused = () => {
      if (attempts >= maxAttempts) {
        this.session.off("injection-refused", onRefused);
        return;
      }
      setTimeout(tryInject, 300); // wait for the current turn to wind down, retry
    };
    const tryInject = () => {
      attempts += 1;
      this.session.injectAgentMessage(line);
    };
    this.session.on("injection-refused", onRefused);
    tryInject();
    // Stop listening once the line is safely playing or we've given up.
    this.waitFor("agent-started-speaking", 4000).then(() =>
      this.session.off("injection-refused", onRefused)
    );
  }

  waitFor(event, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.session.off(event, finish);
        resolve();
      };
      this.session.on(event, finish);
      setTimeout(finish, timeoutMs);
    });
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
    // Bank this heist's score into the persistent arcade total.
    this.bankedScore += d.score || 0;
    this.heistScore = 0;
    ui.setTotalScore(this.bankedScore);
    ui.hideTurn();
    ui.hideCue();
    ui.hideHint();
    if (d.outcome === "win") sfx.win();
    else sfx.bust();
    await ui.showResult({
      outcome: d.outcome,
      title: d.title,
      path: d.path,
      reason: d.reason,
      hint: d.hint,
      score: d.score,
      codename: this.codename,
    });
    // Tell the brain we're done; it sends us back to the lobby host.
    this.sendBrain({ type: "result_ack" });
  }

  // ---- controls ------------------------------------------------------------
  toggleMute() {
    if (!this.mic) return;
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
  // returns to the offline lobby with the "Connect & Talk" button (and the wake
  // word re-armed for "connect"). Reconnecting resumes right where they left off.
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
      connect: { label: "Connect & Talk", disabled: false },
      mute: false,
      muted: false,
      lobby: false,
    });
    ui.setStatus("Stopped. Say “Connect” or tap to talk again.");
    if (this.onLobbyReady) this.onLobbyReady(); // re-arm the "connect" wake word
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
  // gatekeeper greets cleanly (see reconnectAgent).
  chooseHeist(game) {
    if (this.connected && !this.inLevel && !this.inIntro && this.computeStatus()[game] === "open") {
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
// Loose on purpose — accepts natural variations: "go back", "go back to host",
// "go back to the host", "take me back", "next one", "I'm done", "lobby", etc.
function isReturnCommand(text) {
  return /\b(back|host|lobby|next|another|done|continue|finished?|leave|exit|menu|restart|go on|move on)\b/i.test(text || "");
}

// Mid-heist, does the player want to abandon and return to the Host? Anchored on
// "host"/"lobby"/"menu" — words you'd never say to a bouncer/pizza/refund agent —
// so persuasion lines ("just let me in", "leave it to me") don't trip it.
function isBackToHost(text) {
  return /\b(host|lobby|menu)\b/i.test(text || "");
}

// At the Host, does the player (or booth staff) want to hand off to the next
// player? Specific phrases only, so it can't fire from ordinary "which heist"
// chatter. Mirrors the "Finish · next player" button.
function isFinishCommand(text) {
  const t = text || "";
  return (
    /\b(next|new)\s+(player|person|visitor|turn|one)\b/i.test(t) ||
    /\bfinish(ed)?\b/i.test(t) ||
    /\b(i'?m|i am|we'?re|we are)\s+(all\s+)?done\b/i.test(t) ||
    /\bend\s+(my|the|this)\s+(session|game|turn)\b/i.test(t)
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
