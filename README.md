# agent-canvas

**An infinite canvas for running Claude-driven agents with computer use, browser use, and MCP servers.**

Live: **<https://agent-canvas-ivory.vercel.app>**

Drop agents on an infinite spatial workspace, wire them to MCP servers + a headless browser + a sandboxed Linux desktop, and watch them work in real time. Screenshots stream into each agent shape as it runs. Destructive tool calls pause for one-click operator approval. Built on the [tldraw SDK](https://tldraw.dev).

```
  +-------------------------------------------------------------+
  |  ◇ workspace                            $0.00 / $50  ⚙  Share|
  +-------+-----------------------------------------+-----------+
  |       |   ◯ Hand   ↖ Select  ✦ Agent   ⋯       |  Inspector |
  | Runs  |                                         |  ─────────  |
  | • triage live  |                                |  Run id    |
  | • search       |   [ AgentShape: web research ] |  run_…      |
  |       |        |    computer · browser · 2 MCP  |  Recent     |
  |       |                                         |  #12 progress|
  +-------+-----------------------------------------+-----------+
```

## Sixty-second tour

1. **Sign in** with GitHub at <https://agent-canvas-ivory.vercel.app>.
2. **Set your Claude key** in the Settings drawer (⚙ in the top bar). Optional: E2B key for computer-use.
3. **Create an agent** from the toolbar's `Agent` tool. Pick capabilities (browser / computer / MCP servers).
4. **Hit Run** in the inspector. Watch events stream into the canvas and approve any destructive tool calls.

No credit card, no demo call, no company email. Bring your own keys; they live in the browser only.

See **[docs/operator-guide.md](./docs/operator-guide.md)** for a five-minute walkthrough with screenshots.

## What this is

| You want… | agent-canvas gives you |
|---|---|
| Claude with computer use | E2B Desktop sandbox + the `computer_20241022` tool. Screenshots stream into the canvas shape. |
| Claude with browser use | Headless Playwright Chromium. Ten tools: navigate, click, type, screenshot, etc. |
| Claude calling your MCP servers | Per-agent list, trusted / untrusted gating, automatic approval pauses on untrusted tool calls. |
| Multiple agents working at once | Each agent is a shape on an infinite tldraw canvas. Pan, zoom, layer, comment. |
| A real audit trail | Postgres event log + per-tool-call audit row. Pause / resume / cancel any run. |

## What this is not

Not a fork of tldraw. This repo depends on `tldraw@5.x` from npm. The tldraw SDK does the canvas + multiplayer; this repo adds the agent orchestration layer, the connector framework, and the canvas app on top.

Not a hosted product. The deploy at `agent-canvas-ivory.vercel.app` is BYOK — you supply your own Claude key per session.

## Repo layout

```
agent-canvas/
├── apps/
│   ├── canvas/                          ← Vite + React + tldraw, the operator UI
│   └── orchestrator/                    ← Vercel Functions, the agent runtime
├── packages/
│   ├── orchestrator-types/              ← shared types (no runtime)
│   └── connector-core/                  ← connector interface + framework
└── docs/
    ├── operator-guide.md                ← five-minute tutorial with screenshots
    └── designs/agent-canvas.md          ← architecture decisions (read once)
```

## Requirements

- Node `22.x`
- A Claude API key from <https://console.anthropic.com/settings/keys>
- Optional: E2B API key from <https://e2b.dev> for computer-use
- Optional: GitHub OAuth app for sign-in (sample app deploy uses a shared one)

## Local development

```bash
git clone https://github.com/asigdel29/agent-canvas
cd agent-canvas
npm install
cp apps/orchestrator/.env.example apps/orchestrator/.env.local
# edit .env.local — at minimum JWT_SECRET, SSE_TOKEN_SECRET, AUTH_STATE_SECRET
npm run dev --workspace=@agent-canvas/orchestrator   # :3000
npm run dev --workspace=@agent-canvas/canvas         # :5173
```

Open <http://localhost:5173> and sign in. The orchestrator's `/dev/mint-session` route gives you a quick session for testing without the full GitHub OAuth dance.

## Validation

```bash
npm run typecheck       # tsc -b across all packages
npm test                # vitest run, 430 tests
npm run build           # all packages
```

## Stack

- [Claude](https://anthropic.com) — the brain. Sonnet 4.6 default, Opus 4.7 + Haiku 4.5 selectable per agent.
- [tldraw](https://tldraw.dev) — the canvas + multiplayer.
- [E2B Desktop](https://e2b.dev) — sandboxed Linux for computer-use.
- [Playwright](https://playwright.dev) — headless Chromium for browser-use.
- [MCP](https://modelcontextprotocol.io) — the Model Context Protocol for tool servers.
- [Vercel](https://vercel.com) — Functions + static hosting.
- [Postgres](https://www.postgresql.org) (via [Neon](https://neon.tech)) — event log + agent persistence.
- [Upstash Redis](https://upstash.com) — distributed SSE nonce store.

## License

MIT
