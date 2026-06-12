"""Per-turn scoring judge for Voice Heist.

Separate from the in-pipeline agent LLM (Deepgram runs that one). After each
player turn the brain makes its own small, fast LLM call to rate that single
utterance for the active scenario, so the score can tick up live on screen.
Each game has its own rubric — see each level's "judge" in agents.py.

Per-turn tiers:
  - WEAK (100): a genuine, on-topic attempt that isn't really working.
  - WARM (500): clearly heading toward this game's winning approach.
  - WIN (1000): the actual "crack" — awarded by session.py when the gatekeeper
    grants the request, NOT by this module.

Uses Anthropic's Messages API with a fast Claude model (JUDGE_MODEL). The key is
read from ANTHROPIC_API_KEY (or the lowercase variant). With no key configured,
or on any network/parse error, we fall back to WEAK so scoring never blocks
gameplay.
"""

from __future__ import annotations

import os

import httpx

from agents import JUDGE_MODEL, LEVELS, POINTS_WARM, POINTS_WEAK

_ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
_ANTHROPIC_VERSION = "2023-06-01"
_TIMEOUT = 6.0
_warned = False


def _api_key() -> str | None:
    return os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("anthropic_api_key")


def _system_prompt(level: dict) -> str:
    return (
        "You are a strict, fast scorer for a short voice persuasion game. "
        f'The game is "{level["title"]}" and the player\'s goal is: {level["goal"]} '
        "Judge ONLY the single player line you are given, in the context of that goal, "
        "and decide if it is WARM or WEAK using this rubric:\n"
        f"{level['judge']}\n"
        'Reply with EXACTLY one word: "warm" or "weak". No other text.'
    )


async def score_turn(
    level_id: str, utterance: str, history: list[str] | None = None
) -> tuple[int, str]:
    """Rate one player utterance -> (points, tier_label). Defaults to WEAK on any
    problem so a missing key or a flaky call never blocks the game."""
    global _warned
    level = LEVELS.get(level_id)
    if not level:
        return POINTS_WEAK, "weak"
    key = _api_key()
    if not key:
        if not _warned:
            print("[judge] No ANTHROPIC_API_KEY set; every turn scores the minimum. "
                  "Set the key to enable graded scoring.")
            _warned = True
        return POINTS_WEAK, "weak"

    context = ""
    if history:
        recent = "\n".join(f"- {h}" for h in history[-3:])
        context = f"Earlier lines from the same player this game:\n{recent}\n\n"
    user_content = f'{context}The player just said:\n"{utterance.strip()}"'

    payload = {
        "model": JUDGE_MODEL,
        "max_tokens": 5,
        "temperature": 0,
        "system": _system_prompt(level),
        "messages": [{"role": "user", "content": user_content}],
    }
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(
                _ANTHROPIC_URL,
                headers={
                    "x-api-key": key,
                    "anthropic-version": _ANTHROPIC_VERSION,
                    "content-type": "application/json",
                },
                json=payload,
            )
        resp.raise_for_status()
        blocks = resp.json().get("content", [])
        text = " ".join(b.get("text", "") for b in blocks if b.get("type") == "text")
    except Exception as e:  # network, parse, rate-limit — never break the game
        print(f"[judge] scoring fell back to weak: {e}")
        return POINTS_WEAK, "weak"
    return (POINTS_WARM, "warm") if "warm" in text.strip().lower() else (POINTS_WEAK, "weak")
