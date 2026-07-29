"""Authentication for Voice Heist.

One layer, an itsdangerous-signed HttpOnly cookie:
  - vh_player : one player session. Carries {pid, handle, tier, code} so plays
                are attributable. Cleared between players (booth-kiosk model).

Sign-in (open to everyone — no booth unlock / employee gate):
  - /api/auth/signin : quick play (handle only) or a returning guest code.
  - /api/auth/oidc/* : optional verified sign-in (Auth0). dest=game signs a
                       Deepgram account straight in; dest=register mints a code.

Anyone can play; identity (a handle, a guest code, or a Deepgram account) exists
only so plays are attributable. Config is read from the env (Fly secrets in prod);
provider config is provider-neutral (OIDC_*), so swapping Auth0 → Clerk/Cognito/
Okta is configuration, not a rewrite.
"""

from __future__ import annotations

import os
import re
import secrets
import time
from datetime import datetime, timedelta
from hashlib import sha256
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

import store

# --- config ---------------------------------------------------------------
def _required_secret(name: str, dev_fallback: str) -> str:
    val = os.environ.get(name)
    if val:
        return val
    # Keep local dev runnable, but make it loud — these MUST be set in prod.
    print(f"[auth] WARNING: {name} is not set; using an insecure dev value. "
          f"Set it as a Fly secret before deploying.")
    return dev_fallback

AUTH_SIGNING_SECRET = _required_secret("AUTH_SIGNING_SECRET", "dev-insecure-" + secrets.token_hex(8))

PLAYER_TOKEN_TTL = int(os.environ.get("PLAYER_TOKEN_TTL", str(2 * 3600)))
_OIDC_TX_TTL = 600
_REG_RESULT_TTL = 600
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "").lower() in ("1", "true", "yes")
EVENT_TZ = os.environ.get("EVENT_TZ", "America/Los_Angeles")
# Booth "Sign in with Deepgram" is gated to verified emails on this domain (same
# default as the admin portal, so both stay in sync).
DEEPGRAM_EMAIL_DOMAIN = os.environ.get(
    "BOOTH_EMAIL_DOMAIN", os.environ.get("ADMIN_EMAIL_DOMAIN", "deepgram.com")
).lower()

PLAYER_COOKIE = "vh_player"
_TX_COOKIE = "vh_oidc_tx"
_REG_COOKIE = "vh_reg"
# Durable device identity (open-web integrity). Player sessions are disposable
# by design ("Start over" mints a fresh anonymous pid), so the one-play-per-day
# rule anchors to this long-lived cookie instead: daily locks recorded under any
# pid on this browser survive an identity reset. Deliberately NOT cleared by
# /api/auth/end. Clearing cookies defeats it — this is a bar-raiser against the
# casual grinder, not DRM.
DEVICE_COOKIE = "vh_device"
DEVICE_TTL = int(os.environ.get("DEVICE_TOKEN_TTL", str(7 * 24 * 3600)))

_serializer = URLSafeTimedSerializer(AUTH_SIGNING_SECRET)


def event_day() -> str:
    """Today's date in the event timezone — so 'today' flips at local midnight."""
    return datetime.now(ZoneInfo(EVENT_TZ)).strftime("%Y-%m-%d")


def seconds_to_reset() -> int:
    """Seconds until the daily board resets (next midnight in the event
    timezone) — powers the client's countdown."""
    now = datetime.now(ZoneInfo(EVENT_TZ))
    midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0,
                                                 microsecond=0)
    return max(0, int((midnight - now).total_seconds()))


# --- token sign/verify -----------------------------------------------------
def _sign(salt: str, payload: dict) -> str:
    return _serializer.dumps(payload, salt=salt)


def _unsign(salt: str, token: str | None, max_age: int) -> dict | None:
    if not token:
        return None
    try:
        return _serializer.loads(token, salt=salt, max_age=max_age)
    except (BadSignature, SignatureExpired):
        return None


def make_player_token(player: dict) -> str:
    return _sign("player", {
        "v": 1, "pid": player["pid"], "handle": player.get("handle"),
        "tier": player["tier"], "code": player["code"],
    })


def verify_player(token: str | None) -> dict | None:
    return _unsign("player", token, PLAYER_TOKEN_TTL)


# --- cookies ---------------------------------------------------------------
def _set_cookie(resp: Response, name: str, value: str, max_age: int) -> None:
    resp.set_cookie(
        name, value, max_age=max_age, httponly=True,
        secure=COOKIE_SECURE, samesite="lax", path="/",
    )


def _clear_cookie(resp: Response, name: str) -> None:
    resp.delete_cookie(name, path="/")


# --- rate limiting (in-memory token bucket; resets on restart) -------------
_buckets: dict[str, tuple[float, float]] = {}  # key -> (tokens, last_refill)
# Lenient by default: allow a healthy burst, and refill the bucket quickly so a
# brief lockout clears in seconds, not minutes. Override via env if needed.
_RATE_CAP = float(os.environ.get("AUTH_RATE_BURST", "20"))      # attempts before a 429
_RATE_WINDOW = float(os.environ.get("AUTH_RATE_WINDOW", "30"))  # seconds to fully refill
_RATE_REFILL = _RATE_CAP / _RATE_WINDOW


def _client_ip(request: Request) -> str:
    # Fly puts the real client IP here; fall back to the socket peer.
    return (request.headers.get("fly-client-ip")
            or (request.headers.get("x-forwarded-for", "").split(",")[0].strip())
            or (request.client.host if request.client else "unknown"))


# Prune the bucket map when it gets big: on the open web the IP population is
# unbounded, and a bucket idle for its whole window has fully refilled — absent
# and full-idle are indistinguishable, so dropping stale keys is free.
_BUCKET_SWEEP_AT = 10_000
_BUCKET_STALE_S = 3600.0


def rate_limit(key: str, cap: float, window: float) -> bool:
    """Generic per-key token bucket: `cap` attempts, fully refilled over `window`
    seconds. Keys are namespaced by the caller (e.g. "token:1.2.3.4"), so
    different endpoint families can carry different budgets."""
    now = time.monotonic()
    if len(_buckets) >= _BUCKET_SWEEP_AT:
        for k in [k for k, (_, last) in _buckets.items() if now - last > _BUCKET_STALE_S]:
            del _buckets[k]
    tokens, last = _buckets.get(key, (cap, now))
    tokens = min(cap, tokens + (now - last) * (cap / window))
    if tokens < 1.0:
        _buckets[key] = (tokens, now)
        return False
    _buckets[key] = (tokens - 1.0, now)
    return True


def _rate_ok(key: str) -> bool:
    return rate_limit(key, _RATE_CAP, _RATE_WINDOW)


# --- FastAPI dependencies --------------------------------------------------
def require_player(request: Request) -> dict:
    claims = verify_player(request.cookies.get(PLAYER_COOKIE))
    if not claims:
        raise HTTPException(status_code=401, detail="player")
    return claims


def verify_ws(cookies: dict) -> dict | None:
    """For the WS handler: claims iff a player session is valid."""
    return verify_player(cookies.get(PLAYER_COOKIE))


def device_from_cookies(cookies: dict) -> str | None:
    """The durable device id, if this browser carries a valid device cookie."""
    claims = _unsign("device", cookies.get(DEVICE_COOKIE), DEVICE_TTL)
    return claims.get("d") if claims else None


def _ensure_device(request: Request, resp: Response) -> str:
    """Return the request's device id, minting + setting the cookie if absent.
    Re-setting on every call also rolls the 7-day TTL for active devices."""
    did = device_from_cookies(request.cookies) or secrets.token_urlsafe(16)
    _set_cookie(resp, DEVICE_COOKIE, _sign("device", {"d": did}), DEVICE_TTL)
    return did


# --- OIDC identity broker (swappable) --------------------------------------
class Identity:
    def __init__(self, provider, sub, email, email_verified, name):
        self.provider, self.sub = provider, sub
        self.email, self.email_verified, self.name = email, email_verified, name


def is_deepgram(ident: Identity) -> bool:
    """True iff a VERIFIED email on the Deepgram domain — required only for the
    "Sign in with Deepgram" booth button (guests sign in without it)."""
    email = (ident.email or "").lower()
    return bool(ident.email_verified and email.endswith("@" + DEEPGRAM_EMAIL_DOMAIN))


class OidcBroker:
    """Generic OpenID Connect broker. Discovers endpoints from the issuer, so any
    standards-compliant provider (Auth0 today) works by config alone."""

    def __init__(self, issuer: str, client_id: str, client_secret: str, redirect_uri: str,
                 provider: str = "oidc"):
        self.issuer = issuer.rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret
        self.redirect_uri = redirect_uri
        self.provider = provider
        self._meta: dict | None = None

    def _discover(self) -> dict:
        if self._meta is None:
            url = f"{self.issuer}/.well-known/openid-configuration"
            self._meta = httpx.get(url, timeout=10).raise_for_status().json()
        return self._meta

    def authorize_url(self, state: str, nonce: str, code_challenge: str,
                      redirect_uri: str | None = None) -> str:
        meta = self._discover()
        params = {
            "response_type": "code", "client_id": self.client_id,
            "redirect_uri": redirect_uri or self.redirect_uri, "scope": "openid email profile",
            "state": state, "nonce": nonce, "prompt": "select_account",
            "code_challenge": code_challenge, "code_challenge_method": "S256",
        }
        return f"{meta['authorization_endpoint']}?{urlencode(params)}"

    def end_session_url(self) -> str | None:
        """Standard OIDC RP-initiated logout. Ends the provider session so the
        next sign-in really re-prompts. None if the provider doesn't advertise it."""
        endpoint = self._discover().get("end_session_endpoint")
        if not endpoint:
            return None
        params = {"client_id": self.client_id}
        return f"{endpoint}?{urlencode(params)}"

    def exchange_and_verify(self, code: str, code_verifier: str, nonce: str,
                            redirect_uri: str | None = None) -> Identity:
        from authlib.jose import jwt  # lazy: only needed when OIDC is configured

        meta = self._discover()
        tok = httpx.post(meta["token_endpoint"], data={
            "grant_type": "authorization_code", "code": code,
            "redirect_uri": redirect_uri or self.redirect_uri, "client_id": self.client_id,
            "client_secret": self.client_secret, "code_verifier": code_verifier,
        }, timeout=10).raise_for_status().json()

        jwks = httpx.get(meta["jwks_uri"], timeout=10).raise_for_status().json()
        # Validate `iss` against the issuer advertised by discovery, not a
        # reconstructed string — trailing-slash conventions differ per provider.
        claims = jwt.decode(tok["id_token"], jwks, claims_options={
            "iss": {"essential": True, "value": meta["issuer"]},
            "aud": {"essential": True, "value": self.client_id},
        })
        claims.validate()  # exp / iat
        if claims.get("nonce") != nonce:
            raise HTTPException(status_code=400, detail="oidc nonce mismatch")
        return Identity(
            provider=self.provider, sub=claims["sub"], email=claims.get("email"),
            email_verified=bool(claims.get("email_verified")), name=claims.get("name"),
        )


def _make_broker() -> OidcBroker | None:
    issuer = os.environ.get("OIDC_ISSUER")
    cid = os.environ.get("OIDC_CLIENT_ID")
    secret = os.environ.get("OIDC_CLIENT_SECRET")
    redirect = os.environ.get("OIDC_REDIRECT_URI")
    # Provider label stored on each player row. Defaults to "auth0" (the current
    # provider, keeps existing rows consistent); override when swapping IdPs.
    provider = os.environ.get("OIDC_PROVIDER", "auth0")
    if issuer and cid and secret and redirect:
        return OidcBroker(issuer, cid, secret, redirect, provider=provider)
    print("[auth] OIDC not configured (OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET/"
          "REDIRECT_URI); /register OAuth disabled. Non-OAuth sign-in still works.")
    return None


broker = _make_broker()

# --- routes ----------------------------------------------------------------
router = APIRouter(prefix="/api/auth")


def _player_public(p: dict) -> dict:
    return {"handle": p.get("handle"), "tier": p.get("tier"), "code": p.get("code"),
            "name": p.get("name")}


@router.get("/state")
def state(request: Request, response: Response) -> dict:
    """Bootstrap + poll. Never 401s — reports what's valid. Also mints the
    durable device cookie on first contact (the boot path hits this before
    anything else), so daily locks can anchor to the browser."""
    _ensure_device(request, response)
    player = verify_player(request.cookies.get(PLAYER_COOKIE))
    return {
        "player": {"handle": player.get("handle"), "tier": player.get("tier"),
                   "code": player.get("code")} if player else None,
        "oidc": broker is not None,
    }


@router.post("/signin")
async def signin(request: Request) -> Response:
    """Player sign-in — open to everyone, no booth unlock required:
      - tier "anon"  : one-tap play, nothing typed. Not on the public leaderboard.
      - tier "code"  : returning event guests use the code from phone registration.
      - tier "quick" : walk-up guests grab a handle and play now (no code/registration).
    Deepgram folks can also use "Sign in with Deepgram" (/oidc/start?dest=game)."""
    body = await request.json()
    tier = body.get("tier")
    if not _rate_ok(f"signin:{_client_ip(request)}"):
        raise HTTPException(status_code=429, detail="too many attempts")
    if tier == "anon":
        player = store.create_anon_player()
    elif tier == "quick":
        email = str(body.get("email", "")).strip()
        if email and not _EMAIL_RE.match(email):
            raise HTTPException(status_code=400, detail="that email doesn't look right")
        player = store.create_quick_player(body.get("handle") or "Player", email or None)
    elif tier == "code":
        player = store.get_player_by_code(body.get("code") or "")
        if not player:
            raise HTTPException(status_code=404, detail="unknown code")
        store.touch_last_seen(player["pid"])
    else:
        raise HTTPException(status_code=400, detail="unknown tier")
    resp = JSONResponse({"player": _player_public(player)})
    _set_cookie(resp, PLAYER_COOKIE, make_player_token(player), PLAYER_TOKEN_TTL)
    _ensure_device(request, resp)
    return resp


@router.post("/end")
def end() -> Response:
    """Ends the PLAYER session only. The device cookie survives on purpose —
    it's what keeps 'Start over' from resetting the daily play locks."""
    resp = JSONResponse({"ok": True})
    _clear_cookie(resp, PLAYER_COOKIE)
    return resp


@router.post("/claim")
async def claim(request: Request) -> Response:
    """Promote the CURRENT anonymous session onto the leaderboard, in place.
    Offered on the result card ("put it on the board?"): the pid keeps every
    play already recorded today, so the score the player is looking at surfaces
    on the board the moment they pick a handle — no replay, no new identity."""
    claims = verify_player(request.cookies.get(PLAYER_COOKIE))
    if not claims:
        raise HTTPException(status_code=401, detail="player")
    if not _rate_ok(f"claim:{_client_ip(request)}"):
        raise HTTPException(status_code=429, detail="too many attempts")
    if claims.get("tier") != "anon":
        raise HTTPException(status_code=409, detail="not an anonymous session")
    body = await request.json()
    handle = str(body.get("handle", "")).strip()[:24]
    email = str(body.get("email", "") or "").strip()[:120]
    if not handle:
        raise HTTPException(status_code=400, detail="a handle is required")
    if email and not _EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="that email doesn't look right")
    player = store.claim_player(claims["pid"], handle, email or None)
    if not player:
        raise HTTPException(status_code=404, detail="unknown player")
    resp = JSONResponse({"player": {
        **_player_public(player),
        "codename": store.codename_for(player["code"]),
    }})
    # Re-issue the cookie so the session carries the new tier + handle.
    _set_cookie(resp, PLAYER_COOKIE, make_player_token(player), PLAYER_TOKEN_TTL)
    return resp


@router.get("/me")
def me(request: Request) -> dict:
    """Current player, or the just-registered code (for the /register done-view)."""
    player = verify_player(request.cookies.get(PLAYER_COOKIE))
    if player:
        return {"player": {"handle": player.get("handle"), "tier": player.get("tier"),
                           "code": player.get("code")}}
    reg = _unsign("reg", request.cookies.get(_REG_COOKIE), _REG_RESULT_TTL)
    if reg:
        # Surface the public codename (derived from the code) so the /register
        # done-view can show the player their leaderboard identity, not just the code.
        reg["codename"] = store.codename_for(reg.get("code", ""))
        return {"registration": reg}
    return {"player": None}


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@router.post("/register")
async def register_direct(request: Request) -> Response:
    """Self-service phone registration (the /register page) as an alternative to
    OAuth: first/last/email -> a player code. NOT email-verified (no provider), so
    these are tier 'staff' with email_verified=0 — distinguishable from OAuth's
    verified players. Public + rate-limited; this only mints a code and stores
    contact info. Works even when OAuth is unset."""
    if not _rate_ok(f"register:{_client_ip(request)}"):
        raise HTTPException(status_code=429, detail="too many attempts")
    body = await request.json()
    first = str(body.get("first_name", "")).strip()
    last = str(body.get("last_name", "")).strip()
    email = str(body.get("email", "")).strip()
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="a valid email is required")
    if not (first or last):
        raise HTTPException(status_code=400, detail="a name is required")
    player = store.create_user(first, last, email)
    resp = JSONResponse({"registration": {
        "code": player["code"], "name": player.get("name"),
        "codename": store.codename_for(player["code"]),
    }})
    # Mirror OAuth: a short-lived reg cookie so a reload of /register still shows the code.
    _set_cookie(resp, _REG_COOKIE,
                _sign("reg", {"code": player["code"], "name": player.get("name"),
                              "email": player.get("email")}),
                _REG_RESULT_TTL)
    return resp


# ---- OIDC ----
@router.get("/oidc/start")
def oidc_start(dest: str = "register") -> Response:
    if broker is None:
        raise HTTPException(status_code=503, detail="OAuth not configured")
    # dest decides what the callback does: "game" = sign in to play now (Deepgram
    # accounts only); anything else = phone registration that mints a guest code.
    # ("booth" is the old name for the game page — old links still work.)
    dest = "game" if dest in ("game", "booth") else "register"
    state_val = secrets.token_urlsafe(24)
    nonce = secrets.token_urlsafe(24)
    code_verifier = secrets.token_urlsafe(48)
    challenge = _b64url(sha256(code_verifier.encode()).digest())
    resp = RedirectResponse(broker.authorize_url(state_val, nonce, challenge), status_code=302)
    _set_cookie(resp, _TX_COOKIE,
                _sign("tx", {"state": state_val, "nonce": nonce, "cv": code_verifier, "dest": dest}),
                _OIDC_TX_TTL)
    return resp


@router.get("/oidc/callback")
def oidc_callback(request: Request, code: str = "", state: str = "") -> Response:
    if broker is None:
        raise HTTPException(status_code=503, detail="OAuth not configured")
    tx = _unsign("tx", request.cookies.get(_TX_COOKIE), _OIDC_TX_TTL)
    if not tx or not secrets.compare_digest(tx.get("state", ""), state):
        raise HTTPException(status_code=400, detail="bad oidc state")
    ident = broker.exchange_and_verify(code, tx["cv"], tx["nonce"])

    # Game sign-in: VERIFIED Deepgram accounts only, logged straight into the game.
    # (Guests don't need this — quick play and guest codes are open to everyone.)
    # "booth" is the old dest name; honor transactions minted before the rename.
    if tx.get("dest") in ("game", "booth"):
        if not is_deepgram(ident):
            # Not a verified Deepgram account — refuse, no session. /game shows why.
            resp = RedirectResponse("/game?denied=1", status_code=302)
            _clear_cookie(resp, _TX_COOKIE)
            return resp
        player = store.upsert_oauth_player(
            ident.provider, ident.sub, ident.email, ident.email_verified,
            ident.name, consent=True,
        )
        resp = RedirectResponse("/game", status_code=302)
        _clear_cookie(resp, _TX_COOKIE)
        _set_cookie(resp, PLAYER_COOKIE, make_player_token(player), PLAYER_TOKEN_TTL)
        return resp

    # Phone registration (public, any provider): mint a code for the booth.
    player = store.upsert_oauth_player(
        ident.provider, ident.sub, ident.email, ident.email_verified,
        ident.name, consent=True,
    )
    resp = RedirectResponse("/register", status_code=302)
    _clear_cookie(resp, _TX_COOKIE)
    # Short-lived, non-secret result so the done-view can show the code without
    # putting it in the URL/history.
    _set_cookie(resp, _REG_COOKIE,
                _sign("reg", {"code": player["code"], "name": player.get("name"),
                              "email": player.get("email")}),
                _REG_RESULT_TTL)
    return resp


def _b64url(raw: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
