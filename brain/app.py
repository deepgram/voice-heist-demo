"""Voice Heist backend (the game brain + token minter).

- GET  /api/deepgram-token : mints a short-lived Deepgram token from DEEPGRAM_API_KEY.
- WS   /ws/brain           : the game brain. The browser relays function calls and
                             turn events; we reply with directives (handoff, result,
                             lobby, function responses). No audio passes through here.
- Static (production)      : serves the built client from ../dist.

The browser keeps the low-latency audio WebSocket straight to Deepgram; this server
only carries small JSON control messages.
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent  # voice-heist/
# Load .env BEFORE importing local modules: auth.py (and admin) read their config
# (AUTH_SIGNING_SECRET, OIDC_*, admin allowlist) at import time, so
# the env must be populated first or OAuth/secrets silently fall back to dev values.
# override=True so .env is authoritative even if a var is already exported in the
# shell (e.g. a stale DEEPGRAM_API_KEY from a previous session).
load_dotenv(ROOT / ".env", override=True)

import admin  # noqa: E402
import auth  # noqa: E402  (must follow load_dotenv — see note above)
import store  # noqa: E402
from session import GameSession  # noqa: E402

DEEPGRAM_API_KEY = os.environ.get("DEEPGRAM_API_KEY")
DIST_DIR = ROOT / "dist"


def available_scenarios() -> list[str]:
    """Which heists are enabled at this event. Runtime-controlled via the admin
    portal (settings table); seeded on first boot from VOICE_HEIST_AVAILABLE."""
    return store.get_available()

app = FastAPI(title="Voice Heist")


@app.on_event("startup")
def _startup() -> None:
    store.init_db()


# Periodic same-volume DB snapshots (restore points for corruption or an admin
# fat-finger). Offsite replication is separate: entrypoint.sh wraps the server
# in Litestream when the LITESTREAM_REPLICA_URL secret is set.
BACKUP_DIR = os.environ.get("VH_BACKUP_DIR")  # unset in dev = no snapshots
BACKUP_INTERVAL = float(os.environ.get("VH_BACKUP_INTERVAL_SEC", "21600"))  # 6h


async def _backup_loop() -> None:
    while True:
        await asyncio.sleep(BACKUP_INTERVAL)
        try:
            store.backup_db(BACKUP_DIR)
        except Exception:  # a failed snapshot must never take the game down
            logging.exception("periodic DB snapshot failed")


@app.on_event("startup")
async def _start_backup_loop() -> None:
    if BACKUP_DIR:
        asyncio.create_task(_backup_loop())


app.include_router(auth.router)
app.include_router(admin.router)


# The game is on the open internet and anonymous sessions are free to mint, so
# the token faucet needs its own per-IP budget: legit play mints ~4 tokens per
# heist (connect + two handoffs + the lobby return); a farmer hits the cap fast.
# Tune via env if a NAT'd office genuinely needs more.
TOKEN_RATE_BURST = float(os.environ.get("TOKEN_RATE_BURST", "40"))
TOKEN_RATE_WINDOW = float(os.environ.get("TOKEN_RATE_WINDOW", "600"))

# One brain socket ≈ one live voice session ≈ one Deepgram agent connection.
# SQLite-on-volume pins the app to a single machine, so this cap IS the whole
# capacity ceiling — size it to the Deepgram key's concurrent-session limit.
# At the cap, new connections are refused with 4429, which the client renders
# as an in-fiction "all lines are hot" message (and quietly retries).
MAX_SESSIONS = int(os.environ.get("VH_MAX_SESSIONS", "30"))
_active_sessions = 0


@app.get("/api/deepgram-token", response_class=PlainTextResponse)
async def deepgram_token(
    request: Request,
    _player: dict = Depends(auth.require_player),
) -> PlainTextResponse:
    """Mint a short-lived Deepgram token so the browser never sees the API key.
    Requires a player session (any tier, including anonymous one-tap play)."""
    if not auth.rate_limit(f"token:{auth._client_ip(request)}",
                           TOKEN_RATE_BURST, TOKEN_RATE_WINDOW):
        return PlainTextResponse("Too many sessions from here — take a breather.",
                                 status_code=429)
    if not DEEPGRAM_API_KEY:
        return PlainTextResponse("Missing DEEPGRAM_API_KEY", status_code=500)
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            "https://api.deepgram.com/v1/auth/grant",
            headers={
                "Authorization": f"Token {DEEPGRAM_API_KEY}",
                "Content-Type": "application/json",
            },
            # 300s so the token outlives the SDK's ~4-minute token cache; otherwise
            # a reconnect reuses an expired token and fails with "Invalid credentials".
            json={"ttl_seconds": 300},
        )
    if resp.status_code != 200:
        return PlainTextResponse(
            f"Failed to mint token ({resp.status_code})", status_code=502
        )
    return PlainTextResponse(resp.json()["access_token"])


@app.get("/api/leaderboard")
def api_leaderboard() -> dict:
    """Public, read-only leaderboard (codenames + scores; no PII, no auth):
    daily sections (rows carry earned badges) plus the all-time podium (top
    single-day totals ever), the day's latest cracks (`recent` — the board's
    pulse), and `resetInSec` until the daily reset (event-timezone midnight).
    Powers /leaderboard.html and the landing rail — anyone with the URL can
    watch. `today` is the current event day, so clients can tell "today's
    best" apart from a previous day's section (the days list accumulates)."""
    day = auth.event_day()
    return {"days": store.leaderboard(day), "today": day,
            "allTime": store.all_time_top(3),
            "recent": store.recent_wins(day),
            "resetInSec": auth.seconds_to_reset()}


@app.websocket("/ws/brain")
async def brain(ws: WebSocket) -> None:
    # Authenticate from cookies first: a valid player session (any tier,
    # including anonymous) or the socket is turned away. Both refusal paths
    # accept before closing — a custom close code only reaches the browser's
    # onclose after the upgrade completes; closing pre-accept surfaces as a
    # bare HTTP 403 and the 4401/4429 signal is lost (the browser sees 1006).
    global _active_sessions
    player = auth.verify_ws(ws.cookies)
    if not player:
        await ws.accept()
        await ws.close(code=4401)
        return
    if _active_sessions >= MAX_SESSIONS:
        await ws.accept()
        await ws.close(code=4429)
        return
    await ws.accept()
    _active_sessions += 1
    try:
        game = GameSession()
        day = auth.event_day()
        # Daily locks anchor to the durable device cookie as well as the pid, so a
        # re-minted anonymous identity ("Start over") inherits today's plays.
        device = auth.device_from_cookies(ws.cookies)
        game.configure(
            available=available_scenarios(),
            player=player,
            played=store.played_today(player["pid"], day, device),
            event_day=day,
            device_id=device,
        )
        await ws.send_json(game.init_message())
        try:
            while True:
                msg = await ws.receive_json()
                await _handle(game, msg, ws)
        except WebSocketDisconnect:
            return
    finally:
        _active_sessions -= 1


async def _handle(game: GameSession, msg: dict, ws: WebSocket) -> None:
    mtype = msg.get("type")
    if mtype == "user_turn":
        text = msg.get("text")
        for directive in game.on_user_turn(text):
            await ws.send_json(directive)
        # Score that turn with a separate judge LLM call; send it a beat after the
        # turn pill updates. Awaited so each connection scores its turns in order.
        score = await game.judge_turn(text)
        if score:
            await ws.send_json(score)
        return
    if mtype == "fn_call":
        directives = game.on_function(msg.get("id"), msg.get("name"), msg.get("args"))
    elif mtype == "agent_done":
        directives = game.on_agent_done()
    elif mtype == "result_ack":
        # `next` (optional) is the result card's "Next heist" / "Retry" button:
        # the brain re-validates it and rings the Briefer directly.
        directives = game.on_result_ack(msg.get("next"))
    elif mtype == "request_lobby":
        directives = game.on_request_lobby()
    elif mtype == "choose_game":
        directives = game.on_choose_game(msg.get("game"))
    else:
        directives = []
    for directive in directives:
        await ws.send_json(directive)


# The phone registration page. StaticFiles(html=True) won't map a bare
# "/register" to register.html, so serve it explicitly. (In dev, Vite serves it.)
@app.get("/register")
def register_page() -> FileResponse:
    return FileResponse(DIST_DIR / "register.html")


# Public leaderboard page (also reachable directly as /leaderboard.html via static).
@app.get("/leaderboard")
def leaderboard_page() -> FileResponse:
    return FileResponse(DIST_DIR / "leaderboard.html")


# Season rules — the player-facing contract for the weekly prize (linked from
# the claim form, the sign-in card, and the leaderboard footer).
@app.get("/rules")
def rules_page() -> FileResponse:
    return FileResponse(DIST_DIR / "rules.html")


# Admin portal (Deepgram-only). The page is public/inert; the /api/admin/* data
# and actions are guarded server-side by require_admin.
@app.get("/admin")
def admin_page() -> FileResponse:
    return FileResponse(DIST_DIR / "admin.html")


# Public entry: the game itself. "/" lands on /game; registration (/register)
# is optional — it mints a code for players who want their codename saved on the
# leaderboard and to be reachable for prizes. This explicit route takes
# precedence over the StaticFiles(html=True) mount.
@app.get("/")
def root() -> RedirectResponse:
    return RedirectResponse("/game", status_code=302)


# The game — the landing page ("/" redirects here).
@app.get("/game")
def game_page() -> FileResponse:
    return FileResponse(DIST_DIR / "index.html")


# Old links and QR codes still point at /booth — send them to the game.
@app.get("/booth")
def booth_redirect() -> RedirectResponse:
    return RedirectResponse("/game", status_code=301)


# Serve the built client in production (after API routes are registered).
if DIST_DIR.exists():
    app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="static")
