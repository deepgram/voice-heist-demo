# Deepgram Voice Heist Demo

Talk an AI gatekeeper into bending its one rule. A browser voice game built on the
Deepgram Voice Agent API: low-latency audio straight from the browser, a Python
"brain" for the game logic, and a per-turn scoring judge.

This is the public demo of the Voice Heist booth game: the same game and UI, with the
booth authentication layer (device gate, player sign-in, OAuth, admin portal) removed
so you can clone it, run it, and deploy your own in minutes. The prize-based
experience stays exclusive to the Deepgram booth.

## How it works

- The browser holds the low-latency audio WebSocket straight to Deepgram (via the
  `@deepgram/agents` SDK), plus a small control WebSocket to the brain.
- The brain (FastAPI) owns the game: the multi-agent handoff (Host to Briefer to one
  of four gatekeepers via `UpdatePrompt` and `UpdateSpeak`), function-call verdicts
  (`grant_request` and `deny_request`), fail-soft per-turn scoring, and a SQLite data
  model. It also mints a short-lived Deepgram token so the API key never reaches the
  browser.

The four heists are The Order, The Refund, The Receptionist, and The List.

## Run it

You need a free Deepgram key ($200 credit, no card: https://console.deepgram.com/signup).
It must have at least Member permissions so it can mint grant tokens. An Anthropic key
is optional; it powers the per-turn scoring judge.

```bash
git clone https://github.com/deepgram/voice-heist-demo
cd voice-heist-demo
cp .env.example .env                       # paste your keys

python3 -m venv .venv && source .venv/bin/activate
pip install -r brain/requirements.txt
npm install

npm run dev                                # brain on :8000, client on :5173
```

Open the URL Vite prints (default http://localhost:5173), click "Connect & Talk",
allow the mic, and start talking. Keep your keys server-side: the brain holds
`DEEPGRAM_API_KEY` and hands the browser only a short-lived token.

## Deploy your own

The included `Dockerfile` builds the client and serves everything from the Python
brain on a single port. Set `DEEPGRAM_API_KEY` (and optionally `ANTHROPIC_API_KEY`)
as environment variables on your host; if you keep the optional sign-up, also set
`VH_SIGNING_SECRET` to a long random string so sign-in cookies survive restarts.
Never commit them.

## Layout

```
brain/
  app.py        FastAPI: /api/deepgram-token, /api/auth/*, /ws/brain, /api/leaderboard, static
  auth.py       optional identity: name+email sign-up -> code + codename, email/code sign-in
  agents.py     the four gatekeepers plus Host and Briefer: prompts, voices, Settings
  session.py    per-connection game brain: routing, handoff, verdict
  judge.py      fail-soft per-turn scorer (WARM or WEAK; the win is the gatekeeper's grant)
  store.py      SQLite (players, plays, leaderboard)
  schema.sql
client/
  index.html    the game
  src/game.js   the voice loop (Deepgram @deepgram/agents SDK)
  src/ui.js, voice.js, sfx.js, leaderboard.js, auth.js, main.js
```

## What is different from the booth build

Removed for the public demo: the device gate (`vh_gate`), the "sign in with any
account" OAuth/OIDC flow, and the admin portal. Anyone can play immediately as a
fresh anonymous player.

What's kept is a lightweight, optional identity: sign up with a name + email to get
a short code and a public codename ("Crimson Fox 42"), then sign in later with your
email or that code to keep your standings. The name and email are stored only to
recognize a returning player — the public leaderboard shows the codename, never your
name or email.

## License

MIT. See [LICENSE](LICENSE).
