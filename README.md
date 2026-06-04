# agent-canvas

**An infinite canvas for running Claude-driven agents with computer use, browser use, and MCP servers — self-hosted for your team.**

Drop agents on an infinite spatial workspace, wire them to MCP servers + a headless browser + a sandboxed Linux desktop, and watch them work in real time. Screenshots stream into each agent shape as it runs. Destructive tool calls pause for one-click operator approval. Built on the [tldraw SDK](https://tldraw.dev).

```
  +-------------------------------------------------------------+
  |  ◇ workspace                                       ⚙  Share |
  +-------+-----------------------------------------+-----------+
  |       |   ◯ Hand   ↖ Select  ✦ Agent   ⋯       |  Inspector |
  | Runs  |                                         |  ─────────  |
  | • triage live  |                                |  Run id    |
  | • search       |   [ AgentShape: web research ] |  run_…      |
  |       |        |    computer · browser · 2 MCP  |  Recent     |
  |       |                                         |  #12 progress|
  +-------+-----------------------------------------+-----------+
```

This is a single deployable service: one Node process serves the canvas, the API, and the realtime multiplayer stream on one origin. Bring your own Claude key — keys live in each user's browser.

## Self-host in five commands

```bash
git clone https://github.com/asigdel29/agent-canvas && cd agent-canvas
./scripts/setup.sh          # installs deps, generates ./.env secrets, builds, migrates
#   …edit ./.env: set DATABASE_URL, and pick an auth mode (see below)…
npm run migrate             # only needed if DATABASE_URL wasn't set during setup
npm start                   # one server: canvas + API + multiplayer on :3000
```

Open <http://localhost:3000>, sign in, paste your Claude key in Settings (⚙), and create an agent.

`./scripts/setup.sh` is the only setup step — everything after it is just filling in `./.env`. See [`.env.example`](./.env.example) for every variable; only `DATABASE_URL` plus the four auto-generated secrets are required to boot.

### Auth: pick one

- **`AUTH_MODE=open`** — trusted internal teams. Teammates join with just a display name, no GitHub app, no external login. Open mode drops per-workspace isolation, so run it behind your own network boundary. Everyone who opens the same room URL collaborates live.
- **`AUTH_MODE=github`** (default) — set `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` from a [GitHub OAuth app](https://github.com/settings/developers) (callback `<your-origin>/api/auth/github/callback`).

### AI keys are bring-your-own

There is no AI-provider login. Each user pastes their own Claude key in the Settings drawer; it stays in their browser and travels per-request. Optionally set `ANTHROPIC_API_KEY` in `./.env` as a shared server-side fallback. Computer-use needs an `E2B_API_KEY` (also pasteable per user).

## Deploy on Railway

The repo ships a [`railway.json`](./railway.json) — the whole stack is one Railway service plus a Postgres plugin:

1. Create a Railway project from this repo.
2. Add the **Postgres** plugin.
3. In the service **Variables**, set:
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}`
   - `JWT_SECRET`, `SSE_TOKEN_SECRET`, `AUTH_STATE_SECRET`, `VAULT_KEY` (run `openssl rand -hex 32` for each)
   - `AUTH_MODE=open` (or `github` + the two OAuth vars)
4. Deploy. Railway builds, runs migrations (`preDeployCommand`), starts the server, and health-checks `/api/health`.

A persistent container is exactly what the realtime layer wants: the single process holds one Postgres `LISTEN/NOTIFY` connection open and streams Server-Sent Events to every connected client — no extra infrastructure.

## What this is

| You want… | agent-canvas gives you |
|---|---|
| Claude with computer use | E2B Desktop sandbox + the `computer_20241022` tool. Screenshots stream into the canvas shape. |
| Claude with browser use | Headless Playwright Chromium. Ten tools: navigate, click, type, screenshot, etc. |
| Claude calling your MCP servers | Per-agent list, trusted / untrusted gating, automatic approval pauses on untrusted tool calls. |
| A team working together | Each agent is a shape on an infinite tldraw canvas. Pan, zoom, layer, comment — live for everyone in the room. |
| A real audit trail | Postgres event log + per-tool-call audit row. Pause / resume / cancel any run. |

Not a fork of tldraw — this repo depends on `tldraw@5.x` from npm. The tldraw SDK does the canvas + multiplayer transport; this repo adds the agent orchestration layer, the connector framework, and the canvas app on top.

## Repo layout

```
agent-canvas/
├── apps/
│   ├── canvas/              ← Vite + React + tldraw, the operator UI
│   └── orchestrator/        ← the agent runtime + HTTP/SSE server
│       └── scripts/server.ts  ← the single-process production server
├── packages/
│   ├── orchestrator-types/  ← shared types (no runtime)
│   ├── connector-core/      ← connector interface + framework
│   └── sdk-js/              ← TypeScript REST client
├── scripts/setup.sh         ← one-command setup
├── railway.json             ← Railway deploy config
└── docs/
    ├── operator-guide.md    ← five-minute tutorial
    └── designs/agent-canvas.md
```

## Local development

```bash
./scripts/setup.sh
npm run dev      # hot-reloading: orchestrator on :3000, canvas on :5173
```

In dev the canvas runs on :5173 and talks to the orchestrator on :3000; the production `npm start` serves both from one origin.

## Validation

```bash
npm run typecheck   # tsc -b across all packages
npm test            # vitest
npm run build       # all packages + canvas
```

## Stack

- [Claude](https://www.anthropic.com/claude) — the agent model. Sonnet 4.6 default, Opus + Haiku selectable per agent.
- [tldraw](https://tldraw.dev) — the canvas.
- [E2B Desktop](https://e2b.dev) — sandboxed Linux for computer-use.
- [Playwright](https://playwright.dev) — headless Chromium for browser-use.
- [MCP](https://modelcontextprotocol.io) — the Model Context Protocol for tool servers.
- [Postgres](https://www.postgresql.org) — event log + agent persistence + `LISTEN/NOTIFY` multiplayer.
- [Railway](https://railway.app) — single-service hosting.

## License

MIT — see [LICENSE](./LICENSE).
