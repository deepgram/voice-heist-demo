"""Per-connection game brain for Voice Heist.

A GameSession consumes small JSON events relayed from the browser (the player's
turns, the agent's function calls, audio-done signals) and returns "directives"
the browser executes against its Deepgram session. All game logic - routing,
the multi-agent handoff, the turn cap, scoring, win/lose, host-awareness - lives here.
"""

from __future__ import annotations

import judge
import store
from agents import (
    AUDIO,
    INTRODUCER,
    LEVELS,
    LEVEL_ORDER,
    LOBBY,
    MAX_TURNS,
    POINTS_WARM,
    POINTS_WEAK,
    POINTS_WIN,
    build_agent,
    build_initial_agent,
    build_intro_agent,
    intro_line,
    intro_prompt,
    lobby_prompt,
    lobby_return_line,
)


class GameSession:
    def __init__(self) -> None:
        self.results: dict[str, str | None] = {i: None for i in LEVEL_ORDER}
        self.phase: str = "lobby"  # "lobby" or a level id
        self.turn_count: int = 0
        self.pending: dict | None = None  # set once a verdict is reached
        self.available: list[str] = list(LEVEL_ORDER)  # heists enabled at this event
        self.player: dict | None = None  # {pid, handle, tier, code} from the auth cookie
        self.event_day: str | None = None  # local event date, for the daily limit
        self.intro_game: str | None = None  # heist being briefed (phase == "intro")
        # Live score for the heist in progress (reset each round by _reset_round).
        self.score_total: int = 0          # best tier reached this heist (100/500/1000)
        self.transcript: list[str] = []    # the player's own lines, for judge context
        self.unlimited: bool = False       # test players: no turn cap, no daily lock
        self.max_turns: int = MAX_TURNS    # per-session cap (raised for test players)

    def configure(self, available=None, player=None, played=None, event_day=None) -> None:
        if available is not None:
            self.available = [g for g in LEVEL_ORDER if g in available]
        if player is not None:
            self.player = player
            # Test players (tier 'test', seeded from VH_TEST_CODE) get unlimited
            # turns and unlimited replays, and are kept off the leaderboard.
            self.unlimited = player.get("tier") == "test"
            self.max_turns = 999 if self.unlimited else MAX_TURNS
        if event_day is not None:
            self.event_day = event_day
        # Restore any scenarios this player already completed today so the UI
        # shows them as cracked/busted and they can't be replayed. (Test players
        # are exempt, so they can replay every heist freely.)
        if played and not self.unlimited:
            for sid, outcome in played.items():
                if sid in self.results:
                    self.results[sid] = outcome

    def _eligibility(self, game: str) -> str:
        """Returns 'open' or 'unavailable'. A scenario already resolved this
        session (or earlier today, for a returning player) is locked."""
        if game in self.available and (self.unlimited or not self.results.get(game)):
            return "open"
        return "unavailable"

    def _reset_round(self) -> None:
        """Clear per-heist state (turns, verdict, score) at every transition."""
        self.turn_count = 0
        self.pending = None
        self.score_total = 0
        self.transcript = []

    def _cap_for(self, game: str) -> int:
        """Live per-game turn cap from admin settings (test players: no cap)."""
        return 999 if self.unlimited else store.get_turns().get(game, MAX_TURNS)

    # ---- inbound events ------------------------------------------------------
    def init_message(self) -> dict:
        player_score = 0
        if self.player and self.event_day and not self.unlimited:
            player_score = store.player_day_total(self.player["pid"], self.event_day)
        return {
            "type": "init",
            "agent": build_initial_agent(self.available, self.results),
            "audio": AUDIO,
            "ui": {
                "agentName": LOBBY["agentName"],
                "phase": "lobby",
                "maxTurns": self.max_turns,
                "results": dict(self.results),
                "available": list(self.available),
                "playerScore": player_score,
                "player": {
                    "handle": self.player.get("handle"),
                    "code": self.player.get("code"),
                    "codename": store.codename_for(self.player["code"]),
                } if self.player else None,
            },
        }

    def on_function(self, fn_id, name, args) -> list[dict]:
        args = args or {}
        if name == "select_game":
            return self._select_game(fn_id, args.get("game"))
        if name == "begin_heist":
            return self._begin_heist(fn_id)
        if name in ("grant_request", "deny_request"):
            return self._verdict(fn_id, name, args.get("reason", ""))
        if name == "return_to_lobby":
            return self._go_to_lobby(fn_id, name)
        return [self._fn_response(fn_id, name, {"error": f"Unknown function: {name}"})]

    def on_user_turn(self, text: str | None = None) -> list[dict]:
        # Only count substantive utterances. Speech detection can split a single
        # sentence ("My" then "name is Genia") into separate messages; counting
        # tiny fragments would unfairly burn a player's limited turns.
        if self.phase in LEVELS and self.pending is None and _is_substantive(text):
            if self.turn_count >= self.max_turns:
                # Every turn is spent and the player is still talking — end the
                # heist now so the gatekeeper can't keep conversing past the limit.
                return [self._out_of_turns_loss()]
            self.turn_count += 1
            self.transcript.append(text.strip())
            return [{"type": "turn", "current": self.turn_count, "max": self.max_turns}]
        return []

    async def judge_turn(self, text: str | None = None) -> dict | None:
        """Score the player's latest line with one judge LLM call; return a
        'score' directive (delta + running total). Mirrors on_user_turn's gating
        so only substantive in-heist turns are scored, before any verdict. The
        winning move is re-scored to WIN points later, in _verdict."""
        if self.phase not in LEVELS or self.pending is not None or not _is_substantive(text):
            return None
        points, label = await judge.score_turn(self.phase, text, self.transcript[:-1])
        # Score is the BEST tier reached, never a sum: showing up is 100, getting
        # "almost correct" (a warm turn) lifts it to 500 once, and winning makes it
        # 1000 (set in _verdict). So the 100 is only the first interaction, 500 is
        # earned a single time when they first get close — not per warm turn — and a
        # later weak turn never lowers it.
        tier = POINTS_WARM if label == "warm" else POINTS_WEAK
        new_total = max(self.score_total, tier)
        delta = new_total - self.score_total
        self.score_total = new_total
        return {"type": "score", "delta": delta, "label": label, "total": self.score_total}

    def on_agent_done(self) -> list[dict]:
        # Backstop for the turn cap: player used all turns, no verdict -> loss.
        if self.phase in LEVELS and self.pending is None and self.turn_count >= self.max_turns:
            return [self._out_of_turns_loss()]
        return []

    def _out_of_turns_loss(self) -> dict:
        """End the active heist as a loss because the player's turns are spent.
        Used as the agent-done backstop AND when a player keeps talking after the
        cap, so a heist can't run on indefinitely past the limit."""
        level = LEVELS[self.phase]
        self.pending = {"outcome": "lose", "level": self.phase}
        # Only say "so close" if they actually reached the warm (500) tier.
        reason = (
            "So close! One more nudge would've cracked it. Come back tomorrow and give it another go."
            if self.score_total >= POINTS_WARM
            else "The rule didn't budge. Better luck next time!"
        )
        return self._result("lose", level, reason, immediate=True)

    def on_result_ack(self) -> list[dict]:
        return self._go_to_lobby()

    def on_request_lobby(self) -> list[dict]:
        if self.phase != "lobby":
            return self._go_to_lobby()
        return []

    def on_choose_game(self, game) -> list[dict]:
        # Multimodal: the player tapped a heist card instead of telling the Host.
        # Only choosable from the lobby (ignore taps during a briefing or heist).
        if self.phase != "lobby":
            return []
        level = LEVELS.get(game)
        if not level or self._eligibility(game) != "open":
            return []  # not available / already played today
        # Card tap: route to the Briefer with a full agent config so the client can
        # start a fresh session whose greeting (the intro line) plays on connect.
        self.phase = "intro"
        self.intro_game = game
        self._reset_round()
        return [self._intro_handoff(None, None, game, fresh=True)]

    # ---- transitions ---------------------------------------------------------
    def _select_game(self, fn_id, game) -> list[dict]:
        level = LEVELS.get(game)
        if not level:
            return [self._fn_response(fn_id, "select_game", {"ok": True}), *self._go_to_lobby()]
        # Decline (stay with the Host) if this heist isn't available at the event.
        if self._eligibility(game) != "open":
            return [self._fn_response(fn_id, "select_game", {
                "started": False,
                "message": f'{level["title"]} isn\'t available right now (either not at this event, or already played today). Apologize briefly and suggest another heist instead. Do not start it.',
            })]
        # Route to the Briefer first (not the gatekeeper). The browser swaps the
        # persona/voice BEFORE answering this call (fnId), so the Host can't speak
        # between the function call and the handoff.
        self.phase = "intro"
        self.intro_game = game
        self._reset_round()
        return [self._intro_handoff(fn_id, "select_game", game)]

    def _intro_handoff(self, fn_id, fn_name, game, fresh=False) -> dict:
        """Hand off to the Briefer, who explains the heist and asks if the player
        is ready before the gatekeeper ever speaks."""
        level = LEVELS[game]
        directive = {
            "type": "handoff",
            "stage": "intro",
            "fnId": fn_id,
            "fnName": fn_name,
            "prompt": intro_prompt(game),
            "voice": INTRODUCER["voice"],
            "openingLine": intro_line(game),
            "ui": {
                "agentName": INTRODUCER["agentName"],
                "title": level["title"],
                "goal": level["goal"],
                "ruleHint": level["ruleHint"],
            },
        }
        if fresh:
            directive["agent"] = build_intro_agent(game)
        return directive

    def _begin_heist(self, fn_id) -> list[dict]:
        """Player confirmed during the briefing: the Briefer wishes them luck, then
        the gatekeeper starts (deferred client-side until 'Good luck!' finishes)."""
        game = self.intro_game
        level = LEVELS.get(game) if game else None
        if not level:
            return [self._fn_response(fn_id, "begin_heist", {"ok": True}), *self._go_to_lobby()]
        self.phase = game
        self.intro_game = None
        self._reset_round()
        self.max_turns = self._cap_for(game)
        return [
            self._fn_response(fn_id, "begin_heist",
                              {"instruction": 'Say exactly this and nothing else: "Good luck!"'}),
            {
                "type": "handoff",
                "stage": "play",
                "defer": True,  # the client applies this only after "Good luck!" finishes
                "fnId": None,
                "agent": build_agent(level["prompt"], level["voice"], level["openingLine"]),
                "prompt": level["prompt"],
                "voice": level["voice"],
                "openingLine": level["openingLine"],
                "ui": {
                    "agentName": level["agentName"],
                    "title": level["title"],
                    "goal": level["goal"],
                    "ruleHint": level["ruleHint"],
                    "hint": level["hint"],
                    "cue": level["cue"],
                    "maxTurns": self.max_turns,
                },
            },
        ]

    def _verdict(self, fn_id, name, reason) -> list[dict]:
        level = LEVELS.get(self.phase)
        if not level:
            return [self._fn_response(fn_id, name, {"ok": True})]
        outcome = "win" if name == "grant_request" else "lose"
        self.pending = {"outcome": outcome, "level": self.phase}
        if outcome == "win":
            # Correct -> top tier. Score is the best tier reached, so a win is simply
            # 1000 (showing up is 100, getting "almost correct" is 500).
            self.score_total = POINTS_WIN
            instruction = (
                "The player WON. In ONE short, celebratory sentence, fully in your character's "
                "voice, make the win land like a big deal and make them feel like a legend, "
                "then STOP. Exactly one line — no second sentence, nothing after it."
            )
        else:
            # A loss should still land with a smile: tease the trick they missed,
            # stay fully in character, be good-natured (never mean), and wish them
            # luck. The level's own nudge tells you what would have worked.
            instruction = (
                "The player lost, but make them grin — this is a party game. In ONE short, "
                "good-natured sentence, fully in your character's voice, land a themed quip or pun "
                "(your club door, pizza shop, phone line, or streaming service) that playfully "
                "winks at what would have actually worked, never mean. Then STOP — exactly one "
                f"line, no second sentence, nothing after it. The move to tease: {level['nudge']}"
            )
        return [
            self._fn_response(fn_id, name, {"instruction": instruction}),
            self._result(outcome, level, reason, immediate=False),
        ]

    def _go_to_lobby(self, fn_id=None, fn_name=None) -> list[dict]:
        # Capture the heist just finished (and its outcome) before we reset, so the
        # Host can react to it ("Nice — you cracked The List!") on the way back.
        just_played = self.phase if self.phase in LEVELS else None
        outcome = self.pending.get("outcome") if self.pending else None
        self.phase = "lobby"
        self.intro_game = None
        self._reset_round()
        return [
            {
                "type": "lobby",
                "fnId": fn_id,
                "fnName": fn_name,
                "prompt": lobby_prompt(self.results, self.available),
                "voice": LOBBY["voice"],
                "line": lobby_return_line(self.results, self.available, just_played, outcome),
                "ui": {"agentName": LOBBY["agentName"]},
                "results": dict(self.results),
            }
        ]

    # ---- directive builders --------------------------------------------------
    def _result(self, outcome, level, reason, immediate) -> dict:
        self.results[level["id"]] = outcome
        # On a loss, only credit the named near-miss path if they actually reached the
        # warm tier (500). A minimum-score bust didn't get close, so don't imply they
        # were "almost" there — that label is what the 500 tier means.
        if outcome == "win":
            path = level["passPath"]
        elif self.score_total >= POINTS_WARM:
            path = level["failPath"]
        else:
            # Weak (100): a participation nod — they engaged but never got close.
            path = "Talking with the Gatekeeper"
        # Persist the play so it counts toward the daily limit and the leaderboard,
        # and so a returning player sees this result. INSERT-OR-IGNORE keeps the
        # one-per-scenario-per-day rule authoritative even if called twice.
        if self.player and self.event_day and not self.unlimited:
            store.record_play(
                self.player["pid"], level["id"], self.event_day, outcome, path,
                mode="booth", score=self.score_total,
            )
        title = f'{level["title"]}: cracked!' if outcome == "win" else f'{level["title"]}: busted.'
        return {
            "type": "result",
            "level": level["id"],
            "outcome": outcome,
            "title": title,
            "path": path,
            "reason": reason,
            "score": self.score_total,
            # On a loss, reveal the move they missed so the bust is a laugh + a
            # lesson; the win screen doesn't need it.
            "hint": level["hint"] if outcome == "lose" else None,
            "immediate": immediate,
            "results": dict(self.results),
        }

    @staticmethod
    def _fn_response(fn_id, name, content) -> dict:
        # `content` is sent as an object; the browser JSON-stringifies it for Deepgram.
        return {"type": "fn_response", "id": fn_id, "name": name, "content": content}


def _is_substantive(text: str | None) -> bool:
    """A real attempt, not a stray speech fragment like 'My' or 'um'."""
    return bool(text) and len(text.strip().split()) >= 2
