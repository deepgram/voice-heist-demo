// Optional, self-service player identity for the demo (lobby UI).
//
// The booth build had device gating, OAuth, and an admin portal. The public demo
// keeps none of that. Instead: sign up with first/last name + email to get a short
// code and a public codename ("Crimson Fox 42"), or sign in with your email OR that
// code to bring your standings back. Identity is OPTIONAL — enter nothing and you
// still play immediately as a fresh anonymous player.
//
// Name/email are stored server-side only to identify a returning player; the public
// leaderboard shows the codename, never PII. The server sets an HttpOnly `vh_player`
// cookie, so after any change we reload the session (onChange) to let the brain
// re-read it. See brain/auth.py.

import "./identity.css";

const $ = (id) => document.getElementById(id);

async function api(path, body) {
  try {
    const res = await fetch(path, {
      method: "POST",
      credentials: "include",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: {} };
  }
}

async function fetchMe() {
  try {
    const res = await fetch("/api/auth/me", { credentials: "include" });
    return res.ok ? (await res.json()).player || null : null;
  } catch {
    return null;
  }
}

// Wire up the lobby identity bar. `onChange` is called after sign-up/in/out so the
// caller can re-open the brain session and pick up (or drop) the cookie.
export function initIdentity({ onChange } = {}) {
  const bar = $("identityBar");
  if (!bar) return;
  let player = null; // { code, codename } when signed in
  let busy = false;
  const reload = () => onChange && onChange();

  function render(opts = {}) {
    bar.hidden = false;
    if (player) {
      bar.innerHTML = `
        <div class="identity-in">
          <span class="identity-who">You're <b>${esc(player.codename)}</b>
            <span class="identity-code">&middot; code <b>${esc(player.code)}</b></span></span>
          <button id="idOut" class="identity-link" type="button">Sign out</button>
        </div>
        ${opts.fresh ? `<p class="identity-note">Write down your code &mdash; or just use your email &mdash; to pick up where you left off.</p>` : ``}`;
      $("idOut").onclick = onSignout;
      return;
    }
    bar.innerHTML = `
      <details class="identity-acc">
        <summary>Keep your standings on the leaderboard?</summary>
        <form id="idSignup" class="identity-form" novalidate>
          <input id="idFirst" class="identity-input" type="text" autocomplete="given-name" placeholder="First name" aria-label="First name" />
          <input id="idLast" class="identity-input" type="text" autocomplete="family-name" placeholder="Last name" aria-label="Last name" />
          <input id="idEmail" class="identity-input identity-input--wide" type="email" autocomplete="email" placeholder="Email" aria-label="Email" />
          <button class="dg-btn dg-btn--primary identity-btn" type="submit">Sign up</button>
        </form>
        <div class="identity-signin">
          <span>Already played?</span>
          <form id="idSignin" class="identity-form" novalidate>
            <input id="idLogin" class="identity-input identity-input--wide" type="text" autocomplete="off" spellcheck="false" placeholder="Email or code" aria-label="Email or code" />
            <button class="dg-btn dg-btn--ghost identity-btn" type="submit">Sign in</button>
          </form>
        </div>
        <p class="identity-note">Stored only to identify you across visits. The public board shows your codename, never your name or email.</p>
        <p id="idMsg" class="identity-msg" aria-live="polite"></p>
      </details>`;
    $("idSignup").onsubmit = onSignup;
    $("idSignin").onsubmit = onSignin;
  }

  function msg(text, isErr) {
    const m = $("idMsg");
    if (m) {
      m.textContent = text || "";
      m.classList.toggle("is-error", !!isErr);
    }
  }

  async function onSignup(e) {
    e.preventDefault();
    if (busy) return;
    const first = $("idFirst").value.trim();
    const last = $("idLast").value.trim();
    const email = $("idEmail").value.trim();
    if (!email || !(first || last)) {
      msg("A name and email are required.", true);
      return;
    }
    busy = true;
    msg("Signing up…");
    const r = await api("/api/auth/register", { first_name: first, last_name: last, email });
    busy = false;
    if (r.ok && r.data.player) {
      player = r.data.player;
      render({ fresh: true });
      reload();
    } else {
      msg(errText(r, "Couldn't sign up. Check your details and try again."), true);
    }
  }

  async function onSignin(e) {
    e.preventDefault();
    if (busy) return;
    const login = $("idLogin").value.trim();
    if (!login) return;
    busy = true;
    msg("Signing in…");
    const r = await api("/api/auth/signin", { login });
    busy = false;
    if (r.ok && r.data.player) {
      player = r.data.player;
      render();
      reload();
    } else if (r.status === 404) {
      msg("No match for that email or code.", true);
    } else {
      msg(errText(r, "Sign-in failed. Try again."), true);
    }
  }

  async function onSignout() {
    if (busy) return;
    busy = true;
    await api("/api/auth/signout");
    busy = false;
    player = null;
    render();
    reload();
  }

  // Reflect any existing signed-in session on load.
  fetchMe().then((p) => {
    player = p;
    render();
  });
}

function errText(r, fallback) {
  if (r.status === 429) return "Too many tries — give it a few seconds.";
  return r.data && r.data.error ? cap(r.data.error) : fallback;
}
function cap(s) {
  s = String(s || "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
