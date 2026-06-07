# agent-canvas

[![ci](https://github.com/asigdel29/agent-canvas/actions/workflows/ci.yml/badge.svg)](https://github.com/asigdel29/agent-canvas/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

> A shared, zoomable board where you run AI agents and watch them work.

agent-canvas is an app you run yourself. You drop AI agents onto a big zoomable
board, give each one a job, and watch it work — live. Everyone looking at the
same board sees the same thing at the same time. You use your own AI key, so you
stay in control of cost and data.

## What it does

- **A board, not a chat.** Each agent is a card you can move around an endless,
  zoomable board.
- **Agents that do real work.** Give an agent your own tools (called MCP
  servers), a web browser, or a safe throwaway Linux desktop.
- **You're in the loop.** Anything risky an agent tries to do stops and waits for
  you to approve it.
- **Your key, any model.** Bring a key for Claude, or for OpenAI / Gemini / Groq
  / OpenRouter / a local model — whichever you like. The key stays in your browser.
- **A clear record.** Every step an agent takes is saved so you can look back.

## Run it on your computer

You need [Node](https://nodejs.org) version 22 or newer. A database is optional —
without one, everything works but is forgotten when you stop the app.

```sh
git clone https://github.com/asigdel29/agent-canvas
cd agent-canvas
./scripts/setup.sh     # installs everything and creates a settings file for you
```

Then start it:

```sh
npm run dev            # for development: reloads as you change things
npm start              # for real use: one server at http://localhost:3000
```

Open the address it prints, and you're in.

## Using it

1. **Sign in.** Either with GitHub, or — if you turned that off — by just typing a
   name.
2. **Add your AI key.** Open Settings and paste your key (for example a Claude
   key, or an OpenAI-style key). It stays in your browser only.
3. **Make an agent.** Click "New agent", give it a name and a job, pick a model,
   and turn on any tools you want it to use.
4. **Run it and watch.** The agent's card updates live as it works. If it tries
   something risky, you'll get a one-click approve/deny.

## Put it online

You can host it two ways.

### The simple way — one server

One server does everything (the board and the behind-the-scenes part together).

1. Make a project on [Railway](https://railway.app) from this repo and add the
   **Postgres** database.
2. In the project's **Variables**, set `DATABASE_URL=${{Postgres.DATABASE_URL}}`,
   the four secret values (run `openssl rand -hex 32` for each of `JWT_SECRET`,
   `SSE_TOKEN_SECRET`, `AUTH_STATE_SECRET`, `VAULT_KEY`), and how people sign in
   (`AUTH_MODE`).
3. Deploy. It builds, sets up the database, starts, and checks itself at
   `/api/health`.

### The cheaper way — board on a CDN, server on its own

Put the board on [Vercel](https://vercel.com)'s fast free network and the server
on Railway. Because they live at two web addresses, you tell the server which
address the board is allowed to talk to.

1. **Server (Railway):** same as above, and also set `PUBLIC_ORCHESTRATOR_ORIGIN`
   to the Railway address, and `CANVAS_ORIGIN` + `ALLOWED_ORIGINS` to the Vercel
   address.
2. **Board (Vercel):** import the repo (it uses [`vercel.json`](vercel.json)).
   Set `VITE_ORCHESTRATOR_URL` to the Railway address, then deploy.
3. **GitHub sign-in:** make a GitHub OAuth app with the homepage set to the Vercel
   address and the callback set to `<railway-address>/api/auth/github/callback`.

Deploy the server first, then the board, then point the server's `CANVAS_ORIGIN`
and `ALLOWED_ORIGINS` at the board's address.

## Settings

Every setting is listed and explained in [`.env.example`](.env.example). Only the
database address and the four secret values are required to start. Working on the
code? [`AGENTS.md`](AGENTS.md) has the commands and conventions.

## Credits

Built with, and thankful for, the work of others:

- **[tldraw](https://tldraw.dev)** — the board's feel and the way you pan, zoom,
  and drag were built using tldraw as the reference (tldraw itself is no longer
  part of the app).
- **[oat](https://github.com/knadh/oat)** — inspiration for keeping the interface
  tiny and free of heavy dependencies.
- **[React](https://react.dev)** and **[Vite](https://vite.dev)** — the board.
- **[PostgreSQL](https://www.postgresql.org)** — the saved record.
- **[Model Context Protocol](https://modelcontextprotocol.io)** — how agents plug
  into your tools.
- **[Playwright](https://playwright.dev)** — the agents' web browser, and the tests.
- **[E2B](https://e2b.dev)** — the safe throwaway Linux desktops.
- **[Anthropic](https://www.anthropic.com)** and **[OpenAI](https://openai.com)**
  (and OpenAI-compatible providers) — the models the agents use.
- Hosting: **[Railway](https://railway.app)** and **[Vercel](https://vercel.com)**.

## License

Copyright (C) 2026 asigdel29.

agent-canvas is free software under the **GNU Affero General Public License,
version 3** ([AGPL-3.0](LICENSE)). You're free to use and change it. If you run a
changed version as a service for others, you must share your changes under the
same license.

## Maintainer & contributing

Maintained by [@asigdel29](https://github.com/asigdel29). Pull requests are
welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem,
see [SECURITY.md](SECURITY.md).
