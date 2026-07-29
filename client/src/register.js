// Phone registration page. Runs on the attendee's own device (reached via the
// booth QR), NOT on the shared kiosk. Two ways to register:
//   1. OAuth: "Sign in" -> /api/auth/oidc/start -> provider login -> callback -> reg cookie.
//   2. Manual: first/last/email -> POST /api/auth/register (unverified) -> reg result.
// Either path ends on the "done" view showing the player code + codename. The manual
// form works even when OAuth isn't configured.

const $ = (id) => document.getElementById(id);
const show = (id) => { $(id).hidden = false; };

async function getJSON(url) {
  try {
    return await fetch(url, { credentials: "include" }).then((r) => r.json());
  } catch {
    return {};
  }
}

function showDone(reg) {
  if (!reg || !reg.code) return;
  $("code").textContent = reg.code;
  if (reg.codename) {
    $("codename").textContent = reg.codename;
    $("codenameLine").hidden = false;
  }
  $("loading").hidden = true;
  $("signin").hidden = true;
  show("done");
}

function wireManualForm() {
  const form = $("manualForm");
  if (!form) return;
  const err = $("manualError");
  const btn = form.querySelector("button");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    btn.disabled = true;
    try {
      const r = await fetch("/api/auth/register", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          first_name: $("firstName").value.trim(),
          last_name: $("lastName").value.trim(),
          email: $("email").value.trim(),
        }),
      });
      if (r.ok) {
        showDone((await r.json()).registration);
        return;
      }
      err.textContent = r.status === 429
        ? "Too many tries — wait a moment and try again."
        : "Please enter your name and a valid email.";
      err.hidden = false;
    } catch {
      err.textContent = "Something went wrong. Please try again.";
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
}

async function init() {
  const me = await getJSON("/api/auth/me");
  if (me.registration && me.registration.code) {
    return showDone(me.registration);
  }
  const state = await getJSON("/api/auth/state");
  $("loading").hidden = true;
  // The manual form always works; show the OAuth button only when it's configured.
  if (!state.oidc) {
    $("signinBtn").hidden = true;
    $("oauthOr").hidden = true;
  }
  show("signin");
  wireManualForm();
}

init();
