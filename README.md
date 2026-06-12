# Deepgram Voice Heist Demo

A voice-first AI security challenge built with the Deepgram Voice Agent API.

In Voice Heist, players attempt to persuade an AI gatekeeper to break its single rule. Each scenario presents a different challenge that tests conversational strategy, reasoning, and persuasion skills through real-time voice interactions.

This repository contains the public version of the Voice Heist experience. The core gameplay, voice interactions, and scoring system are included, while event-specific components such as booth authentication, device restrictions, prize tracking, and administrative tooling have been removed.

## Overview

Voice Heist demonstrates how to build low-latency, browser-based voice applications using the Deepgram Voice Agent API.

The application combines:

* Real-time browser audio streaming
* Dynamic multi-agent orchestration
* Function-calling based game outcomes
* Turn-by-turn conversation scoring
* Persistent leaderboards and player profiles
* Secure token-based authentication for browser clients

### Heists

Players can attempt one of four AI heists:

* **The Order**
* **The Refund**
* **The Receptionist**
* **The List**

Each gatekeeper follows a strict rule. The objective is to convince the agent to grant your request without violating its instructions.

## Architecture

The system consists of two primary components:

### Browser Client

The browser maintains:

* A direct low-latency voice connection to Deepgram using the `@deepgram/agents` SDK
* A lightweight control WebSocket connection to the game server
* Real-time game state, audio playback, and leaderboard interactions

### Game Brain

A FastAPI backend manages:

* Multi-agent orchestration
* Agent handoffs between Host, Briefer, and Gatekeepers
* Function-call based decisions (`grant_request` and `deny_request`)
* Turn-by-turn scoring and evaluation
* Player profiles and leaderboard data
* Short-lived Deepgram token generation

The Deepgram API key remains securely on the server and is never exposed to the browser.

## Prerequisites

You will need:

* A Deepgram account and API key
* Member-level permissions or higher to generate temporary access tokens

Create a free account:

[Deepgram Console Sign Up](https://console.deepgram.com/signup)

An Anthropic API key is optional and enables the conversation scoring judge.

## Getting Started

### Clone the Repository

```bash
git clone https://github.com/deepgram/voice-heist-demo
cd voice-heist-demo
```

### Configure Environment Variables

```bash
cp .env.example .env
```

Add your API credentials to the `.env` file.

### Install Dependencies

```bash
python3 -m venv .venv
source .venv/bin/activate

pip install -r brain/requirements.txt
npm install
```

### Start the Application

```bash
npm run dev
```

This starts:

* FastAPI backend on port `8000`
* Vite development server on port `5173`

Open the URL displayed by Vite (typically `http://localhost:5173`), select **Connect & Talk**, grant microphone access, and begin playing.

## Optional Player Accounts

Voice Heist can be played anonymously without creating an account.

Players who choose to register can:

* Preserve scores across sessions
* Appear on the leaderboard under a generated codename
* Return later using either their email address or a generated access code

Examples of generated codenames include:

* Crimson Fox 42
* Silver Raven 17
* Midnight Wolf 08

Only codenames are displayed publicly. Names and email addresses are used solely for account recovery and are never shown on the leaderboard.

## Deployment

A Dockerfile is included for production deployment.

The container builds the frontend and serves the complete application through the FastAPI backend using a single port.

### Required Environment Variables

```bash
DEEPGRAM_API_KEY=<your-key>
```

### Optional Environment Variables

```bash
ANTHROPIC_API_KEY=<your-key>
VH_SIGNING_SECRET=<long-random-secret>
```

If player sign-in is enabled, `VH_SIGNING_SECRET` should be configured to ensure authentication cookies remain valid across application restarts.

Never commit secrets or API keys to source control.

## Project Structure

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
    └── main.js
```

## Security

Voice Heist follows a server-side credential model:

* Deepgram API keys remain on the backend
* Browsers receive only short-lived access tokens
* Authentication cookies are signed and validated server-side
* No long-lived credentials are exposed to client applications

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.
