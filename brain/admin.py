"""Admin portal for Voice Heist — event controls for the Deepgram team.

Access: anyone who signs in via OAuth with a VERIFIED @deepgram.com email.
Reuses the same Auth0 OIDC broker as player registration (just a second callback
+ a server-side domain check) and issues a separate `vh_admin` cookie.

Capabilities (event controls only): toggle heist availability, revoke all device
gates (kill switch), and rotate the site password — all at runtime, no redeploy.
These read/write the `settings` table via store.py.
"""

from __future__ import annotations

import json
import os
import re
import secrets
from hashlib import sha256

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse

import auth  # reuse broker, token signing, cookie + ip/rate helpers (kept live)
import store

ADMIN_COOKIE = "vh_admin"
_ADMIN_TX_COOKIE = "vh_admin_tx"
ADMIN_EMAIL_DOMAIN = os.environ.get("ADMIN_EMAIL_DOMAIN", "deepgram.com").lower()
ADMIN_TOKEN_TTL = int(os.environ.get("ADMIN_TOKEN_TTL", str(8 * 3600)))
ADMIN_REDIRECT_URI = os.environ.get("OIDC_ADMIN_REDIRECT_URI")
_TX_TTL = 600


# --- admin token -----------------------------------------------------------
def make_admin_token(email: str) -> str:
    return auth._sign("admin", {"v": 1, "email": email})


def verify_admin_token(token: str | None) -> dict | None:
    return auth._unsign("admin", token, ADMIN_TOKEN_TTL)


def require_admin(request: Request) -> dict:
    claims = verify_admin_token(request.cookies.get(ADMIN_COOKIE))
    if not claims:
        raise HTTPException(status_code=401, detail="admin")
    return claims


def _is_deepgram(ident) -> bool:
    email = (ident.email or "").lower()
    return bool(ident.email_verified and email.endswith("@" + ADMIN_EMAIL_DOMAIN))


router = APIRouter(prefix="/api/admin")


# --- OIDC sign-in (verified @deepgram.com only) ----------------------------
@router.get("/login")
def admin_login(request: Request) -> Response:
    if auth.broker is None:
        raise HTTPException(status_code=503, detail="OAuth not configured")
    if not ADMIN_REDIRECT_URI:
        raise HTTPException(status_code=500, detail="OIDC_ADMIN_REDIRECT_URI not set")
    if not auth._rate_ok(f"adminlogin:{auth._client_ip(request)}"):
        raise HTTPException(status_code=429, detail="too many attempts")
    state = secrets.token_urlsafe(24)
    nonce = secrets.token_urlsafe(24)
    code_verifier = secrets.token_urlsafe(48)
    challenge = auth._b64url(sha256(code_verifier.encode()).digest())
    url = auth.broker.authorize_url(state, nonce, challenge, redirect_uri=ADMIN_REDIRECT_URI)
    resp = RedirectResponse(url, status_code=302)
    auth._set_cookie(resp, _ADMIN_TX_COOKIE,
                     auth._sign("admin_tx", {"state": state, "nonce": nonce, "cv": code_verifier}),
                     _TX_TTL)
    return resp


@router.get("/oidc/callback")
def admin_callback(request: Request, code: str = "", state: str = "") -> Response:
    if auth.broker is None:
        raise HTTPException(status_code=503, detail="OAuth not configured")
    tx = auth._unsign("admin_tx", request.cookies.get(_ADMIN_TX_COOKIE), _TX_TTL)
    if not tx or not secrets.compare_digest(tx.get("state", ""), state):
        raise HTTPException(status_code=400, detail="bad oidc state")
    ident = auth.broker.exchange_and_verify(code, tx["cv"], tx["nonce"],
                                            redirect_uri=ADMIN_REDIRECT_URI)
    if not _is_deepgram(ident):
        # Not a verified Deepgram account — refuse, no cookie. The page shows why.
        resp = RedirectResponse("/admin?denied=1", status_code=302)
        auth._clear_cookie(resp, _ADMIN_TX_COOKIE)
        return resp
    email = ident.email.lower()
    resp = RedirectResponse("/admin", status_code=302)
    auth._clear_cookie(resp, _ADMIN_TX_COOKIE)
    auth._set_cookie(resp, ADMIN_COOKIE, make_admin_token(email), ADMIN_TOKEN_TTL)
    store.record_audit(email, "login", ip=auth._client_ip(request))
    return resp


@router.get("/me")
def admin_me(request: Request) -> dict:
    claims = verify_admin_token(request.cookies.get(ADMIN_COOKIE))
    return {"email": claims["email"] if claims else None, "oidc": auth.broker is not None}


def _origin(request: Request) -> str:
    """Public origin, honoring Fly's TLS-terminating proxy headers."""
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = (request.headers.get("x-forwarded-host")
            or request.headers.get("host") or request.url.netloc)
    return f"{proto}://{host}"


@router.get("/logout")
def admin_logout(request: Request) -> Response:
    """Clear our session AND end the provider (Auth0) session via RP-initiated
    logout, so the next sign-in actually re-prompts. Must be a full-page
    navigation (not fetch) for the provider to clear its cookie."""
    target = "/admin"
    if auth.broker is not None:
        url = auth.broker.end_session_url()
        if url:
            target = url
    resp = RedirectResponse(target, status_code=302)
    auth._clear_cookie(resp, ADMIN_COOKIE)
    return resp


# --- event controls (all require a valid admin session) --------------------
@router.get("/settings")
def admin_settings(admin: dict = Depends(require_admin)) -> dict:
    return {
        "available": store.get_available(),
        "allScenarios": store.ALL_SCENARIOS,
        "turns": store.get_turns(),
    }


@router.get("/winners")
def admin_winners(admin: dict = Depends(require_admin)) -> dict:
    """Top scorer per Mon–Sun week, with name/email, so staff can run the prize
    outreach manually (we intentionally send no automated email)."""
    return {"winners": store.weekly_winners()}


# --- detailed scores + cleanup --------------------------------------------
@router.get("/scores")
def admin_scores(admin: dict = Depends(require_admin)) -> dict:
    """Every event day (newest first); within each day, every player ranked by
    their day total (high→low) with name/email and a per-scenario breakdown."""
    return {"days": store.daily_player_totals()}


@router.post("/scores/delete-day")
async def admin_delete_day(request: Request, admin: dict = Depends(require_admin)) -> dict:
    """Delete ALL plays for one event day. Players are kept; plays are gone."""
    body = await request.json()
    day = str(body.get("day", "")).strip()
    if not day:
        raise HTTPException(status_code=400, detail="day is required")
    n = store.delete_day_plays(day)
    store.record_audit(admin["email"], "delete_day", f"{day} ({n} plays)", auth._client_ip(request))
    return {"deleted": n}


@router.post("/scores/delete-row")
async def admin_delete_row(request: Request, admin: dict = Depends(require_admin)) -> dict:
    """Delete one player's plays for one event day (a single scores row)."""
    body = await request.json()
    pid = str(body.get("pid", "")).strip()
    day = str(body.get("day", "")).strip()
    if not pid or not day:
        raise HTTPException(status_code=400, detail="pid and day are required")
    n = store.delete_player_day_plays(pid, day)
    store.record_audit(admin["email"], "delete_player_day", f"{pid} {day} ({n} plays)", auth._client_ip(request))
    return {"deleted": n}


@router.post("/availability")
async def admin_availability(request: Request, admin: dict = Depends(require_admin)) -> dict:
    body = await request.json()
    avail = store.set_available(body.get("available") or [])
    store.record_audit(admin["email"], "set_availability", json.dumps(avail), auth._client_ip(request))
    return {"available": avail}


@router.post("/turns")
async def admin_turns(request: Request, admin: dict = Depends(require_admin)) -> dict:
    body = await request.json()
    turns = store.set_turns(body.get("turns") or {})
    store.record_audit(admin["email"], "set_turns", json.dumps(turns), auth._client_ip(request))
    return {"turns": turns}


# --- create user -----------------------------------------------------------
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@router.post("/users")
async def admin_create_user(request: Request, admin: dict = Depends(require_admin)) -> dict:
    body = await request.json()
    first = str(body.get("first_name", "")).strip()
    last = str(body.get("last_name", "")).strip()
    email = str(body.get("email", "")).strip()
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="a valid email is required")
    if not (first or last):
        raise HTTPException(status_code=400, detail="a name is required")
    player = store.create_user(first, last, email)
    store.record_audit(admin["email"], "create_user", f"{email} -> {player['code']}", auth._client_ip(request))
    return {"player": {"code": player["code"], "name": player.get("name"), "email": player.get("email")}}


# --- data browser (read-only DB scan) --------------------------------------
@router.get("/tables")
def admin_tables(admin: dict = Depends(require_admin)) -> dict:
    return {"tables": store.list_tables()}


@router.get("/tables/{table}")
def admin_table_data(table: str, limit: int = 100, offset: int = 0,
                     admin: dict = Depends(require_admin)) -> dict:
    data = store.table_data(table, limit, offset)
    if data is None:
        raise HTTPException(status_code=404, detail="unknown table")
    return data
