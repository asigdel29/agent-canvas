# AGENTS.md

Operating guide for AI agents and new contributors working in this repo. Read
this first; [`README.md`](README.md) has the product and deploy details.

## Layout

npm workspaces monorepo (Node >= 22, TypeScript, ESM):

- `apps/canvas` — React/Vite SPA. Custom infinite canvas in `src/canvas/`.
- `apps/orchestrator` — Node backend. One file per route under `handlers/`,
  business logic under `src/`. Handlers import compiled code from `dist/`, so
  the orchestrator must be built before its handlers run.
- `packages/orchestrator-types`, `packages/connector-core`, `packages/sdk-js`.

See the project map in [`README.md`](README.md#project-map).

## Commands (run from the repo root)

| Task | Command |
| --- | --- |
| Install + bootstrap | `./scripts/setup.sh` |
| Dev (canvas + orchestrator) | `npm run dev` |
| Build all | `npm run build` |
| Typecheck all | `npm run typecheck` |
| Unit/integration tests | `npm test` |
| Canvas end-to-end | `npm run e2e --workspace=@agent-canvas/canvas` |
| Apply DB migrations | `npm run migrate` |

Before pushing, ensure `npm run typecheck`, `npm test`, and `npm run build` pass.

## Conventions

- **Docs comments are required.** Every file, exported type, class, and function
  carries a `/** … */` comment whose first sentence summarizes it; document
  params, returns, thrown errors, invariants, and non-obvious decisions. Tag
  `@author asigdel29`. Match the surrounding house style.
- **Tabs** for indentation; Prettier config in [`.prettierrc.json`](.prettierrc.json)
  (`npm run format`).
- **No dead code.** `tsc -b` runs with `noUnusedLocals`; also check with
  `npx ts-prune` / `npx knip` and remove confirmed-unused exports/files.
- **TypeScript is strict** (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`). Import types with `import type`; never pass `undefined`
  where a key should be omitted.
- Add new orchestrator routes as a file under `handlers/` and register them in
  `handlers/_router.ts`. Add DB changes as the next numbered migration in
  `apps/orchestrator/src/postgres/migrations/`.

## Security rules (do not regress)

- Never return raw exception text or a stack trace to a client; log it
  server-side (`src/observability/logger.ts`) and return a stable error code.
- Validate every user-supplied URL the server will fetch against the SSRF guards
  (`src/webhooks/validateWebhookUrl.ts`, `src/agents/modelBaseUrl.ts`).
- Secrets live only in the gitignored `./.env`. BYOK model keys live in browser
  memory only — never in Web Storage, never in the database.
- Keep the auth flow's protections intact: state-JWT CSRF, open-redirect checks,
  identity-only GitHub usage, single-use short-TTL SSE tokens.

## The custom canvas

`apps/canvas/src/canvas/` replaces a third-party canvas engine:

- `agentShape.ts` — the engine-agnostic shape model.
- `canvasStore.ts` — shape store + the `getShape/createShape/updateShape` editor
  shim the app drives, plus localStorage position persistence.
- `InfiniteCanvas.tsx` — camera, pan/zoom, drag, multi-select, snapping, density.
- `AgentCard.tsx` — the agent card markup.

The app talks to the canvas only through the editor shim and the controller
returned by `onMount`; keep that boundary when extending it.
