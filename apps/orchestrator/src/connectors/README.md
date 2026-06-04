# connectors

Each directory below is a single adapter that implements `Connector`
(third-party tool) or `ProviderAdapter` (managed agent vendor) from
`@agent-canvas/connector-core`. Every adapter passes the conformance
suite and lives behind one strict interface.

## Adapters

- `github/` — GitHub App installation tokens, PRs, issues, comments, commits
- `mockProvider.ts` — in-process provider for local smoke testing; registered
  only when `ENABLE_MOCK_PROVIDER=true`

The framework helpers shared by every adapter:

- `_oauth.ts` — OAuth authorize / callback / refresh / revoke scaffolding
- `_crypto.ts` — signature and state-token primitives
- `_stubs.ts` — typed stubs an adapter overrides as it is implemented

> This self-host build ships the GitHub connector only. Additional
> connectors (Linear, Slack, Discord, etc.) were removed to keep the
> deployment lightweight; add a new directory following the pattern
> below to wire another provider.

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

Each new adapter needs the provider's OAuth app + webhook secret
configured in the environment plus a real test account.
