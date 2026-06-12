"""Voice Heist demo backend (game brain + Deepgram token minter).

- GET  /api/deepgram-token : mints a short-lived Deepgram token from DEEPGRAM_API_KEY.
- GET  /api/leaderboard    : public daily leaderboard (codenames + scores; no PII).
- *    /api/auth/*         : optional player identity (name+email sign-up / code sign-in).
- WS   /ws/brain           : the game brain. The browser relays function calls and
                             turn events; we reply with directives (handoff, result,
                             lobby, function responses). No audio passes through here.
- Static (production)      : serves the built client from ../dist.

The browser keeps the low-latency audio WebSocket straight to Deepgram (via the
@deepgram/agents SDK); this server only carries small JSON control messages.

This is the PUBLIC DEMO build: the booth's device gate, Auth0 OAuth, and admin
portal are gone. What remains is an OPTIONAL, self-service identity (see auth.py):
play immediately as a fresh anonymous player, or sign up with a name + email to get
a short code that keeps your standings across visits. The public leaderboard only
ever shows a derived codename, never the name or email.
"""

from __future__ import annotations

import os
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent  # voice-heist-demo/
# Load .env before importing local modules so config is populated first.
load_dotenv(ROOT / ".env", override=True)

import auth  # noqa: E402
import store  # noqa: E402
from session import GameSession  # noqa: E402

DEEPGRAM_API_KEY = os.environ.get("DEEPGRAM_API_KEY")
DIST_DIR = ROOT / "dist"


def available_scenarios() -> list[str]:
    """Which heists are enabled. Seeded from VOICE_HEIST_AVAILABLE (all four by default)."""
    return store.get_available()


app = FastAPI(title="Voice Heist (demo)")
# Optional, PII-free player identity (get-a-code / sign-in). No gate, no OAuth,
# no personal data — see brain/auth.py.
app.include_router(auth.router)


@app.on_event("startup")
def _startup() -> None:
    store.init_db()


@app.get("/api/deepgram-token", response_class=PlainTextResponse)
async def deepgram_token() -> PlainTextResponse:
    """Mint a short-lived Deepgram token so the browser never sees the API key.
    The key must be allowed to create grant tokens (Member+ permissions)."""
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
            # a reconnect can reuse an expired token and fail with "Invalid credentials".
            json={"ttl_seconds": 300},
        )
    if resp.status_code != 200:
        return PlainTextResponse(f"Failed to mint token ({resp.status_code})", status_code=502)
    return PlainTextResponse(resp.json()["access_token"])


@app.get("/api/leaderboard")
def api_leaderboard() -> dict:
    """Public, read-only daily leaderboard (codenames + scores; no PII, no auth)."""
    return {"days": store.leaderboard()}


@app.websocket("/ws/brain")
async def brain(ws: WebSocket) -> None:
    # Optional identity: if the player signed in (vh_player cookie), run as that
    # persistent player so their codename and standings carry over. With no cookie,
    # make a fresh anonymous player so anyone can play right away.
    await ws.accept()
    player = auth.player_from_cookies(ws.cookies) or store.create_quick_player("Player")
    game = GameSession()
    day = store.event_day()
    game.configure(
        available=available_scenarios(),
        player=player,
        played=store.played_today(player["pid"], day),
        event_day=day,
    )
    await ws.send_json(game.init_message())
    try:
        while True:
            msg = await ws.receive_json()
            await _handle(game, msg, ws)
    except WebSocketDisconnect:
        return


async def _handle(game: GameSession, msg: dict, ws: WebSocket) -> None:
    mtype = msg.get("type")
    if mtype == "user_turn":
        text = msg.get("text")
        for directive in game.on_user_turn(text):
            await ws.send_json(directive)
        # Score that turn with a separate judge LLM call, after the turn pill updates.
        score = await game.judge_turn(text)
        if score:
            await ws.send_json(score)
        return
    if mtype == "fn_call":
        directives = game.on_function(msg.get("id"), msg.get("name"), msg.get("args"))
    elif mtype == "agent_done":
        directives = game.on_agent_done()
    elif mtype == "result_ack":
        directives = game.on_result_ack()
    elif mtype == "request_lobby":
        directives = game.on_request_lobby()
    elif mtype == "choose_game":
        directives = game.on_choose_game(msg.get("game"))
    else:
        directives = []
    for directive in directives:
        await ws.send_json(directive)


# Serve the built client in production (after API routes are registered). In dev,
# Vite serves the client and proxies /api + /ws here, so this mount is unused.
if DIST_DIR.exists():
    app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="static")
