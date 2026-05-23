# agent-canvas

Multiplayer infinite-canvas platform for running cloud AI agents. Built on the tldraw SDK.

Status: **Phase 0 / Phase 1 scaffolding.** The product is in early implementation; the architecture is locked across three plan reviews (CEO + Design + Eng + outside voices).

## What this is

An infinite spatial workspace where humans and many long-running cloud AI agents share one canvas. Agents appear as event-graph nodes; their tool calls, progress, and approval requests render as connected child nodes. Teammates can watch and steer in real time. Connectors plug into GitHub, Linear, Slack, Discord, Graphite, Railway, Vercel, and Supabase.

## What this is not

Not a fork of tldraw. This repo depends on `@tldraw/tldraw` and `@tldraw/sync` from npm. The tldraw SDK does the canvas + multiplayer; this repo adds the agent orchestration layer + connector framework + the canvas app on top.

## Repo layout

```
agent-canvas/
├── docs/
│   ├── designs/agent-canvas.md          ← the design doc (start here)
│   └── phase-0/                          ← prototypes and research
├── packages/
│   ├── orchestrator-types/               ← zero-runtime domain types
│   └── connector-core/                   ← connector interface + framework
└── apps/
    └── orchestrator/                     ← the Vercel-deployed backend
```

## Design source of truth

`docs/designs/agent-canvas.md` captures every locked decision from the plan reviews. Implementation must reflect it; if you disagree with a decision, revise the design doc first.

## Development

Requires Node 22+.

```bash
npm install
npm run typecheck      # all packages
npm test               # all tests, watch mode off
npm run build          # build all packages
```

## License

MIT (TBD — confirm before public release).
