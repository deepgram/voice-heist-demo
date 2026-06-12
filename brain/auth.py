"""Optional, lightweight player identity for the Voice Heist demo.

The booth build had a heavy auth layer: a device gate, Auth0/OIDC ("sign in with
any account"), and an admin portal. The public demo keeps none of that. What it
offers instead is the simple, self-service version:

  - "Sign up" : first name, last name, and email -> a short code plus a public
                codename ("Crimson Fox 42"). The name and email are stored to
                identify a returning player; the PUBLIC leaderboard only ever shows
                the codename, never the name or email.
  - "Sign in" : re-enter that code on a later visit to recover your codename and
                standings (the one-play-per-heist-per-day limit applies to it).

Identity is OPTIONAL. With no cookie the brain just makes a fresh anonymous player
per connection, so anyone can play immediately; signing up only adds a persistent,
codename-on-the-board identity. The code is the credential players type to return.

The session rides in one HttpOnly cookie (`vh_player`) signed with stdlib HMAC
under VH_SIGNING_SECRET — no third-party dependency, no server-side session store.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

import store

PLAYER_COOKIE = "vh_player"
# The code is the durable credential, so this cookie is just convenience: keep a
# returning player signed in for a while without re-typing their code.
PLAYER_TOKEN_TTL = int(os.environ.get("PLAYER_TOKEN_TTL", str(30 * 24 * 3600)))
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "").lower() in ("1", "true", "yes")

_dev_secret: str | None = None


def _signing_secret() -> str:
    """The HMAC key for the player cookie. Prefer VH_SIGNING_SECRET; fall back to a
    loud, process-ephemeral dev value so local dev runs without configuration."""
    global _dev_secret
    val = os.environ.get("VH_SIGNING_SECRET")
    if val:
        return val
    if _dev_secret is None:
        print("[auth] WARNING: VH_SIGNING_SECRET is not set; using an insecure, "
              "process-ephemeral value. Set it before deploying so sign-in cookies "
              "survive a restart and can't be forged.")
        _dev_secret = "dev-insecure-" + secrets.token_hex(16)
    return _dev_secret


# --- token sign / verify (stdlib HMAC, URL-safe) ---------------------------
def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign(payload: dict) -> str:
    body = _b64e(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(_signing_secret().encode(), body.encode(), hashlib.sha256).digest()
    return f"{body}.{_b64e(sig)}"


def _unsign(token: str | None, max_age: int) -> dict | None:
    if not token or "." not in token:
        return None
    body, _, sig = token.partition(".")
    expected = hmac.new(_signing_secret().encode(), body.encode(), hashlib.sha256).digest()
    try:
        if not hmac.compare_digest(_b64d(sig), expected):
            return None
        payload = json.loads(_b64d(body))
    except (ValueError, TypeError):
        return None
    if max_age and (time.time() - float(payload.get("iat", 0))) > max_age:
        return None
    return payload


def make_player_token(player: dict) -> str:
    return _sign({"pid": player["pid"], "code": player.get("code"), "iat": int(time.time())})


def verify_player(token: str | None) -> dict | None:
    claims = _unsign(token, PLAYER_TOKEN_TTL)
    return claims if claims and claims.get("pid") else None


# --- cookies ---------------------------------------------------------------
def _set_player_cookie(resp: Response, player: dict) -> None:
    resp.set_cookie(
        PLAYER_COOKIE, make_player_token(player), max_age=PLAYER_TOKEN_TTL,
        httponly=True, secure=COOKIE_SECURE, samesite="lax", path="/",
    )


def clear_player_cookie(resp: Response) -> None:
    resp.delete_cookie(PLAYER_COOKIE, path="/")


def player_from_cookies(cookies) -> dict | None:
    """Resolve the signed-in player from request/WS cookies, or None. Re-reads the
    row from the DB (so a stale cookie yields no player) and checks the cookie's
    code still matches the row, as defense in depth."""
    claims = verify_player(cookies.get(PLAYER_COOKIE))
    if not claims:
        return None
    player = store.get_player_by_pid(claims["pid"])
    if not player or (claims.get("code") and player.get("code") != claims["code"]):
        return None
    return player


# --- rate limiting (in-memory token bucket; resets on restart) -------------
# The code space is ~28M, so throttle sign-in/mint to make guessing impractical
# and keep the public leaderboard from being scraped by brute force.
_buckets: dict[str, tuple[float, float]] = {}
_RATE_CAP = float(os.environ.get("AUTH_RATE_BURST", "20"))      # attempts before a 429
_RATE_WINDOW = float(os.environ.get("AUTH_RATE_WINDOW", "30"))  # seconds to fully refill
_RATE_REFILL = _RATE_CAP / _RATE_WINDOW


def _client_ip(request: Request) -> str:
    return (request.headers.get("fly-client-ip")
            or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
            or (request.client.host if request.client else "unknown"))


def _rate_ok(key: str) -> bool:
    now = time.monotonic()
    tokens, last = _buckets.get(key, (_RATE_CAP, now))
    tokens = min(_RATE_CAP, tokens + (now - last) * _RATE_REFILL)
    if tokens < 1.0:
        _buckets[key] = (tokens, now)
        return False
    _buckets[key] = (tokens - 1.0, now)
    return True


# --- routes ----------------------------------------------------------------
router = APIRouter(prefix="/api/auth")


def _identity(player: dict) -> dict:
    """The only thing we ever return to the client: the code and its public
    codename. No handle, name, email, or pid leaves the server."""
    return {"code": player.get("code"), "codename": store.codename_for(player.get("code") or "")}


@router.get("/me")
def me(request: Request) -> dict:
    player = player_from_cookies(request.cookies)
    return {"player": _identity(player) if player else None}


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@router.post("/register")
async def register(request: Request) -> Response:
    """Sign up with first/last name + email to get a code and a public codename.
    The name and email are stored to identify a returning player; the public
    leaderboard only ever shows the derived codename, never the name or email."""
    if not _rate_ok(f"register:{_client_ip(request)}"):
        return JSONResponse({"error": "too many attempts"}, status_code=429)
    body = await request.json()
    first = str(body.get("first_name", "")).strip()
    last = str(body.get("last_name", "")).strip()
    email = str(body.get("email", "")).strip()
    if not _EMAIL_RE.match(email):
        return JSONResponse({"error": "a valid email is required"}, status_code=400)
    if not (first or last):
        return JSONResponse({"error": "a name is required"}, status_code=400)
    player = store.create_user(first, last, email)
    resp = JSONResponse({"player": _identity(player)})
    _set_player_cookie(resp, player)
    return resp


@router.post("/signin")
async def signin(request: Request) -> Response:
    """Sign in with the email OR the code from sign-up, to recover the codename and
    standings. Anything containing '@' is treated as an email; otherwise a code."""
    if not _rate_ok(f"signin:{_client_ip(request)}"):
        return JSONResponse({"error": "too many attempts"}, status_code=429)
    body = await request.json()
    login = str(body.get("login") or body.get("code") or body.get("email") or "").strip()
    if not login:
        return JSONResponse({"error": "an email or code is required"}, status_code=400)
    player = (store.get_player_by_email(login) if "@" in login
              else store.get_player_by_code(login))
    if not player:
        return JSONResponse({"error": "no match for that email or code"}, status_code=404)
    store.touch_last_seen(player["pid"])
    resp = JSONResponse({"player": _identity(player)})
    _set_player_cookie(resp, player)
    return resp


@router.post("/signout")
def signout() -> Response:
    """Forget the current code on this device (back to anonymous play)."""
    resp = JSONResponse({"ok": True})
    clear_player_cookie(resp)
    return resp
