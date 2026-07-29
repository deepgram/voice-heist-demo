// Client-side auth flow for Voice Heist (booth-kiosk model).
//
// The booth lands STRAIGHT in the game: ensureAuthed() silently mints an
// anonymous session, so nobody ever meets a form. Sign-in is OPTIONAL and
// in-page — the topbar "Sign in" button (and the result card's claim form)
// put a name on the leaderboard. Quick play promotes the current anonymous
// session in place via /api/auth/claim, so scores already earned today follow
// the handle onto the board; a guest code switches to that registered
// identity; Deepgram folks can use their account (full-page OIDC).
//
// This module only drives the sign-in overlay and the /api/auth/* calls.
// game.js owns the Deepgram/brain connection; main.js wires the two together.

const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");

async function postJSON(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body || {}),
  });
  return r;
}

export async function getState() {
  try {
    return await fetch("/api/auth/state", { credentials: "include" }).then((r) => r.json());
  } catch {
    return { player: null, oidc: false };
  }
}

// Silently ensure a player session exists — anonymous by default, no UI.
// Loops with a delay on failure: a booth must recover from a server blip on
// its own, and there is nothing a passerby could do about it anyway.
export async function ensureAuthed({ onRetry } = {}) {
  for (;;) {
    const s = await getState();
    if (s.player) return s.player;
    try {
      const r = await postJSON("/api/auth/signin", { tier: "anon" });
      if (r.ok) return (await r.json()).player;
    } catch {
      /* fall through to retry */
    }
    try {
      onRetry?.();
    } catch {
      /* ignore UI callback errors */
    }
    await new Promise((res) => setTimeout(res, 4000));
  }
}

// End the current player session (booth handoff). The caller mints the next
// anonymous session via ensureAuthed() — no overlay for the next visitor.
export async function endSession() {
  try {
    await postJSON("/api/auth/end");
  } catch {
    /* cookie may already be gone — fine */
  }
}

// A bounced non-Deepgram OIDC sign-in lands on /game?denied=1. Consume the
// flag (clean the URL so a reload doesn't re-trigger) and tell the caller to
// reopen the sign-in card with an explanation.
export function consumeDeniedFlag() {
  if (!new URLSearchParams(location.search).get("denied")) return false;
  history.replaceState(null, "", location.pathname);
  return true;
}

let _signinOpen = false;

// Show the OPTIONAL sign-in card. Resolves with the signed-in player, or null
// when the visitor closes it (X / backdrop / "No thanks — just play").
export async function openSignIn({ error = "" } = {}) {
  if (_signinOpen) return null;
  _signinOpen = true;
  const overlay = $("loginOverlay");
  const errorEl = $("loginError");
  const dgBtn = $("deepgramSigninBtn");
  const state = await getState();
  if (dgBtn) dgBtn.hidden = !state.oidc; // no Deepgram sign-in if OIDC isn't configured
  errorEl.textContent = error;
  show(overlay);
  $("quickInput").focus();
  return new Promise((resolve) => {
    const finish = (player) => {
      cleanup();
      ["codeInput", "quickInput", "quickEmail"].forEach((i) => ($(i).value = ""));
      errorEl.textContent = "";
      hide(overlay);
      _signinOpen = false;
      resolve(player);
    };
    const showError = (status) => {
      errorEl.textContent =
        status === 404 ? "We don't recognize that code. Check it, or just grab a handle."
        : status === 400 ? "That email doesn't look right — fix it, or leave it blank."
        : status === 429 ? "Too many tries. Wait a moment."
        : "Couldn't sign you in. Try again.";
    };
    const onQuick = async (e) => {
      e.preventDefault();
      errorEl.textContent = "";
      const handle = $("quickInput").value.trim();
      const email = $("quickEmail").value.trim();
      if (!handle) {
        errorEl.textContent = "Pick a handle first.";
        return;
      }
      // Promote the current anonymous session in place (keeps today's scores);
      // fall back to a fresh quick session if this one isn't promotable.
      let r = null;
      if (state.player?.tier === "anon") {
        r = await postJSON("/api/auth/claim", { handle, email: email || undefined });
        if (r.status === 409 || r.status === 401 || r.status === 404) r = null;
      }
      if (!r) r = await postJSON("/api/auth/signin", { tier: "quick", handle, email });
      if (r.ok) finish((await r.json()).player);
      else showError(r.status);
    };
    const onCode = async (e) => {
      e.preventDefault();
      errorEl.textContent = "";
      const r = await postJSON("/api/auth/signin", { tier: "code", code: $("codeInput").value.trim() });
      if (r.ok) finish((await r.json()).player);
      else showError(r.status);
    };
    const onClose = () => finish(null);
    const onBackdrop = (e) => {
      if (e.target === overlay) finish(null);
    };
    const cleanup = () => {
      $("quickForm").removeEventListener("submit", onQuick);
      $("codeForm").removeEventListener("submit", onCode);
      $("authClose").removeEventListener("click", onClose);
      $("justPlayBtn").removeEventListener("click", onClose);
      overlay.removeEventListener("click", onBackdrop);
    };
    $("quickForm").addEventListener("submit", onQuick);
    $("codeForm").addEventListener("submit", onCode);
    $("authClose").addEventListener("click", onClose);
    $("justPlayBtn").addEventListener("click", onClose);
    overlay.addEventListener("click", onBackdrop);
  });
}

// Poll periodically; call onRevoked() once if the player session expires.
// Returns stop().
export function startAuthPoll(onRevoked, intervalMs = 45000) {
  let fired = false;
  const id = setInterval(async () => {
    const s = await getState();
    if (!s.player && !fired) {
      fired = true;
      clearInterval(id);
      onRevoked(s);
    }
  }, intervalMs);
  return () => clearInterval(id);
}
