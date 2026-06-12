// Tiny synthesized arcade SFX — no audio files. A shared AudioContext is created
// lazily on the first call, which always follows a user gesture (connect / tap),
// satisfying browser autoplay policy. game.js triggers these only at safe
// moments and gates the in-call score blip while the mic is hot, so sound can't
// leak into the voice session.

let ctx = null;
let master = null;
let enabled = true;

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.18; // keep it gentle for a booth
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export function setEnabled(on) {
  enabled = !!on;
}

// One enveloped tone: wave type, start/end freq, duration, delay, peak gain.
function beep(type, f0, f1, dur, delay = 0, gain = 1) {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t0);
  if (f1 && f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

const armed = () => enabled && !!ac();

// Coin-in on connect: classic two-note arcade blip.
export function coin() {
  if (!armed()) return;
  beep("square", 988, 988, 0.08, 0, 0.9);
  beep("square", 1319, 1319, 0.18, 0.08, 0.9);
}

// Score tick: short blip; a warm (500) turn is brighter/higher than a weak one.
export function blip(label = "weak") {
  if (!armed()) return;
  if (label === "warm") beep("square", 880, 1320, 0.16, 0, 0.8);
  else beep("triangle", 520, 660, 0.09, 0, 0.55);
}

// Win fanfare: rising arpeggio with a topping note.
export function win() {
  if (!armed()) return;
  const notes = [523, 659, 784, 1047]; // C E G C
  notes.forEach((f, i) => beep("square", f, f, 0.16, i * 0.11, 0.85));
  beep("square", 1568, 1568, 0.3, notes.length * 0.11, 0.7);
}

// Bust: descending "wah-wah" buzzer (good-natured, not harsh).
export function bust() {
  if (!armed()) return;
  beep("sawtooth", 300, 150, 0.25, 0, 0.5);
  beep("sawtooth", 240, 110, 0.35, 0.18, 0.5);
}

// Heist selected: soft confirm.
export function select() {
  if (!armed()) return;
  beep("square", 660, 990, 0.1, 0, 0.6);
}
