# connectors

Each directory below is a single adapter that implements `Connector`
(third-party tool) or `ProviderAdapter` (managed agent vendor) from
`@agent-canvas/connector-core`. Every adapter passes the conformance
suite and lives behind one strict interface.

## Phase 1 (initial)

- `github/` — GitHub App installation tokens, PRs, issues, comments, commits
- `linear/` — issues, projects, comments
- `slack/` — messages, threads, channel triggers
- `codex/` (provider) — OpenAI Codex managed agent

## Phase 1 (follow-up adapters)

- `discord/` — server channels, threads
- `graphite/` — stacked PRs, reviews
- `railway/` — deployments, environment management
- `vercel/` — deployments, project management (NOT the platform we run on; this is
  Vercel-as-an-integration the agent calls out to)
- `supabase/` — database queries, function invocations, project management
- `openhands/` (provider) — OpenHands cloud managed agent

## Pattern

Each adapter directory looks like:

```
github/
  package.json (private, workspace)
  src/
    connector.ts        ← exports GitHubConnector implementing Connector
    oauth.ts             ← OAuth flow (GitHub App installation flow)
    webhooks.ts          ← signature + idempotency derivation
    tools/               ← one file per tool (create_pr, write_file, etc.)
    triggers/
    sinks/
  test/
    conformance.test.ts ← imports runConnectorConformance from connector-core
    [per-tool unit tests]
```

Adapter implementation work belongs in follow-up PRs (each needs the
provider's OAuth app + webhook secrets configured in Vercel + a real
test account).
