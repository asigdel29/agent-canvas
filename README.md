# agent-canvas

[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg)](https://github.com/RichardLitt/standard-readme)
[![ci](https://github.com/asigdel29/agent-canvas/actions/workflows/ci.yml/badge.svg)](https://github.com/asigdel29/agent-canvas/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Multiplayer infinite-canvas platform for running cloud AI agents, built on tldraw.

Drop Claude-driven agents onto an infinite canvas, wire them to MCP servers, a headless browser, and a sandboxed Linux desktop, and watch them work in real time. Destructive tool calls pause for one-click operator approval. The whole stack runs as one self-hostable service — bring your own Claude key.

```
  +-------------------------------------------------------------+
  |  workspace                                          Share   |
  +-------+-----------------------------------------+-----------+
  | Runs  |   Hand   Select   Agent                 |  Inspector|
  | live  |        [ AgentShape: web research ]     |  run_...  |
  |       |         computer · browser · 2 MCP      |  #12 ...  |
  +-------+-----------------------------------------+-----------+
```

## Table of Contents

- [Background](#background)
- [Install](#install)
- [Usage](#usage)
- [Deploy](#deploy)
- [Configuration](#configuration)
- [Maintainers](#maintainers)
- [Contributing](#contributing)
- [License](#license)

## Background

agent-canvas gives an internal team a shared, spatial place to run AI agents. Each agent is a shape on a [tldraw](https://tldraw.dev) canvas; everyone in a room sees runs stream in live over Server-Sent Events. The backend orchestrates agents, gates destructive tool calls, and keeps a Postgres audit trail.

It is **not** a fork of tldraw (it depends on `tldraw@5.x` from npm) and **not** a hosted product — you deploy your own instance and each user supplies their own Claude key.

It runs as a single Node process serving the canvas, the API, and the realtime stream on one origin, which makes it a natural fit for a platform like [Railway](https://railway.app).

## Install

Requires [Node](https://nodejs.org) >= 22 and (for persistence) a Postgres database.

```sh
git clone https://github.com/asigdel29/agent-canvas
cd agent-canvas
./scripts/setup.sh
```

`setup.sh` installs dependencies, generates `./.env` with random secrets, builds every workspace, and runs database migrations when a `DATABASE_URL` is set. Then open `./.env` and set `DATABASE_URL` plus an [auth mode](#usage).

## Usage

```sh
npm start          # production: one server on http://localhost:3000
npm run dev        # development: hot-reloading canvas + orchestrator
```

Open the server URL, choose an auth mode, paste your Claude key in Settings, and create an agent.

### Auth modes

Set `AUTH_MODE` in `./.env`:

- `open` — teammates join with just a display name. No GitHub app, no external login. Open mode drops per-workspace isolation, so run it behind a trusted network boundary.
- `github` (default) — create a [GitHub OAuth app](https://github.com/settings/developers), then set `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`, plus `CANVAS_ORIGIN` and `PUBLIC_ORCHESTRATOR_ORIGIN`. The app's **Authorization callback URL** must equal `${PUBLIC_ORCHESTRATOR_ORIGIN}/api/auth/github/callback`. For local dev that is `http://localhost:3000/api/auth/github/callback`, with Homepage URL `http://localhost:5173`.

### AI keys

There is no AI-provider login — each user brings their own key in Settings; it stays in their browser and travels per-request. Two providers are supported per agent (chosen in the New agent dialog):

- **Anthropic** — native Claude models. Paste a Claude key in Settings, or set `ANTHROPIC_API_KEY` as a shared server-side fallback.
- **OpenAI-compatible** — any `/chat/completions` endpoint, selected by a base URL: OpenAI, Gemini's OpenAI surface, Groq, OpenRouter, Together, or a local server (LM Studio, Ollama). Paste an OpenAI-compatible key in Settings, or set `OPENAI_API_KEY` as the fallback. The orchestrator SSRF-checks the base URL; to allow a local `http://127.0.0.1` server set `MODEL_BASE_URL_ALLOW_HTTP=true` and `MODEL_BASE_URL_ALLOW_PRIVATE=true` (dev only).

Computer-use needs an `E2B_API_KEY` (also pasteable per user) and is available on the Anthropic provider only.

## Deploy

One Railway service plus a Postgres plugin (config in [`railway.json`](railway.json)):

1. Create a Railway project from this repo and add the **Postgres** plugin.
2. In the service **Variables**, set `DATABASE_URL=${{Postgres.DATABASE_URL}}`, the four secrets (`JWT_SECRET`, `SSE_TOKEN_SECRET`, `AUTH_STATE_SECRET`, `VAULT_KEY` — `openssl rand -hex 32` each), and `AUTH_MODE`.
3. Deploy. Railway builds, runs migrations, starts the server, and health-checks `/api/health`.

A CI workflow can also deploy on push to `main` — set the repo variable `RAILWAY_DEPLOY=true` and the secret `RAILWAY_TOKEN` (see [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)).

## Configuration

Every variable is documented in [`.env.example`](.env.example). Only `DATABASE_URL` and the four auto-generated secrets are required to boot.

For a five-minute product tour, see [docs/operator-guide.md](docs/operator-guide.md). For the architecture, see [docs/designs/agent-canvas.md](docs/designs/agent-canvas.md).

## Maintainers

[@asigdel29](https://github.com/asigdel29)

## Contributing

PRs accepted — see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through [SECURITY.md](SECURITY.md).

This README follows the [standard-readme](https://github.com/RichardLitt/standard-readme) spec.

## License

[MIT](LICENSE) © asigdel29
