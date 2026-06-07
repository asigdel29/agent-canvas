# agent-canvas

[![ci](https://github.com/asigdel29/agent-canvas/actions/workflows/ci.yml/badge.svg)](https://github.com/asigdel29/agent-canvas/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> A self-hostable, multiplayer infinite-canvas platform for running cloud AI agents.

Drop AI agents onto an infinite canvas, wire them to MCP servers, a headless
browser, and a sandboxed Linux desktop, and watch them work in real time over
Server-Sent Events. Destructive tool calls pause for one-click operator
approval. Bring your own model key — Anthropic (Claude) or any OpenAI-compatible
endpoint. The whole stack runs as one self-hostable service.

## What it is

- **Frontend (`apps/canvas`)** — a React + Vite single-page app. Agents are
  cards on a **custom, dependency-free infinite canvas** (`src/canvas/`):
  pan, zoom, multi-select, snapping, density, and localStorage-persisted
  layout. No heavyweight canvas library; the canvas bundle is ~12 kB.
- **Backend (`apps/orchestrator`)** — a Node HTTP service that runs the agent
  loop, gates destructive tools behind approvals, signs auth tokens, talks to
  model providers, and keeps a Postgres audit trail. Security-critical work
  (OAuth secret, SSRF-checked model calls, approvals, audit) stays here.
- Single-origin by default (the orchestrator serves the built canvas), or split
  (canvas on a CDN, orchestrator on a host) — see [Deploy](#deploy).

## Project map

| Path | Purpose |
| --- | --- |
| `apps/canvas` | React/Vite SPA: the canvas client. |
| `apps/canvas/src/canvas` | The custom infinite canvas (store, view, card, model). |
| `apps/canvas/src/agent` | Agent modal, API client, record→card mapping, density. |
| `apps/canvas/src/auth` | Sign-in screen (GitHub or open mode). |
| `apps/canvas/src/settings` | BYOK key entry (in-memory) + tokens/webhooks. |
| `apps/orchestrator` | Backend service. |
| `apps/orchestrator/handlers` | One file per `/api/*` route (see `handlers/_router.ts`). |
| `apps/orchestrator/src/agents` | Run loop, model clients, providers, agent store. |
| `apps/orchestrator/src/auth` | JWT, sessions, SSE tokens. |
| `apps/orchestrator/src/postgres/migrations` | Numbered SQL migrations. |
| `packages/orchestrator-types` | Shared event/command types. |
| `packages/connector-core` | Connector (MCP/OAuth) primitives. |
| `packages/sdk-js` | Public JS SDK for the API. |
| `docs/` | Operator guide and architecture/design docs. |

## Quickstart

Requires [Node](https://nodejs.org) >= 22. Postgres is optional (without
`DATABASE_URL` the orchestrator runs in-memory; state is lost on restart).

```sh
git clone https://github.com/asigdel29/agent-canvas
cd agent-canvas
./scripts/setup.sh          # installs deps, writes ./.env with random secrets, builds, migrates
```

Then edit `./.env` (at least pick an [auth mode](#auth-modes)) and run:

```sh
npm run dev                 # hot-reloading canvas (:5173) + orchestrator (:3000)
npm start                   # production: one server on http://localhost:3000
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Canvas (:5173) + orchestrator (:3000) with hot reload. |
| `npm start` | Single production server on :3000. |
| `npm run build` | Build every workspace. |
| `npm run typecheck` | `tsc -b` across all workspaces. |
| `npm test` | Run the unit/integration suite (vitest). |
| `npm run e2e --workspace=@agent-canvas/canvas` | Playwright canvas tests. |
| `npm run migrate` | Apply Postgres migrations. |
| `npm run setup:env` | (Re)generate `./.env` with fresh secrets. |

## Auth modes

Set `AUTH_MODE` in `./.env`:

- `open` — teammates join with just a display name. No GitHub app. Drops
  per-workspace isolation; run it behind a trusted network boundary.
- `github` (default) — create a [GitHub OAuth app](https://github.com/settings/developers),
  then set `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`, plus
  `CANVAS_ORIGIN` and `PUBLIC_ORCHESTRATOR_ORIGIN`. The app's **Authorization
  callback URL** must equal `${PUBLIC_ORCHESTRATOR_ORIGIN}/api/auth/github/callback`
  (locally `http://localhost:3000/api/auth/github/callback`, homepage
  `http://localhost:5173`).

## AI keys (BYOK)

There is no AI-provider login. Each user brings a key in Settings; it is held in
browser **memory only** (never written to disk/Web Storage) and sent per-request.
Two providers, chosen per agent in the New-agent dialog:

- **Anthropic** — native Claude models. Key in Settings, or `ANTHROPIC_API_KEY`
  as a shared server fallback.
- **OpenAI-compatible** — any `/chat/completions` endpoint by base URL: OpenAI,
  Gemini's OpenAI surface, Groq, OpenRouter, Together, or a local server.
  Key in Settings, or `OPENAI_API_KEY` fallback. The orchestrator SSRF-checks the
  base URL; to allow a local `http://127.0.0.1` server set
  `MODEL_BASE_URL_ALLOW_HTTP=true` and `MODEL_BASE_URL_ALLOW_PRIVATE=true` (dev
  only).

Computer-use needs `E2B_API_KEY` and is Anthropic-only.

## Architecture

```
browser (apps/canvas)  ──HTTP──>  orchestrator (apps/orchestrator)
   custom canvas         /api/*        run loop · approvals · vault
   BYOK key (in-memory)              model clients (Anthropic | OpenAI-compatible)
        ▲                                   │
        └────────── SSE /api/sync/:room ────┘   (live run events)
                                            └──> Postgres (audit, agents)
```

- Agents are created via `POST /api/agents` and run via `POST /api/agents/runs`;
  events stream back over SSE and update cards on the canvas.
- The run loop drives one `createMessage` per turn through a provider-agnostic
  model client; destructive tools block on an approval row.
- See [`docs/designs/agent-canvas.md`](docs/designs/agent-canvas.md) for the deep
  architecture and [`docs/operator-guide.md`](docs/operator-guide.md) for a tour.

## Deploy

### Single service (simplest)

One Railway service plus a Postgres plugin ([`railway.json`](railway.json)) serves
both the API and the built canvas from one origin — no CORS:

1. Create a Railway project from this repo and add the **Postgres** plugin.
2. In the service **Variables**, set `DATABASE_URL=${{Postgres.DATABASE_URL}}`,
   the four secrets (`JWT_SECRET`, `SSE_TOKEN_SECRET`, `AUTH_STATE_SECRET`,
   `VAULT_KEY` — `openssl rand -hex 32` each), and `AUTH_MODE`.
3. Deploy. Railway builds, migrates, starts the server, and health-checks
   `/api/health`.

A CI workflow can deploy on push to `main` — set repo variable
`RAILWAY_DEPLOY=true` and secret `RAILWAY_TOKEN` (see
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)).

### Split: canvas on Vercel + orchestrator on Railway (lowest cost)

Serve the static canvas from Vercel's CDN and run the orchestrator on Railway.
Two origins, so CORS is configured explicitly.

1. **Railway** — as above, plus `PUBLIC_ORCHESTRATOR_ORIGIN` = the Railway URL,
   and `CANVAS_ORIGIN` + `ALLOWED_ORIGINS` = the Vercel canvas URL.
2. **Vercel** — import the repo; it uses [`vercel.json`](vercel.json) to build
   only `apps/canvas`. Set the Production env var `VITE_ORCHESTRATOR_URL` to the
   Railway URL (see [`apps/canvas/src/config.ts`](apps/canvas/src/config.ts)).
3. **GitHub OAuth app** — Homepage = the Vercel URL; callback =
   `<railway-url>/api/auth/github/callback`.

Deploy Railway first, then Vercel with `VITE_ORCHESTRATOR_URL`, then set Railway's
`CANVAS_ORIGIN`/`ALLOWED_ORIGINS` to the Vercel URL and restart.

## Configuration

Every variable is documented in [`.env.example`](.env.example). Only
`DATABASE_URL` and the four auto-generated secrets are required to boot. Agent
contributors should also read [`AGENTS.md`](AGENTS.md).

## Maintainers

[@asigdel29](https://github.com/asigdel29)

## Contributing

PRs accepted — see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © asigdel29
