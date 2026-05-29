# @agent-canvas/orchestrator

Backend orchestrator for agent-canvas. Deployed on Vercel Functions.

## Routes

```
GET    /api/health
POST   /api/commands
POST   /api/webhooks/ingest/:provider
GET    /api/oauth/:provider/start
GET    /api/oauth/:provider/callback
```

`:provider` is one of the registered connector or vendor ids:
`github`, `linear`, `slack`, `discord`, `graphite`, `railway`, `vercel`,
`supabase`, `codex`, `openhands`.

## Local development

```bash
# from repo root
npm install
npm run typecheck
npm test

# run the test suite for this app only
npm test --workspace=@agent-canvas/orchestrator
```

Without `DATABASE_URL` set, the runtime falls back to the in-memory
implementations — all state is lost on cold start. Suitable for tests
and local smoke checks; never for production.

## Deployment

1. Provision a Postgres database (Neon via the Vercel Marketplace is
   the default; any Postgres works). Set `DATABASE_URL` and
   `DATABASE_URL_SESSION` in the Vercel project's environment.
2. Provision an AWS KMS customer-managed key. Set `KMS_KEY_ID` and
   ensure the Vercel function has IAM permission to use it (via OIDC
   federation, or AWS access-key env vars).
3. Configure webhook secrets per provider in the Vercel project's
   environment (see `.env.example` for the full list).
4. Run migrations once:
   ```bash
   node --import tsx apps/orchestrator/src/postgres/migrate.ts
   ```
   (Vercel's build hook is the natural place to invoke this in CI.)
5. Deploy:
   ```bash
   vercel deploy --prod
   ```
   (or push to the linked branch).

## Architecture

See `docs/designs/agent-canvas.md` in the repo root for the locked
decisions across CEO + Design + Eng reviews. The orchestrator's
runtime is in `src/runtime.ts`; that's the wiring point if you need to
swap a Postgres adapter for a different backend.
