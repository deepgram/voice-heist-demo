# Contributing to Voice Heist

Thanks for your interest! This repo is the **public demo** of the Voice Heist booth game — a reference for building voice agents on the [Deepgram Voice Agent API](https://developers.deepgram.com/docs/voice-agent). Bug fixes, clarity improvements, and small quality-of-life features are all welcome.

## Before you start: scope

This is intentionally a *demo*. The booth-only layer from the original — device gating, OAuth sign-in, prize tracking, and admin tooling — has been removed on purpose. PRs that re-add that layer are out of scope. Think "make the demo clearer, more correct, or easier to run," not "turn it back into the booth build."

For anything non-trivial, please open an issue first so we can align before you invest time.

## Local setup

The full quickstart is in the [README](README.md#quickstart). In short:

```bash
cp .env.example .env            # add your Deepgram key
python3 -m venv .venv && source .venv/bin/activate
pip install -r brain/requirements.txt
npm install
npm run dev                     # brain on :8000, client on :5173
```

You'll need a free [Deepgram API key](https://console.deepgram.com/signup) (Member+ so it can mint tokens). An Anthropic key is optional — it powers turn scoring.

## How it's organized

[ARCHITECTURE.md](ARCHITECTURE.md) is the deep dive. The short version:

- `brain/` — the Python game brain (FastAPI). [`agents.py`](brain/agents.py) is the source of truth for prompts, voices, and functions; [`session.py`](brain/session.py) holds the game logic.
- `client/` — the Vite frontend that holds the Deepgram audio session.

## Coding guidelines

- **Match the surrounding code.** Follow the existing naming, structure, and comment style in the file you're editing.
- **Keep spoken lines TTS-safe.** Anything an agent says aloud must avoid em/en dashes, markdown, emojis, and stage directions — they get read literally or make the TTS stumble. See `VOICE_STYLE` and `speak_safe()` in [`brain/agents.py`](brain/agents.py), and Deepgram's [voice-prompting guide](https://developers.deepgram.com/docs/prompting-voice-agents).
- **Keep game logic in the brain.** The client renders UI and operates the socket; rules live in `session.py`.
- **Never commit secrets.** `.env`, API keys, and local `*.db` files are git-ignored — keep it that way.

## Testing your change

There's no automated game test, so exercise it by hand:

1. Run `npm run dev` and play through the heist you touched — confirm both a **win** and a **loss** resolve cleanly.
2. If you changed a prompt or voice, listen to it: does it sound natural, and does the function actually fire?
3. `npm run build` must succeed (CI runs this on every PR).

## Submitting a PR

- Branch off `main`, keep the change focused, and fill out the PR template.
- Describe **what** you changed, **why**, and **how** you tested it.
- CI will build the client and import the brain — make sure it's green.

## Questions

For "how do I build X with Deepgram" questions, the [Deepgram Discord](https://discord.gg/deepgram) is the fastest place to get help.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
