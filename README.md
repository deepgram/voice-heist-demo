# Voice Heist Demo

**Talk an AI gatekeeper into bending its one rule, by voice, in your browser.** Sweet-talk a goofy pizza bot into a free pie, out-argue a deadpan bouncer, slip past a Kafkaesque phone tree. A complete, low-latency voice-agent app built on the [Deepgram Voice Agent API](https://developers.deepgram.com/docs/voice-agent).

> [!TIP]
> **Play it in two minutes.** Grab a free Deepgram API key ($200 in credit, no card), run `npm run dev`, and start talking. [Get a key](https://console.deepgram.com/signup)

![Voice Heist gameplay](assets/gameplay.svg)

This is the public version of the Voice Heist booth game: the same gameplay, voice loop, scoring, and leaderboard, with the booth-only layer (device gate, OAuth, prize tracking, admin tooling) removed so you can clone, run, and deploy your own in minutes. The prize-based experience stays exclusive to the Deepgram booth.

## What you'll learn

A real, end-to-end pattern for shipping a voice agent on the Deepgram Voice Agent API:

* Low-latency browser audio with the `@deepgram/agents` SDK
* Multi-agent orchestration and handoffs over a single WebSocket
* Function calling that drives real outcomes (`grant_request` / `deny_request`)
* Turn-by-turn conversation scoring that fails soft
* A privacy-preserving identity: codenames on the board, never PII
* Short-lived token minting, so your API key never reaches the browser

## The heists

Each gatekeeper guards one rule. You get a few turns to talk it into bending, by being believable, not by bullying.

| Heist | Gatekeeper | Your goal |
| --- | --- | --- |
| The Order | Tony's Pizza Agent (goofy) | Get the pizza for free |
| The Refund | StreamFlix Support (relentlessly upbeat) | Get your money back |
| The Receptionist | Globex Receptionist (Kafkaesque) | Reach a human |
| The List | Vince, the Bouncer (deadpan) | Get into the club |

## Architecture

The browser is the hub: it holds the low-latency audio WebSocket straight to Deepgram and a separate JSON control WebSocket to the Python brain. No audio passes through your server, and the Deepgram API key never reaches the browser (the brain mints a short-lived token).

```text
Browser   (Vite client + @deepgram/agents SDK)
│
├── audio WebSocket   ->  Deepgram Voice Agent API   (managed, in-pipeline)
│   ├── Flux STT
│   ├── LLM (think)
│   └── Aura-2 TTS
│
└── control WebSocket ->  Game brain   (FastAPI)
    ├── agents   Host, Briefer, 4 gatekeepers
    ├── judge    per-turn scoring (fail-soft)
    └── store    SQLite: players, plays, leaderboard
```

## Quickstart

You need a free Deepgram key ($200 credit, no card) at [console.deepgram.com/signup](https://console.deepgram.com/signup), with at least Member permissions so it can mint tokens. An Anthropic key is optional; it powers the conversation scoring judge.

```bash
git clone https://github.com/deepgram/voice-heist-demo
cd voice-heist-demo
cp .env.example .env                        # paste your keys

python3 -m venv .venv && source .venv/bin/activate
pip install -r brain/requirements.txt
npm install

npm run dev                                 # brain on :8000, client on :5173
```

Open the URL Vite prints (typically http://localhost:5173), click **Connect & Talk**, allow the mic, and start talking.

## Optional player accounts

Voice Heist can be played anonymously, with no account. Players who choose to register can:

* Preserve scores across sessions
* Appear on the leaderboard under a generated codename
* Return later with either their email address or a generated code

Examples of generated codenames: Crimson Fox 42, Silver Raven 17, Midnight Wolf 08. Only codenames are shown publicly; names and email addresses are used solely for account recovery and never appear on the leaderboard.

## Deployment

A Dockerfile is included for production deployment. The container builds the frontend and serves the complete application through the FastAPI backend on a single port.

Required:

```bash
DEEPGRAM_API_KEY=<your-key>
```

Optional:

```bash
ANTHROPIC_API_KEY=<your-key>
VH_SIGNING_SECRET=<long-random-secret>
```

If player sign-in is enabled, set `VH_SIGNING_SECRET` so authentication cookies stay valid across restarts. Never commit secrets or API keys.

## Project structure

<details>
<summary>Files and what they do</summary>

```text
brain/
├── app.py           # FastAPI application and API endpoints
├── auth.py          # Optional player registration and sign-in
├── agents.py        # Agent definitions, prompts, voices, and settings
├── session.py       # Game orchestration and agent routing
├── judge.py         # Conversation scoring engine
├── store.py         # SQLite persistence layer
└── schema.sql

client/
├── index.html       # Main application
└── src/
    ├── game.js      # Voice interaction loop
    ├── voice.js
    ├── ui.js
    ├── sfx.js
    ├── leaderboard.js
    ├── auth.js
    ├── identity.css
    └── main.js
```
</details>

## Security

Voice Heist follows a server-side credential model:

* Deepgram API keys remain on the backend
* Browsers receive only short-lived access tokens
* Authentication cookies are signed and validated server-side
* No long-lived credentials are exposed to client applications

## License

MIT. See the [LICENSE](LICENSE) file.

---

<p align="center">
  Built with the <a href="https://developers.deepgram.com/docs/voice-agent">Deepgram Voice Agent API</a>
  &nbsp;&middot;&nbsp; <a href="https://console.deepgram.com/signup">Get a free key</a>
  &nbsp;&middot;&nbsp; <a href="https://developers.deepgram.com/">Docs</a>
  <br>
  Built something with it? Give the repo a star.
</p>
