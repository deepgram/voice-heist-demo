// Self-hosted fonts (no CDN: the arcade identity must survive conference Wi-Fi).
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/fira-code/500.css";
import "@fontsource/fira-code/600.css";
import "@fontsource/noto-sans/500.css";
import "@fontsource/noto-sans/600.css";
import "@fontsource/noto-sans/700.css";
import "@fontsource/orbitron/600.css";
import "@fontsource/orbitron/700.css";
import "@fontsource/orbitron/800.css";
import "@fontsource/orbitron/900.css";
import "@deepgram/styles"; // Deepgram design system: tokens, base, components
import "./styles.css"; // our layout, imported after so it can layer on top
import { Game } from "./game.js";
import * as ui from "./ui.js";
import * as auth from "./auth.js";

const game = new Game();

ui.setPhase("lobby");
ui.renderHeists({});
ui.setConnected(false);
ui.startOrb(
  () => game.orbMode(),
  () => game.orbInput(),
  () => game.orbOutput()
);
ui.setControls({ connect: { label: "Connecting…", disabled: true }, muted: false });

let stopPoll = null;

// Open the control channel to the brain (carries the auth cookies) and start
// the access poll. Called after every sign-in so each player gets a fresh session.
function startSession() {
  ui.setStatus("Loading game…");
  game.connectBrain();
  if (stopPoll) stopPoll();
  stopPoll = auth.startAuthPoll(handleAuthLost);
}

// Access was pulled (player session expired): tear down and silently start a
// fresh anonymous session — the game never shows a form uninvited.
async function handleAuthLost() {
  if (stopPoll) { stopPoll(); stopPoll = null; }
  game.teardown();
  ui.setStatus("Session expired — starting a fresh one…");
  await auth.ensureAuthed({ onRetry: () => ui.setStatus("Can’t reach the game — retrying…") });
  startSession();
}
game.onAuthLost = handleAuthLost;

// "I'm done" / "start over" by voice ends the session, same as the End session button.
game.onFinishByVoice = () => startOver();

// End this session and start a fresh anonymous one — the explicit escape hatch
// (topbar "Start over" / "End session" in the dock / "I'm done" by voice).
// Never fires on its own: on the web an idle tab keeps its identity.
async function startOver() {
  // Destructive for anyone with something to lose (an unclaimed score, or a
  // signed-in identity that would be signed out) — confirm first.
  const boarded = game.playerTier && !["anon", "test"].includes(game.playerTier);
  if ((game.bankedScore > 0 || boarded) &&
      !window.confirm("Start over? This ends your session — an unclaimed score is gone for good.")) {
    return;
  }
  if (stopPoll) { stopPoll(); stopPoll = null; }
  game.teardown();
  await auth.endSession();
  await auth.ensureAuthed({ onRetry: () => ui.setStatus("Can’t reach the game — retrying…") });
  startSession();
}

// Optional sign-in (topbar button / OIDC bounce). On success the identity
// changed — promoted in place or switched to a code — so restart the brain
// session: its init restores standings, codename, and banked score under the
// new identity.
async function openSignInFlow(opts = {}) {
  const player = await auth.openSignIn(opts);
  if (player) {
    if (stopPoll) { stopPoll(); stopPoll = null; }
    game.teardown();
    startSession();
  }
}

ui.onConnect(() => {
  if (!game.connected) game.connect();
});
ui.onMute(() => game.toggleMute());
ui.onLobby(() => game.requestLobby());
ui.onHeist((id) => game.chooseHeist(id));
ui.onFinish(() => startOver());
ui.onNewPlayer(() => startOver());
ui.onSignIn(() => openSignInFlow());
ui.initHowTo();

// Land straight in the game: silent anonymous session, no gate.
(async function boot() {
  await auth.ensureAuthed({ onRetry: () => ui.setStatus("Can’t reach the game — retrying…") });
  startSession();
  // A bounced non-Deepgram OIDC attempt: reopen the card and explain.
  if (auth.consumeDeniedFlag()) {
    openSignInFlow({ error: "That isn't a Deepgram account — but anyone can play. Grab a handle or a code instead." });
  }
})();
