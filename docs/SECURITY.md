# Security Policy

Voice Heist is a public demo of a Deepgram Voice Agent application. We take security seriously and appreciate reports that help keep it — and the developers who learn from it — safe.

## Reporting a vulnerability

**Please do not open a public issue for security problems.** Instead, use either:

- **GitHub private advisory** — open the repo's [Security tab](https://github.com/deepgram/voice-heist-demo/security/advisories) and click **Report a vulnerability**. This keeps the report private until a fix ships.
- **Email** — write to **security@deepgram.com** with steps to reproduce and the impact you've found.

We'll acknowledge your report within a few business days and keep you updated as we work on a fix. Please give us a reasonable window to address the issue before any public disclosure.

## The credential model (by design)

Voice Heist is built around keeping secrets on the server:

- Your `DEEPGRAM_API_KEY` stays on the backend. The browser receives only a **short-lived (300s) access token**, minted per session via Deepgram's `/v1/auth/grant` — see [`brain/app.py`](../brain/app.py).
- **No audio passes through this server.** The audio stream is direct between the browser and Deepgram.
- Optional sign-in cookies are **signed and validated server-side** with `VH_SIGNING_SECRET` — see [`brain/auth.py`](../brain/auth.py).
- The public leaderboard shows only a derived **codename**, never a name or email.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full picture.

## Known, intentional behavior (not a vulnerability)

These are documented trade-offs for a runnable demo, not bugs:

- **Running without `VH_SIGNING_SECRET`** falls back to an ephemeral, per-process dev secret. That's fine for local play, but it **must** be set in production so sign-in cookies survive restarts and can't be forged — see [`.env.example`](../.env.example).
- **Running without `ANTHROPIC_API_KEY`** disables graded scoring (every turn scores the minimum). The game still runs.
- Local `.env` files and the SQLite database (`*.db`) are git-ignored. Never commit secrets or API keys.

## Scope

This policy covers the code in this repository. Vulnerabilities in the Deepgram platform itself should be reported to **security@deepgram.com**.
