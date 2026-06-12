import "@deepgram/styles"; // Deepgram design system: tokens, base, components
import "./styles.css"; // our layout, imported after so it can layer on top
import { Game } from "./game.js";
import * as ui from "./ui.js";
import { createWakeListener } from "./voice.js";

const game = new Game();

// Pre-connect wake word: while offline at the Host, listen for "connect" and
// connect hands-free (same as tapping "Connect & Talk"). It releases the mic the
// instant we start connecting, so it never fights the Deepgram microphone. On
// browsers without speech recognition this is a no-op and the button still works.
const wake = createWakeListener({
  onWake: () => { if (!game.connected) game.connect(); },
  onListeningChange: (on) => ui.setWakeListening(on),
});

ui.setPhase("lobby");
ui.renderHeists({});
ui.setConnected(false);
ui.startOrb(
  () => game.orbMode(),
  () => game.orbInput(),
  () => game.orbOutput()
);
ui.setControls({ connect: { label: "Connecting…", disabled: true }, muted: false });

// Open the control channel to the brain. The demo has no auth, so the brain just
// starts a fresh anonymous session for this connection.
function startSession() {
  ui.setStatus("Loading game…");
  game.connectBrain();
}

// "New player" / "Finish": end this session and start a fresh one (new anonymous
// player), so the kiosk can be handed to the next person.
function finishForNextPlayer() {
  wake.stop();
  game.teardown();
  startSession();
}

// No auth in the demo, so there's no gate/session to lose.
game.onAuthLost = null;
game.onLobbyReady = () => wake.start();
game.onConnecting = () => wake.stop();
game.onFinishByVoice = () => finishForNextPlayer();

ui.onConnect(() => { if (!game.connected) game.connect(); });
ui.onMute(() => game.toggleMute());
ui.onLobby(() => game.requestLobby());
ui.onHeist((id) => game.chooseHeist(id));
ui.onFinish(() => finishForNextPlayer());
ui.onNewPlayer(() => finishForNextPlayer());
ui.initHowTo();

// Start straight into the game — no sign-in.
startSession();
