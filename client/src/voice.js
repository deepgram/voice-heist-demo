// voice.js — the pre-connect wake word.
//
// The Deepgram agent owns the mic, but only once the player has "connected".
// Before that the lobby is silent, so saying "connect" can't do anything. This
// module fills that gap: while the player is OFFLINE it runs the browser's local
// speech recognizer, listening for a short wake phrase ("connect", "start",
// "let's go", …). On a match it fires onWake() — which connects the agent,
// exactly like tapping "Connect & Talk" — and immediately stops, so it never
// competes with the Deepgram microphone.
//
// This is the ONLY place a non-Deepgram recognizer is used, and only for a single
// trigger word; the conversation itself is 100% Deepgram. Browsers without
// webkitSpeechRecognition (e.g. Firefox) fall back silently to the button —
// createWakeListener() returns no-op start/stop and supported:false.

const SpeechRecognition =
  typeof window !== "undefined" &&
  (window.SpeechRecognition || window.webkitSpeechRecognition);

// Wake phrases. Anchored on "connect" (the prompt the UI shows), with a few
// natural variants. Matched loosely against interim transcripts, so "ok connect",
// "let's connect", "connect and talk" all hit. Kept tight enough that ordinary
// booth chatter won't trip it.
const WAKE_RE =
  /\b(connect|start|begin|let'?s (go|play|start|do this)|i'?m ready|ready to play)\b/i;

export function isSupported() {
  return !!SpeechRecognition;
}

// Create a wake-word listener.
//   onWake()                 -> fired once per detection (debounced) while armed
//   onListeningChange(bool)  -> optional: drives the "listening" UI affordance
// Returns { start, stop, supported }. start()/stop() are idempotent.
export function createWakeListener({ onWake, onListeningChange } = {}) {
  if (!SpeechRecognition) {
    return { start() {}, stop() {}, supported: false };
  }

  let rec = null;
  let armed = false; // we WANT to be listening
  let running = false; // the recognizer is actually running
  let lastFire = 0;

  const setListening = (v) => {
    try {
      onListeningChange?.(v);
    } catch {
      /* ignore UI callback errors */
    }
  };

  function makeRec() {
    const r = new SpeechRecognition();
    r.lang = "en-US";
    r.continuous = true; // keep listening across pauses
    r.interimResults = true; // react fast, before the final result lands
    r.maxAlternatives = 1;
    r.onstart = () => {
      running = true;
      setListening(true);
    };
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const transcript = e.results[i][0]?.transcript || "";
        if (WAKE_RE.test(transcript)) {
          fire();
          return;
        }
      }
    };
    r.onerror = (ev) => {
      // "no-speech" / "aborted" / "network" are routine and self-heal via onend.
      // "not-allowed" means the mic was denied — give up (the button still works).
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        armed = false;
        setListening(false);
      }
    };
    r.onend = () => {
      running = false;
      // The recognizer stops itself after silence; if we still want it, restart
      // (small delay guards against a tight error→end loop).
      if (armed) {
        setTimeout(() => {
          if (armed && !running) safeStart();
        }, 250);
      } else {
        setListening(false);
      }
    };
    return r;
  }

  function safeStart() {
    if (!rec) rec = makeRec();
    try {
      rec.start();
    } catch {
      /* "already started" throws — harmless */
    }
  }

  function fire() {
    const now = Date.now();
    if (now - lastFire < 1500) return; // debounce repeat hits from interim results
    lastFire = now;
    stop(); // hand the mic to Deepgram cleanly before connecting
    try {
      onWake?.();
    } catch (e) {
      console.warn("[wake] onWake failed", e);
    }
  }

  function start() {
    if (armed) return;
    armed = true;
    safeStart();
  }

  function stop() {
    armed = false;
    if (rec) {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    }
    running = false;
    setListening(false);
  }

  return { start, stop, supported: true };
}
